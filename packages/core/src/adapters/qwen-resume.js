import fs from "node:fs/promises";
import { QwenCodeAdapter as BaseQwenCodeAdapter } from "./qwen.js";
import { attachmentContent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const KNOWN_QWEN_CONTENT_TYPES = new Set([
  "text",
  "tool-call",
  "tool-result",
  "reasoning",
  "attachment",
  "qwen-executable-code",
  "qwen-code-execution-result",
  "qwen-video-metadata"
]);

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8");
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function activeRecords(records, leafUuid) {
  if (!leafUuid) return records;
  const byUuid = new Map();
  for (const record of records) {
    if (typeof record?.uuid === "string" && record.uuid && !byUuid.has(record.uuid)) byUuid.set(record.uuid, record);
  }
  if (!byUuid.has(leafUuid)) return records;
  const output = [];
  const seen = new Set();
  let current = leafUuid;
  while (current && byUuid.has(current) && !seen.has(current)) {
    seen.add(current);
    const record = byUuid.get(current);
    output.push(record);
    current = typeof record?.parentUuid === "string" ? record.parentUuid : null;
  }
  output.reverse();
  return output;
}

function responseIsError(response) {
  if (!response || typeof response !== "object") return false;
  return Boolean(response.error ?? response.isError ?? response.is_error);
}

function mediaMetadata(part, qwenPartType) {
  return {
    qwenPartType,
    ...(part?.videoMetadata && typeof part.videoMetadata === "object" ? { videoMetadata: part.videoMetadata } : {})
  };
}

function partsToPortable(parts, mode) {
  const output = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      if (part.thought === true) {
        if (mode === "lossless") output.push(reasoningContent({ provider: "qwen-code", text: part.text, signature: part.thoughtSignature ?? part.thought_signature ?? null, raw: part }));
      } else output.push(textContent(part.text));
      continue;
    }
    if (part.functionCall && typeof part.functionCall === "object") {
      const call = part.functionCall;
      output.push(toolCallContent({ id: call.id ?? part.id ?? null, name: call.name ?? "unknown", input: call.args ?? call.arguments ?? null }));
      continue;
    }
    if (part.functionResponse && typeof part.functionResponse === "object") {
      const response = part.functionResponse;
      output.push(toolResultContent({ callId: response.id ?? part.id ?? null, output: response.response ?? response.output ?? response, isError: responseIsError(response.response ?? response) }));
      continue;
    }
    if (part.inlineData && typeof part.inlineData === "object" && typeof part.inlineData.data === "string") {
      output.push(attachmentContent({ mimeType: part.inlineData.mimeType ?? part.inlineData.mime_type ?? "application/octet-stream", data: part.inlineData.data, encoding: "base64", metadata: mediaMetadata(part, "inlineData") }));
      continue;
    }
    if (part.fileData && typeof part.fileData === "object" && typeof part.fileData.fileUri === "string") {
      output.push(attachmentContent({ mimeType: part.fileData.mimeType ?? part.fileData.mime_type ?? "application/octet-stream", uri: part.fileData.fileUri, metadata: mediaMetadata(part, "fileData") }));
      continue;
    }
    if (part.executableCode !== undefined) {
      if (mode === "lossless") output.push({ type: "qwen-executable-code", provider: "qwen-code", executableCode: part.executableCode, raw: part });
      continue;
    }
    if (part.codeExecutionResult !== undefined) {
      if (mode === "lossless") output.push({ type: "qwen-code-execution-result", provider: "qwen-code", codeExecutionResult: part.codeExecutionResult, raw: part });
      continue;
    }
    if (part.videoMetadata !== undefined) {
      if (mode === "lossless") output.push({ type: "qwen-video-metadata", provider: "qwen-code", videoMetadata: part.videoMetadata, raw: part });
      continue;
    }
    if (mode === "lossless") output.push({ type: "qwen-unknown", provider: "qwen-code", raw: part });
  }
  return output;
}

function roleForContent(content) {
  if (content?.role === "model" || content?.role === "assistant") return "assistant";
  if (content?.role === "user") return "user";
  return "system";
}

function bootstrapMessages(history, mode, agentId, bootstrapUuid) {
  return (Array.isArray(history) ? history : []).map((content, index) => {
    const portable = partsToPortable(content?.parts, mode);
    if (!portable.length) return null;
    return {
      id: `qwen-fork-bootstrap:${agentId}:${index}`,
      parentId: null,
      role: roleForContent(content),
      createdAt: null,
      content: portable,
      metadata: { qwenForkBootstrap: true, sourceRecordUuid: bootstrapUuid ?? null }
    };
  }).filter(Boolean);
}

async function enhanceForkAgent(agent, mode) {
  if (!agent?.source?.path) return agent;
  let records;
  try { records = await readJsonl(agent.source.path); } catch { return agent; }
  const chain = activeRecords(records, agent?.metadata?.activeLeafUuid ?? null);
  const bootstrap = chain.find((record) => record?.type === "system" && record?.subtype === "agent_bootstrap" && record?.systemPayload?.kind === "fork" && Array.isArray(record.systemPayload.history));
  const launch = chain.find((record) => record?.type === "system" && record?.subtype === "agent_launch_prompt" && typeof record?.systemPayload?.displayText === "string");
  if (!bootstrap || !launch) return agent;

  const firstNonSystem = chain.find((record) => record?.type !== "system") ?? null;
  const launchSeedUuid = firstNonSystem?.type === "user" ? firstNonSystem.uuid ?? null : null;
  const inherited = bootstrapMessages(bootstrap.systemPayload.history, mode, agent.id, bootstrap.uuid);
  const launchMessage = {
    id: `qwen-fork-launch:${agent.id}`,
    parentId: null,
    role: "user",
    createdAt: launch.timestamp ?? null,
    content: [textContent(launch.systemPayload.displayText)],
    metadata: { qwenForkLaunchPrompt: true, sourceRecordUuid: launch.uuid ?? null }
  };
  const runtime = (agent.messages ?? []).filter((message) => !launchSeedUuid || message?.id !== launchSeedUuid);

  return {
    ...agent,
    messages: [...inherited, launchMessage, ...runtime],
    metadata: {
      ...(agent.metadata ?? {}),
      qwenForkBootstrap: {
        enabled: true,
        bootstrapRecordUuid: bootstrap.uuid ?? null,
        launchPromptRecordUuid: launch.uuid ?? null,
        inheritedMessageCount: inherited.length,
        removedLaunchSeedUuid: launchSeedUuid,
        hasLegacySystemInstruction: bootstrap.systemPayload.systemInstruction !== undefined,
        hasLegacyTools: Array.isArray(bootstrap.systemPayload.tools) && bootstrap.systemPayload.tools.length > 0
      }
    }
  };
}

function recomputeLosslessFlags(session) {
  if (!session?.lossless?.enabled) return session;
  const content = [
    ...(session.messages ?? []),
    ...(session.agents ?? []).flatMap((agent) => agent.messages ?? [])
  ].flatMap((message) => message?.content ?? []);
  session.lossless.includesProviderReasoning = content.some((part) => part?.type === "reasoning");
  session.lossless.includesUnknownContent = content.some((part) => !KNOWN_QWEN_CONTENT_TYPES.has(part?.type));
  return session;
}

export class QwenCodeAdapter extends BaseQwenCodeAdapter {
  async readSession(sessionRef, options = {}) {
    const session = await super.readSession(sessionRef, options);
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const agents = [];
    for (const agent of session.agents ?? []) agents.push(await enhanceForkAgent(agent, mode));
    session.agents = agents;
    const forkCount = agents.filter((agent) => agent?.metadata?.qwenForkBootstrap?.enabled).length;
    session.metadata = { ...(session.metadata ?? {}), qwenForkBootstrapAgentCount: forkCount };
    return recomputeLosslessFlags(session);
  }
}
