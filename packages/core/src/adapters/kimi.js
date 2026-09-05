import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { attachmentContent, createPortableAgent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const KNOWN_CONTENT_TYPES = new Set(["text", "think", "image_url", "audio_url", "video_url"]);
const KNOWN_REPLAY_RECORDS = new Set([
  "metadata",
  "context.append_message",
  "context.append_loop_event",
  "context.apply_compaction",
  "context.undo",
  "context.clear",
  "context.update_token_count",
  "full_compaction.begin",
  "full_compaction.cancel",
  "goal.create",
  "goal.update",
  "plan_mode.enter",
  "plan_mode.cancel",
  "plan_mode.exit",
  "config.update",
  "profile.bind",
  "permission.set_mode",
  "permission.record_approval_result",
  "tools.update_store",
  "tools.set_active_tools",
  "usage.record",
  "turn.begin",
  "turn.end",
  "turn.error",
  "llm.request",
  "llm.response",
  "llm.tools_snapshot",
  "task.started",
  "task.terminated",
  "skill.activate",
  "interaction.begin",
  "interaction.end",
  "token_counting.update"
]);

function defaultKimiHome(options = {}) {
  const env = options.env ?? process.env;
  return path.resolve(options.kimiHome ?? env.KIMI_CODE_HOME ?? path.join(options.userHome ?? os.homedir(), ".kimi-code"));
}

function iso(value) {
  if (value == null) return null;
  const numeric = typeof value === "number" ? value : Number.NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function jsonInput(value) {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function urlAttachment(part, agentDir) {
  const field = part?.type === "image_url" ? part.imageUrl : part?.type === "audio_url" ? part.audioUrl : part?.type === "video_url" ? part.videoUrl : null;
  const uri = field?.url;
  if (typeof uri !== "string") return null;
  const blob = uri.match(/^blobref:([^;]+);(.+)$/);
  if (blob) {
    return attachmentContent({
      mimeType: blob[1] || "application/octet-stream",
      path: path.join(agentDir, "blobs", blob[2]),
      metadata: { kimiContentType: part.type, blobRef: uri, mediaId: field?.id ?? null }
    });
  }
  const defaultMime = part.type === "image_url" ? "image/*" : part.type === "audio_url" ? "audio/*" : "video/*";
  return attachmentContent({ mimeType: defaultMime, uri, metadata: { kimiContentType: part.type, mediaId: field?.id ?? null } });
}

function contentParts(parts, mode, agentDir) {
  const output = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") output.push(textContent(part.text));
    else if (part.type === "think") {
      if (mode === "lossless") output.push(reasoningContent({ provider: "kimi-code", text: typeof part.think === "string" ? part.think : null, encrypted: part.encrypted ?? null, raw: part }));
    } else if (["image_url", "audio_url", "video_url"].includes(part.type)) {
      const attachment = urlAttachment(part, agentDir);
      if (attachment) output.push(attachment);
    } else if (mode === "lossless") output.push({ type: "kimi-unknown", provider: "kimi-code", raw: part });
  }
  return output;
}

function portableMessage(message, mode, agentDir, input = {}) {
  if (!message || typeof message !== "object") return null;
  const content = contentParts(message.content, mode, agentDir);
  for (const call of message.toolCalls ?? []) {
    if (!call || typeof call !== "object") continue;
    content.push(toolCallContent({ id: call.id ?? null, name: call.name ?? "unknown", input: jsonInput(call.arguments) }));
  }
  if (message.role === "tool") {
    const visible = content.filter((part) => part.type !== "tool-call");
    const output = visible.length === 1 && visible[0]?.type === "text" ? visible[0].text : visible;
    return {
      id: input.id ?? null,
      parentId: null,
      role: "tool",
      createdAt: iso(input.time),
      content: [toolResultContent({ callId: message.toolCallId ?? null, output, isError: Boolean(message.isError) }), ...visible.filter((part) => part.type === "attachment")],
      metadata: { kimiOrigin: message.origin ?? null, note: message.note ?? null, partial: Boolean(message.partial) }
    };
  }
  if (!content.length) {
    if (message.tools?.length && mode === "lossless") {
      return { id: input.id ?? null, parentId: null, role: "system", createdAt: iso(input.time), content: [{ type: "kimi-tool-declaration", provider: "kimi-code", tools: message.tools }], metadata: { kimiOrigin: message.origin ?? null } };
    }
    return null;
  }
  const role = ["system", "user", "assistant"].includes(message.role) ? message.role : "system";
  return {
    id: input.id ?? null,
    parentId: null,
    role,
    createdAt: iso(input.time),
    content,
    metadata: { kimiOrigin: message.origin ?? null, name: message.name ?? null, partial: Boolean(message.partial) }
  };
}

function createInterruptedToolResult(callId, time) {
  return {
    id: `kimi:interrupted:${callId}`,
    parentId: null,
    role: "tool",
    createdAt: iso(time),
    content: [toolResultContent({
      callId,
      output: "Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.",
      isError: true
    })],
    metadata: { kimiSyntheticInterruptedResult: true }
  };
}

function isRealUserMessage(message) {
  if (message?.role !== "user") return false;
  const kind = message?.metadata?.kimiOrigin?.kind;
  return !["injection", "system_trigger", "compaction_summary", "hook_result", "cron_job", "cron_missed"].includes(kind);
}

function applyUndo(messages, count) {
  let removed = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const origin = message?.metadata?.kimiOrigin?.kind;
    if (origin === "injection") continue;
    if (origin === "compaction_summary") break;
    messages.splice(index, 1);
    if (isRealUserMessage(message)) {
      removed += 1;
      if (removed >= count) break;
    }
  }
}

function reduceCurrentContext(records, mode, agentDir) {
  let messages = [];
  const openSteps = new Map();
  const pendingToolResults = new Set();
  let deferred = [];
  let sequence = 0;
  let compactionApproximation = false;

  const push = (message) => { if (message) messages.push(message); };
  const flushDeferred = () => {
    if (pendingToolResults.size || !deferred.length) return;
    messages.push(...deferred);
    deferred = [];
  };
  const closePending = (time) => {
    if (!pendingToolResults.size) return;
    for (const callId of [...pendingToolResults]) {
      push(createInterruptedToolResult(callId, time));
      pendingToolResults.delete(callId);
    }
    flushDeferred();
  };
  const resetOpen = () => {
    openSteps.clear();
    pendingToolResults.clear();
    deferred = [];
  };

  for (const record of records) {
    const time = record?.time;
    if (record?.type === "context.append_message") {
      const message = portableMessage(record.message, mode, agentDir, { id: `kimi:${sequence++}`, time });
      if (!message) continue;
      if (pendingToolResults.size) deferred.push(message);
      else push(message);
      continue;
    }
    if (record?.type === "context.append_loop_event") {
      const event = record.event ?? {};
      if (event.type === "step.begin") {
        closePending(time);
        const message = { id: `kimi:step:${event.uuid ?? sequence++}`, parentId: null, role: "assistant", createdAt: iso(time), content: [], metadata: { kimiStepUuid: event.uuid ?? null, partial: true } };
        push(message);
        openSteps.set(event.uuid, message);
      } else if (event.type === "content.part") {
        const target = openSteps.get(event.stepUuid);
        if (target) target.content.push(...contentParts([event.part], mode, agentDir));
      } else if (event.type === "tool.call") {
        const target = openSteps.get(event.stepUuid);
        if (target) {
          target.content.push(toolCallContent({ id: event.toolCallId ?? null, name: event.name ?? "unknown", input: event.args ?? null }));
          pendingToolResults.add(event.toolCallId);
        }
      } else if (event.type === "tool.result") {
        const callId = event.toolCallId;
        if (!pendingToolResults.has(callId)) continue;
        const result = event.result ?? {};
        const resultParts = typeof result.output === "string" ? [textContent(result.output)] : contentParts(result.output, mode, agentDir);
        const output = resultParts.length === 1 && resultParts[0]?.type === "text" ? resultParts[0].text : resultParts;
        push({ id: `kimi:tool:${callId}:${sequence++}`, parentId: null, role: "tool", createdAt: iso(time), content: [toolResultContent({ callId, output, isError: Boolean(result.isError) }), ...resultParts.filter((part) => part.type === "attachment")], metadata: { note: result.note ?? null } });
        pendingToolResults.delete(callId);
        flushDeferred();
      } else if (event.type === "step.end") {
        const target = openSteps.get(event.uuid);
        if (target) target.metadata = { ...target.metadata, partial: false, finishReason: event.finishReason ?? event.stopReason ?? null, usage: event.usage ?? null };
        openSteps.delete(event.uuid);
        flushDeferred();
      }
      continue;
    }
    if (record?.type === "context.clear") {
      messages = [];
      resetOpen();
      continue;
    }
    if (record?.type === "context.undo") {
      applyUndo(messages, Number(record.count ?? 0));
      resetOpen();
      continue;
    }
    if (record?.type === "context.apply_compaction") {
      const summary = typeof record.summary === "string" ? record.summary : "";
      messages = summary ? [{ id: `kimi:compaction:${sequence++}`, parentId: null, role: "user", createdAt: iso(time), content: [textContent(summary)], metadata: { kimiOrigin: { kind: "compaction_summary" }, compactedCount: record.compactedCount ?? null, keptUserMessageCount: record.keptUserMessageCount ?? null, tokensBefore: record.tokensBefore ?? null, tokensAfter: record.tokensAfter ?? null } }] : [];
      compactionApproximation = true;
      resetOpen();
    }
  }
  closePending(records.at(-1)?.time);
  messages = messages.filter((message) => message.content?.length);
  return { messages, compactionApproximation };
}

async function readWire(file, mode, provider = "kimi-code") {
  const records = [];
  const events = [];
  let malformedLineCount = 0;
  let rawRecordCount = 0;
  const input = fsSync.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const rawLines = [];
  for await (const raw of lines) rawLines.push(raw);
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index];
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); }
    catch {
      const isLastNonEmpty = rawLines.slice(index + 1).every((line) => !line.trim());
      malformedLineCount += 1;
      if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: isLastNonEmpty ? "torn-tail-json" : "malformed-json", data: { lineNumber: index + 1, raw } }));
      rawRecordCount += 1;
      continue;
    }
    records.push(record);
    if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: `wire:${record?.type ?? "unknown"}`, timestamp: iso(record?.time), data: record }));
    rawRecordCount += 1;
  }
  return { records, events, rawRecordCount, malformedLineCount };
}

async function readState(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

async function findSessionDirs(root) {
  const sessionsRoot = path.join(root, "sessions");
  const dirs = [];
  let buckets;
  try { buckets = await fs.readdir(sessionsRoot, { withFileTypes: true }); } catch { return dirs; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    const bucketDir = path.join(sessionsRoot, bucket.name);
    let sessions;
    try { sessions = await fs.readdir(bucketDir, { withFileTypes: true }); } catch { continue; }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDir = path.join(bucketDir, session.name);
      if (await exists(path.join(sessionDir, "state.json"))) dirs.push(sessionDir);
    }
  }
  return dirs;
}

async function listAgentDirs(sessionDir) {
  const root = path.join(sessionDir, "agents");
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => ({ id: entry.name, dir: path.join(root, entry.name) }));
}

async function companionFiles(sessionDir) {
  const output = [];
  const stack = [{ dir: sessionDir, relative: "" }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      const relative = path.join(current.relative, entry.name);
      if (entry.isDirectory()) stack.push({ dir: absolute, relative });
      else if (entry.isFile() && relative !== "state.json") {
        const lower = entry.name.toLowerCase();
        const mediaType = lower.endsWith(".json") ? "application/json" : lower.endsWith(".jsonl") ? "application/x-ndjson" : lower.endsWith(".md") ? "text/markdown" : lower.endsWith(".log") ? "text/plain" : "application/octet-stream";
        output.push({ path: absolute, filename: relative.replaceAll(path.sep, "/"), mediaType });
      }
    }
  }
  return output;
}

function sessionTitle(state, rootMessages) {
  if (typeof state?.title === "string" && state.title.trim()) return state.title.trim();
  if (typeof state?.lastPrompt === "string" && state.lastPrompt.trim()) return state.lastPrompt.trim().slice(0, 100);
  const first = rootMessages.find((message) => message.role === "user")?.content?.find((part) => part.type === "text")?.text;
  return typeof first === "string" ? first.trim().slice(0, 100) || null : null;
}

function agentName(id, meta) {
  return meta?.labels?.name ?? meta?.labels?.title ?? meta?.type ?? (id === "main" ? "main" : null);
}

export class KimiCodeAdapter {
  constructor(options = {}) {
    this.id = "kimi-code";
    this.name = "Kimi Code";
    this.aliases = ["kimi", "kimi-cli", "kimicode"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["kimi-code/session-dir-v1"];
    this.command = options.command ?? "kimi";
    this.runner = options.runner ?? spawnSync;
    this.kimiHome = defaultKimiHome(options);
  }

  async detect() {
    const sessionsRoot = path.join(this.kimiHome, "sessions");
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const cliInstalled = !result?.error && result?.status === 0;
    return {
      installed: cliInstalled || await exists(sessionsRoot),
      version: cliInstalled ? String(result.stdout || result.stderr || "").trim() || null : null,
      kimiHome: this.kimiHome,
      sessionsRoot,
      storageFormat: "session-dir-state-wire-v1",
      officialExport: "kimi export <sessionId>"
    };
  }

  async listSessions() {
    const output = [];
    for (const sessionDir of await findSessionDirs(this.kimiHome)) {
      const state = await readState(path.join(sessionDir, "state.json"));
      if (!state) continue;
      const id = String(state.id ?? path.basename(sessionDir));
      const mainWire = path.join(sessionDir, "agents", "main", "wire.jsonl");
      let main = { messages: [] };
      if (await exists(mainWire)) {
        const wire = await readWire(mainWire, "portable");
        main = reduceCurrentContext(wire.records, "portable", path.dirname(mainWire));
      }
      const stat = await fs.stat(path.join(sessionDir, "state.json"));
      output.push({
        adapter: this.id,
        id,
        title: sessionTitle(state, main.messages),
        cwd: state.cwd ?? null,
        path: sessionDir,
        createdAt: iso(state.createdAt),
        updatedAt: iso(state.updatedAt) ?? stat.mtime.toISOString(),
        archived: state.archived === true,
        forkedFrom: state.forkedFrom ?? null,
        lastTurnReason: state.lastTurnReason ?? null,
        agentCount: (await listAgentDirs(sessionDir)).length
      });
    }
    return output.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (await exists(ref) && (await fs.stat(ref)).isDirectory() && await exists(path.join(ref, "state.json"))) return path.resolve(ref);
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.id.startsWith(ref) || session.path === ref);
    if (!matches.length) throw new Error(`Kimi Code session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((session) => session.path === ref)) throw new Error(`Kimi Code session id is ambiguous: ${sessionRef}; pass the full session directory`);
    return matches[0].path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const sessionDir = await this.resolveSession(sessionRef);
    const stateFile = path.join(sessionDir, "state.json");
    const state = await readState(stateFile);
    if (!state) throw new Error(`Kimi Code session state is unreadable: ${stateFile}`);
    const agentsMeta = state.agents && typeof state.agents === "object" ? state.agents : {};
    const agentDirs = await listAgentDirs(sessionDir);
    let rootMessages = [];
    const agents = [];
    const rootEvents = [];
    let rootRawCount = 0;
    let malformedLineCount = 0;
    let anyApproximation = false;
    let includesReasoning = false;
    let includesUnknownContent = false;
    let includesUnknownEvents = false;

    for (const entry of agentDirs) {
      const wireFile = path.join(entry.dir, "wire.jsonl");
      if (!await exists(wireFile)) continue;
      const parsed = await readWire(wireFile, mode);
      const semantic = reduceCurrentContext(parsed.records, mode, entry.dir);
      const content = semantic.messages.flatMap((message) => message.content ?? []);
      includesReasoning ||= content.some((part) => part.type === "reasoning");
      includesUnknownContent ||= content.some((part) => part.type === "kimi-unknown" || part.type === "kimi-tool-declaration");
      includesUnknownEvents ||= parsed.records.some((record) => !KNOWN_REPLAY_RECORDS.has(String(record?.type ?? "unknown"))) || parsed.malformedLineCount > 0;
      anyApproximation ||= semantic.compactionApproximation;
      malformedLineCount += parsed.malformedLineCount;
      const meta = agentsMeta[entry.id] ?? {};
      if (entry.id === "main") {
        rootMessages = semantic.messages;
        rootEvents.push(...parsed.events);
        rootRawCount = parsed.rawRecordCount;
      } else {
        agents.push(createPortableAgent({
          id: entry.id,
          parentId: meta.parentAgentId ?? null,
          name: agentName(entry.id, meta),
          kind: meta.type ?? "subagent",
          source: { adapter: this.id, sessionId: entry.id, path: wireFile },
          messages: semantic.messages,
          events: parsed.events,
          metadata: {
            homedir: meta.homedir ?? null,
            forkedFrom: meta.forkedFrom ?? null,
            labels: meta.labels ?? null,
            swarmItem: meta.swarmItem ?? null,
            compactionApproximation: semantic.compactionApproximation
          }
        }));
      }
    }

    return createPortableSession({
      id: String(state.id ?? path.basename(sessionDir)),
      title: sessionTitle(state, rootMessages),
      cwd: state.cwd ?? null,
      startedAt: iso(state.createdAt),
      updatedAt: iso(state.updatedAt),
      source: { adapter: this.id, sessionId: String(state.id ?? path.basename(sessionDir)), path: sessionDir },
      messages: rootMessages,
      agents,
      metadata: {
        stateVersion: state.version ?? null,
        titleKind: state.titleKind ?? null,
        lastPrompt: state.lastPrompt ?? null,
        archived: state.archived === true,
        archivedAt: iso(state.archivedAt),
        forkedFrom: state.forkedFrom ?? null,
        custom: state.custom ?? null,
        lastTurnReason: state.lastTurnReason ?? null,
        compactionApproximation: anyApproximation,
        malformedLineCount
      },
      events: rootEvents,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "kimi-code/session-dir-v1",
        rawRecordCount: rootRawCount + agents.reduce((sum, agent) => sum + (agent.events?.length ?? 0), 0),
        includesProviderReasoning: includesReasoning,
        includesUnknownContent,
        includesUnknownEvents,
        includesSubagents: agents.length > 0,
        preservesProviderStateAndCompanions: true,
        compactionSemanticApproximation: anyApproximation
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const sessionDir = await this.resolveSession(sessionRef);
    const stateFile = path.join(sessionDir, "state.json");
    const state = await readState(stateFile);
    if (!state) throw new Error(`Kimi Code session state is unreadable: ${stateFile}`);
    return {
      kind: "agent-session",
      format: "kimi-code/session-dir-v1",
      formatVersion: state.version ?? 1,
      sourceAdapter: this.id,
      path: stateFile,
      filename: "state.json",
      companions: await companionFiles(sessionDir),
      cwd: state.cwd ?? null,
      sessionId: String(state.id ?? path.basename(sessionDir)),
      sessionDir
    };
  }
}
