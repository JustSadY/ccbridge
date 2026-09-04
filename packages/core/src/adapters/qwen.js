import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { attachmentContent, createPortableAgent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const RECORD_TYPES = new Set(["user", "assistant", "tool_result", "system"]);
const ARTIFACT_SUBTYPES = new Set(["session_artifact_event", "session_artifact_snapshot"]);
const KNOWN_QWEN_CONTENT_TYPES = new Set(["text", "tool-call", "tool-result", "reasoning", "attachment", "qwen-executable-code", "qwen-code-execution-result", "qwen-video-metadata"]);
const exists = (file) => fs.access(file).then(() => true).catch(() => false);

function iso(value) {
  if (value == null) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function splitRoots(value) {
  return String(value ?? "").split(path.delimiter).map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
}

function defaultQwenHome(options = {}) {
  const env = options.env ?? process.env;
  return path.resolve(options.qwenHome ?? env.QWEN_HOME ?? path.join(options.userHome ?? os.homedir(), ".qwen"));
}

function defaultProjectRoots(options = {}) {
  if (Array.isArray(options.sessionRoots) && options.sessionRoots.length) return options.sessionRoots.map((value) => path.resolve(value));
  const env = options.env ?? process.env;
  const bridgeRoots = splitRoots(env.CCBRIDGE_QWEN_SESSION_ROOTS);
  if (bridgeRoots.length) return bridgeRoots;
  const runtimeBase = path.resolve(options.runtimeDir ?? env.QWEN_RUNTIME_DIR ?? defaultQwenHome(options));
  return [path.join(runtimeBase, "projects")];
}

function isSessionJsonl(file) {
  if (!file.endsWith(".jsonl")) return false;
  const parts = path.normalize(file).split(path.sep);
  const chats = parts.lastIndexOf("chats");
  return chats >= 0 && chats < parts.length - 1;
}

async function walkSessionJsonl(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && isSessionJsonl(file)) files.push(file);
    }
  }
  return files;
}

function projectDirForSession(file) {
  let dir = path.dirname(path.resolve(file));
  while (true) {
    if (path.basename(dir) === "chats") return path.dirname(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.dirname(path.resolve(file)));
}

function subagentDir(projectDir, sessionId) {
  return path.join(projectDir, "subagents", String(sessionId));
}

async function listSubagentDirEntries(projectDir, sessionId) {
  try { return await fs.readdir(subagentDir(projectDir, sessionId), { withFileTypes: true }); } catch { return []; }
}

async function countSubagents(projectDir, sessionId) {
  const entries = await listSubagentDirEntries(projectDir, sessionId);
  return entries.filter((entry) => entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")).length;
}

async function nativeSubagentCompanions(projectDir, sessionId) {
  const root = subagentDir(projectDir, sessionId);
  const entries = await listSubagentDirEntries(projectDir, sessionId);
  const companions = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("agent-")) continue;
    if (entry.name.endsWith(".jsonl")) companions.push({ path: path.join(root, entry.name), filename: `subagents/${entry.name}`, mediaType: "application/x-ndjson" });
    else if (entry.name.endsWith(".meta.json")) companions.push({ path: path.join(root, entry.name), filename: `subagents/${entry.name}`, mediaType: "application/json" });
  }
  return companions;
}

function eventKind(record) {
  const type = typeof record?.type === "string" ? record.type : "unknown";
  const subtype = typeof record?.subtype === "string" ? record.subtype : null;
  return subtype ? `record:${type}:${subtype}` : `record:${type}`;
}

async function readPhysicalRecords(file, mode, provider = "qwen-code") {
  const records = [];
  const events = [];
  let rawRecordCount = 0;
  let malformedLineCount = 0;
  const input = fsSync.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    const line = raw.trim();
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); }
    catch {
      malformedLineCount += 1;
      if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: "malformed-json", data: { lineNumber, raw } }));
      rawRecordCount += 1;
      continue;
    }
    records.push(value);
    if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: eventKind(value), timestamp: iso(value?.timestamp), data: value }));
    rawRecordCount += 1;
  }
  return { records, events, rawRecordCount, malformedLineCount };
}

function conversationRecord(record) {
  return Boolean(record && RECORD_TYPES.has(record.type) && !(record.type === "system" && ARTIFACT_SUBTYPES.has(record.subtype)));
}

function aggregateFragments(fragments) {
  const first = fragments[0];
  if (!first) return null;
  const result = { ...first };
  let message = first.message && typeof first.message === "object" ? { ...first.message, parts: [...(Array.isArray(first.message.parts) ? first.message.parts : [])] } : undefined;
  for (const record of fragments.slice(1)) {
    if (record?.message && typeof record.message === "object") {
      const incoming = Array.isArray(record.message.parts) ? record.message.parts : [];
      message = message ? { role: message.role ?? record.message.role, parts: [...(message.parts ?? []), ...incoming] } : { ...record.message, parts: [...incoming] };
    }
    if (record?.usageMetadata) result.usageMetadata = record.usageMetadata;
    if (record?.toolCallResult && !result.toolCallResult) result.toolCallResult = record.toolCallResult;
    if (record?.model && !result.model) result.model = record.model;
    if (record?.timestamp && (!result.timestamp || String(record.timestamp) > String(result.timestamp))) result.timestamp = record.timestamp;
  }
  if (message) result.message = message;
  return result;
}

function activeChain(records) {
  const valid = records.filter((record) => record && typeof record.uuid === "string" && record.uuid && (record.parentUuid === null || typeof record.parentUuid === "string") && typeof record.sessionId === "string" && record.sessionId && RECORD_TYPES.has(record.type));
  const leaf = [...valid].reverse().find(conversationRecord);
  if (!leaf) return { records: [], leafUuid: null, gaps: [], cycleUuid: null, conflictingParents: [] };
  const fragments = new Map();
  const first = new Map();
  const conflictingParents = [];
  for (const record of valid) {
    if (!conversationRecord(record)) continue;
    const group = fragments.get(record.uuid);
    if (group) {
      if (group[0]?.parentUuid !== record.parentUuid) conflictingParents.push(record.uuid);
      group.push(record);
    } else {
      fragments.set(record.uuid, [record]);
      first.set(record.uuid, record);
    }
  }
  const ids = [];
  const gaps = [];
  const seen = new Set();
  let current = leaf.uuid;
  let cycleUuid = null;
  while (current) {
    if (seen.has(current)) { cycleUuid = current; break; }
    seen.add(current);
    const record = first.get(current);
    if (!record) break;
    ids.push(current);
    if (!record.parentUuid) break;
    if (!first.has(record.parentUuid)) { gaps.push({ childUuid: current, missingParentUuid: record.parentUuid }); break; }
    current = record.parentUuid;
  }
  ids.reverse();
  return { records: ids.map((id) => aggregateFragments(fragments.get(id))).filter(Boolean), leafUuid: leaf.uuid, gaps, cycleUuid, conflictingParents: [...new Set(conflictingParents)] };
}

function isHookContextText(text) {
  const value = String(text ?? "").trim();
  return value.startsWith("<qwen:user-prompt-submit-context>") && value.endsWith("</qwen:user-prompt-submit-context>");
}

function projectedUserParts(record) {
  const parts = Array.isArray(record?.message?.parts) ? record.message.parts : [];
  const payload = record?.systemPayload && typeof record.systemPayload === "object" ? record.systemPayload : null;
  const finalPart = parts.at(-1);
  const finalHook = finalPart && typeof finalPart === "object" && typeof finalPart.text === "string" && isHookContextText(finalPart.text);
  if (typeof payload?.displayText === "string" && (typeof payload?.hookContext === "string" || finalHook)) {
    return [{ text: payload.displayText }, ...parts.filter((part) => !(part && typeof part === "object" && typeof part.text === "string"))];
  }
  if (!payload && finalHook) return parts.slice(0, -1);
  return parts;
}

function responseIsError(response) {
  if (!response || typeof response !== "object") return false;
  return Boolean(response.error ?? response.isError ?? response.is_error);
}

function mediaMetadata(part, qwenPartType) {
  return { qwenPartType, ...(part?.videoMetadata && typeof part.videoMetadata === "object" ? { videoMetadata: part.videoMetadata } : {}) };
}

function partsToPortable(parts, mode, provider = "qwen-code") {
  const output = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      if (part.thought === true) {
        if (mode === "lossless") output.push(reasoningContent({ provider, text: part.text, signature: part.thoughtSignature ?? part.thought_signature ?? null, raw: part }));
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
      if (mode === "lossless") output.push({ type: "qwen-executable-code", provider, executableCode: part.executableCode, raw: part });
      continue;
    }
    if (part.codeExecutionResult !== undefined) {
      if (mode === "lossless") output.push({ type: "qwen-code-execution-result", provider, codeExecutionResult: part.codeExecutionResult, raw: part });
      continue;
    }
    if (part.videoMetadata !== undefined) {
      if (mode === "lossless") output.push({ type: "qwen-video-metadata", provider, videoMetadata: part.videoMetadata, raw: part });
      continue;
    }
    if (mode === "lossless") output.push({ type: "qwen-unknown", provider, raw: part });
  }
  return output;
}

function roleForContent(content, fallback = "system") {
  if (content?.role === "model" || content?.role === "assistant") return "assistant";
  if (content?.role === "user") return "user";
  return fallback;
}

function portableMessageFromContent(content, mode, input = {}) {
  const portable = partsToPortable(content?.parts, mode, input.provider ?? "qwen-code");
  if (!portable.length) return null;
  return { id: input.id ?? null, parentId: input.parentId ?? null, role: roleForContent(content, input.role ?? "system"), createdAt: input.createdAt ?? null, content: portable, metadata: input.metadata ?? {} };
}

function toolResultMetadata(record, content) {
  if (record?.type !== "tool_result") return null;
  const result = record.toolCallResult && typeof record.toolCallResult === "object" ? record.toolCallResult : null;
  const explicitCallId = typeof result?.callId === "string" && result.callId ? result.callId : null;
  const topLevelError = Boolean(result?.error);
  for (const part of content) {
    if (part?.type !== "tool-result") continue;
    if (explicitCallId) part.callId = explicitCallId;
    else if (!part.callId) part.callId = record.uuid ?? null;
    if (topLevelError) part.isError = true;
  }
  return result ? {
    callId: explicitCallId,
    displayName: result.displayName ?? null,
    status: result.status ?? null,
    isError: topLevelError
  } : null;
}

function portableMessageFromRecord(record, mode) {
  if (!record || record.type === "system" || record.subtype === "realtime_message") return null;
  const parts = record.type === "user" ? projectedUserParts(record) : record?.message?.parts;
  const content = partsToPortable(parts, mode);
  if (!content.length) return null;
  const qwenToolResult = toolResultMetadata(record, content);
  const role = record.type === "assistant" ? "assistant" : record.type === "tool_result" ? "tool" : "user";
  return {
    id: record.uuid ?? null,
    parentId: record.parentUuid ?? null,
    role,
    createdAt: iso(record.timestamp),
    content,
    metadata: {
      qwenSubtype: record.subtype ?? null,
      model: record.model ?? null,
      usage: record.usageMetadata ?? null,
      agentId: record.agentId ?? null,
      agentName: record.agentName ?? null,
      isSidechain: Boolean(record.isSidechain),
      qwenToolResult
    }
  };
}

function semanticMessages(chain, mode) {
  let messages = [];
  let latestCompression = null;
  for (const record of chain) {
    if (record.type === "system" && record.subtype === "chat_compression" && Array.isArray(record?.systemPayload?.compressedHistory)) {
      latestCompression = record;
      messages = record.systemPayload.compressedHistory.map((content, index) => portableMessageFromContent(content, mode, { id: `compression:${record.uuid}:${index}`, createdAt: iso(record.timestamp), metadata: { qwenCompression: true, sourceRecordUuid: record.uuid } })).filter(Boolean);
      continue;
    }
    const message = portableMessageFromRecord(record, mode);
    if (!message) continue;
    if (record.subtype === "mid_turn_user_message" && message.role === "user" && messages.at(-1)?.role === "user") {
      messages.at(-1).content.push(...message.content);
      continue;
    }
    messages.push(message);
  }
  return { messages, latestCompression };
}

function titleFrom(records, semantic) {
  const custom = [...records].reverse().find((record) => record?.type === "system" && record?.subtype === "custom_title" && typeof record?.systemPayload?.customTitle === "string");
  if (custom) return custom.systemPayload.customTitle;
  const firstUser = semantic.messages.find((message) => message.role === "user");
  const text = firstUser?.content?.find((part) => part.type === "text")?.text;
  return typeof text === "string" ? text.trim().slice(0, 100) || null : null;
}

function latestSystemPayload(records, subtype) {
  return [...records].reverse().find((record) => record?.type === "system" && record?.subtype === subtype)?.systemPayload ?? null;
}

async function readAgentMeta(metaFile) {
  try { return JSON.parse(await fs.readFile(metaFile, "utf8")); } catch { return null; }
}

async function parseTranscript(file, mode, provider = "qwen-code") {
  const physical = await readPhysicalRecords(file, mode, provider);
  const chain = activeChain(physical.records);
  const semantic = semanticMessages(chain.records, mode);
  return { ...physical, chain, semantic };
}

async function readSubagents(projectDir, sessionId, mode) {
  const root = subagentDir(projectDir, sessionId);
  const entries = await listSubagentDirEntries(projectDir, sessionId);
  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("agent-") || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(root, entry.name);
    const agentIdFromName = entry.name.slice("agent-".length, -".jsonl".length);
    const meta = await readAgentMeta(path.join(root, `agent-${agentIdFromName}.meta.json`));
    const parsed = await parseTranscript(file, mode, "qwen-code");
    const first = parsed.chain.records[0] ?? parsed.records[0] ?? {};
    const last = parsed.chain.records.at(-1) ?? parsed.records.at(-1) ?? {};
    const recordAgentId = parsed.records.find((record) => typeof record?.agentId === "string")?.agentId;
    const agentId = String(meta?.agentId ?? recordAgentId ?? agentIdFromName);
    agents.push(createPortableAgent({
      id: agentId,
      parentId: meta?.parentAgentId ?? null,
      name: meta?.agentType ?? parsed.records.find((record) => typeof record?.agentName === "string")?.agentName ?? null,
      kind: "subagent",
      startedAt: iso(meta?.createdAt ?? first?.timestamp),
      updatedAt: iso(meta?.lastUpdatedAt ?? last?.timestamp),
      source: { adapter: "qwen-code", sessionId: agentId, path: file },
      messages: parsed.semantic.messages,
      events: parsed.events,
      metadata: {
        description: meta?.description ?? null,
        parentSessionId: meta?.parentSessionId ?? sessionId,
        toolUseId: meta?.toolUseId ?? null,
        status: meta?.status ?? null,
        depth: meta?.depth ?? null,
        model: meta?.model ?? null,
        activeLeafUuid: parsed.chain.leafUuid,
        latestCompressionUuid: parsed.semantic.latestCompression?.uuid ?? null,
        historyGaps: parsed.chain.gaps,
        parentCycleUuid: parsed.chain.cycleUuid
      }
    }));
  }
  return agents;
}

export class QwenCodeAdapter {
  constructor(options = {}) {
    this.id = "qwen-code";
    this.name = "Qwen Code";
    this.aliases = ["qwen", "qwencode"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["qwen-code/session-jsonl"];
    this.command = options.command ?? "qwen";
    this.runner = options.runner ?? spawnSync;
    this.qwenHome = defaultQwenHome(options);
    this.sessionRoots = defaultProjectRoots(options);
  }

  async detect() {
    const existingRoots = [];
    for (const root of this.sessionRoots) if (await exists(root)) existingRoots.push(root);
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const cliInstalled = !result?.error && result?.status === 0;
    return {
      installed: cliInstalled || existingRoots.length > 0,
      version: cliInstalled ? String(result.stdout || result.stderr || "").trim() || null : null,
      qwenHome: this.qwenHome,
      sessionRoots: this.sessionRoots,
      existingRoots,
      storageFormat: "project-chat-jsonl-tree"
    };
  }

  async listSessions() {
    const files = [];
    for (const root of this.sessionRoots) files.push(...await walkSessionJsonl(root));
    const sessions = [];
    for (const file of files) {
      try {
        const parsed = await parseTranscript(file, "portable");
        const first = parsed.chain.records[0] ?? parsed.records[0];
        if (!first?.sessionId) continue;
        const stat = await fs.stat(file);
        const projectDir = projectDirForSession(file);
        const sessionId = String(first.sessionId ?? path.basename(file, ".jsonl"));
        sessions.push({
          adapter: this.id,
          id: sessionId,
          title: titleFrom(parsed.chain.records, parsed.semantic),
          cwd: first.cwd ?? null,
          path: file,
          createdAt: iso(first.timestamp),
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
          version: first.version ?? null,
          gitBranch: first.gitBranch ?? null,
          activeLeafUuid: parsed.chain.leafUuid,
          activeRecordCount: parsed.chain.records.length,
          totalRecordCount: parsed.records.length,
          subagentCount: await countSubagents(projectDir, sessionId),
          archived: path.basename(path.dirname(file)) === "archive"
        });
      } catch {}
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await exists(ref)) return path.resolve(ref);
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.id.startsWith(ref) || session.path === ref);
    if (!matches.length) throw new Error(`Qwen Code session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((session) => session.path === ref)) throw new Error(`Qwen Code session id is ambiguous: ${sessionRef}; pass the full JSONL path`);
    return matches[0].path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseTranscript(file, mode);
    const first = parsed.chain.records[0] ?? parsed.records[0];
    if (!first?.sessionId) throw new Error(`Qwen Code transcript is missing a valid session id: ${file}`);
    const stat = await fs.stat(file);
    const projectDir = projectDirForSession(file);
    const agents = await readSubagents(projectDir, first.sessionId, mode);
    const allContent = [...parsed.semantic.messages, ...agents.flatMap((agent) => agent.messages ?? [])].flatMap((message) => message.content ?? []);
    const parentSession = latestSystemPayload(parsed.chain.records, "parent_session");
    const sourceInfo = latestSystemPayload(parsed.chain.records, "session_source");
    const sessionModel = latestSystemPayload(parsed.chain.records, "session_model");
    return createPortableSession({
      id: String(first.sessionId),
      title: titleFrom(parsed.chain.records, parsed.semantic),
      cwd: first.cwd ?? null,
      startedAt: iso(first.timestamp),
      updatedAt: stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: String(first.sessionId), path: file },
      messages: parsed.semantic.messages,
      agents,
      metadata: {
        cliVersion: first.version ?? null,
        gitBranch: first.gitBranch ?? null,
        activeLeafUuid: parsed.chain.leafUuid,
        activeRecordCount: parsed.chain.records.length,
        totalRecordCount: parsed.records.length,
        malformedLineCount: parsed.malformedLineCount,
        historyGaps: parsed.chain.gaps,
        parentCycleUuid: parsed.chain.cycleUuid,
        conflictingParentUuids: parsed.chain.conflictingParents,
        latestCompression: parsed.semantic.latestCompression ? { uuid: parsed.semantic.latestCompression.uuid, timestamp: iso(parsed.semantic.latestCompression.timestamp), info: parsed.semantic.latestCompression.systemPayload?.info ?? null } : null,
        parentSession,
        sessionSource: sourceInfo,
        sessionModel,
        projectDir,
        archived: path.basename(path.dirname(file)) === "archive"
      },
      events: parsed.events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "qwen-code/session-jsonl",
        rawRecordCount: parsed.rawRecordCount + agents.reduce((sum, agent) => sum + (agent.events?.length ?? 0), 0),
        rootRawRecordCount: parsed.rawRecordCount,
        includesProviderReasoning: allContent.some((part) => part.type === "reasoning"),
        includesUnknownContent: allContent.some((part) => !KNOWN_QWEN_CONTENT_TYPES.has(part?.type)),
        includesUnknownEvents: true,
        includesSubagents: agents.length > 0,
        preservesInactiveBranchesAsRawEvents: parsed.records.length > parsed.chain.records.length
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseTranscript(file, "portable");
    const first = parsed.chain.records[0] ?? parsed.records[0];
    if (!first?.sessionId) throw new Error(`Qwen Code transcript is missing a valid session id: ${file}`);
    const projectDir = projectDirForSession(file);
    const sessionId = String(first.sessionId);
    return {
      kind: "agent-session",
      format: "qwen-code/session-jsonl",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: file,
      filename: path.basename(file),
      companions: await nativeSubagentCompanions(projectDir, sessionId),
      cwd: first.cwd ?? null,
      sessionId,
      projectDir
    };
  }
}
