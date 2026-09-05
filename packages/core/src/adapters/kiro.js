import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { attachmentContent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const KNOWN_EVENT_KINDS = new Set(["Prompt", "AssistantMessage", "ToolResults", "ToolUse", "Clear"]);
const KNOWN_BLOCK_KINDS = new Set(["text", "thinking", "toolUse", "toolResult", "image"]);
const exists = (file) => fs.access(file).then(() => true).catch(() => false);

function iso(value) {
  if (value == null) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultKiroHome(options = {}) {
  const env = options.env ?? process.env;
  return path.resolve(options.kiroHome ?? env.KIRO_HOME ?? path.join(options.userHome ?? os.homedir(), ".kiro"));
}

function defaultSessionRoots(options = {}) {
  if (Array.isArray(options.sessionRoots) && options.sessionRoots.length) return options.sessionRoots.map((value) => path.resolve(value));
  const env = options.env ?? process.env;
  const bridgeRoots = String(env.CCBRIDGE_KIRO_SESSION_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  if (bridgeRoots.length) return bridgeRoots.map((value) => path.resolve(value));
  return [path.join(defaultKiroHome(options), "sessions", "cli")];
}

function sidecar(file, extension) {
  return path.join(path.dirname(file), `${path.basename(file, ".jsonl")}${extension}`);
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}

function textFrom(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  for (const key of ["text", "content", "message", "value"]) if (typeof value[key] === "string") return value[key];
  return null;
}

function imageAttachment(block) {
  const data = block?.data && typeof block.data === "object" ? block.data : block;
  const source = data?.source && typeof data.source === "object" ? data.source : null;
  const bytes = typeof data?.data === "string" ? data.data : typeof source?.data === "string" ? source.data : null;
  const mimeType = data?.mimeType ?? data?.mediaType ?? data?.mime_type ?? source?.mediaType ?? source?.media_type ?? "image/*";
  const uri = data?.url ?? data?.uri ?? source?.url ?? null;
  if (!bytes && !uri) return null;
  return attachmentContent({
    name: data?.name ?? null,
    mimeType,
    data: bytes,
    encoding: bytes ? "base64" : null,
    uri: bytes ? null : uri,
    metadata: { kiroBlockKind: "image" }
  });
}

function portableBlock(block, mode) {
  if (!block || typeof block !== "object") return [];
  const kind = String(block.kind ?? block.type ?? "unknown");
  const data = block.data ?? block.value ?? null;
  if (kind === "text") {
    const text = textFrom(data);
    return text ? [textContent(text)] : [];
  }
  if (kind === "thinking") {
    if (mode !== "lossless") return [];
    return [reasoningContent({ provider: "kiro-cli", text: textFrom(data), raw: block })];
  }
  if (kind === "toolUse") {
    const tool = data && typeof data === "object" ? data : {};
    return [toolCallContent({
      id: tool.toolUseId ?? tool.tool_use_id ?? tool.id ?? null,
      name: tool.name ?? tool.toolName ?? "unknown",
      input: tool.input ?? tool.arguments ?? null
    })];
  }
  if (kind === "toolResult") {
    const result = data && typeof data === "object" ? data : {};
    const status = String(result.status ?? "").toLowerCase();
    return [toolResultContent({
      callId: result.toolUseId ?? result.tool_use_id ?? result.id ?? null,
      output: result.content ?? result.output ?? result.result ?? result,
      isError: Boolean(result.error) || status === "error" || status === "failed" || status === "failure"
    })];
  }
  if (kind === "image") {
    const attachment = imageAttachment(block);
    return attachment ? [attachment] : [];
  }
  if (mode === "lossless") return [{ type: "kiro-unknown", provider: "kiro-cli", raw: block }];
  return [];
}

function blocksFromData(data) {
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data)) return data;
  if (data?.content && typeof data.content === "object") return [data.content];
  return [];
}

function timestampFor(record) {
  return iso(record?.timestamp ?? record?.data?.timestamp ?? record?.data?.created_at ?? record?.data?.createdAt);
}

function messageIdFor(record, index) {
  return record?.data?.message_id ?? record?.data?.messageId ?? record?.message_id ?? record?.messageId ?? `kiro:${index}`;
}

function recordToMessage(record, mode, index) {
  const kind = String(record?.kind ?? "unknown");
  if (kind === "Clear") return null;
  let blocks = blocksFromData(record?.data);
  if (kind === "ToolUse" && !blocks.length) blocks = [{ kind: "toolUse", data: record?.data }];
  if (kind === "ToolResults" && !blocks.length && record?.data) {
    if (Array.isArray(record.data.toolResults)) blocks = record.data.toolResults.map((item) => ({ kind: "toolResult", data: item }));
    else blocks = [{ kind: "toolResult", data: record.data }];
  }
  if (kind === "Prompt" && !blocks.length) {
    const prompt = record?.data?.prompt ?? record?.data?.text ?? record?.data?.message;
    if (typeof prompt === "string") blocks = [{ kind: "text", data: prompt }];
  }
  const content = blocks.flatMap((block) => portableBlock(block, mode));
  if (!content.length) return null;
  const role = kind === "AssistantMessage" || kind === "ToolUse" ? "assistant" : kind === "ToolResults" ? "tool" : "user";
  return {
    id: String(messageIdFor(record, index)),
    parentId: null,
    role,
    createdAt: timestampFor(record),
    content,
    metadata: {
      kiroEventKind: kind,
      version: record?.version ?? null,
      stopReason: record?.data?.stop_reason ?? record?.data?.stopReason ?? null,
      model: record?.data?.model ?? record?.data?.model_id ?? record?.data?.modelId ?? null,
      meteringUsage: record?.data?.metering_usage ?? record?.data?.meteringUsage ?? null
    }
  };
}

async function readRecords(file, mode) {
  const records = [];
  const events = [];
  let rawRecordCount = 0;
  let malformedLineCount = 0;
  const input = fsSync.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); }
    catch {
      if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider: "kiro-cli", kind: "malformed-json", data: { lineNumber, raw } }));
      malformedLineCount += 1;
      rawRecordCount += 1;
      continue;
    }
    records.push(record);
    if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider: "kiro-cli", kind: `event:${record?.kind ?? "unknown"}`, timestamp: timestampFor(record), data: record }));
    rawRecordCount += 1;
  }
  return { records, events, rawRecordCount, malformedLineCount };
}

function activeRecords(records) {
  let lastClear = -1;
  for (let index = 0; index < records.length; index += 1) if (records[index]?.kind === "Clear") lastClear = index;
  return { records: records.slice(lastClear + 1), lastClearIndex: lastClear, clearCount: records.filter((record) => record?.kind === "Clear").length };
}

function firstVisibleText(messages) {
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.content?.find((part) => part.type === "text")?.text?.trim();
    if (text) return text;
  }
  return null;
}

function modelFromMetadata(meta) {
  return meta?.session_state?.rts_model_state?.model_info?.model_id
    ?? meta?.session_state?.rts_model_state?.model_info?.model_name
    ?? meta?.model_id
    ?? meta?.model_name
    ?? null;
}

async function parseSession(file, mode = "portable") {
  const physical = await readRecords(file, mode);
  const active = activeRecords(physical.records);
  const messages = [];
  for (let index = 0; index < active.records.length; index += 1) {
    const message = recordToMessage(active.records[index], mode, index);
    if (message) messages.push(message);
  }
  const metaFile = sidecar(file, ".json");
  const historyFile = sidecar(file, ".history");
  const meta = await readJson(metaFile);
  return { ...physical, active, messages, meta, metaFile, historyFile };
}

async function walkCompanionDir(root, prefix = "session") {
  const output = [];
  const stack = [{ dir: root, relative: "" }];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = await fs.readdir(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      const relative = path.join(current.relative, entry.name);
      if (entry.isDirectory()) stack.push({ dir: absolute, relative });
      else if (entry.isFile()) output.push({ path: absolute, filename: `${prefix}/${relative.replaceAll(path.sep, "/")}`, mediaType: entry.name.endsWith(".json") ? "application/json" : entry.name.endsWith(".jsonl") ? "application/x-ndjson" : "application/octet-stream" });
    }
  }
  return output;
}

async function nativeCompanions(file) {
  const companions = [];
  const metaFile = sidecar(file, ".json");
  const historyFile = sidecar(file, ".history");
  if (await exists(metaFile)) companions.push({ path: metaFile, filename: path.basename(metaFile), mediaType: "application/json" });
  if (await exists(historyFile)) companions.push({ path: historyFile, filename: path.basename(historyFile), mediaType: "text/plain" });
  const extraDir = path.join(path.dirname(file), path.basename(file, ".jsonl"));
  if (await exists(extraDir)) companions.push(...await walkCompanionDir(extraDir));
  return companions;
}

export class KiroCliAdapter {
  constructor(options = {}) {
    this.id = "kiro-cli";
    this.name = "Kiro CLI";
    this.aliases = ["kiro", "kirocli"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["kiro-cli/session-jsonl-v1"];
    this.command = options.command ?? "kiro-cli";
    this.runner = options.runner ?? spawnSync;
    this.kiroHome = defaultKiroHome(options);
    this.sessionRoots = defaultSessionRoots(options);
  }

  async detect() {
    const existingRoots = [];
    for (const root of this.sessionRoots) if (await exists(root)) existingRoots.push(root);
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const cliInstalled = !result?.error && result?.status === 0;
    return {
      installed: cliInstalled || existingRoots.length > 0,
      version: cliInstalled ? String(result.stdout || result.stderr || "").trim() || null : null,
      kiroHome: this.kiroHome,
      sessionRoots: this.sessionRoots,
      existingRoots,
      storageFormat: "cli-session-jsonl-v1",
      sqliteStoreIgnored: true
    };
  }

  async listSessions() {
    const files = [];
    for (const root of this.sessionRoots) {
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(root, entry.name));
    }
    const sessions = [];
    for (const file of files) {
      try {
        const parsed = await parseSession(file, "portable");
        const stat = await fs.stat(file);
        const id = String(parsed.meta?.session_id ?? path.basename(file, ".jsonl"));
        const title = parsed.meta?.title ?? firstVisibleText(parsed.messages)?.slice(0, 100) ?? null;
        sessions.push({
          adapter: this.id,
          id,
          title,
          cwd: parsed.meta?.cwd ?? null,
          path: file,
          createdAt: iso(parsed.meta?.created_at) ?? null,
          updatedAt: iso(parsed.meta?.updated_at) ?? stat.mtime.toISOString(),
          size: stat.size,
          version: parsed.records.find((record) => record?.version)?.version ?? null,
          model: modelFromMetadata(parsed.meta),
          clearCount: parsed.active.clearCount,
          activeRecordCount: parsed.active.records.length,
          totalRecordCount: parsed.records.length
        });
      } catch {}
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await exists(ref)) return path.resolve(ref);
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.id.startsWith(ref) || session.path === ref);
    if (!matches.length) throw new Error(`Kiro CLI session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((session) => session.path === ref)) throw new Error(`Kiro CLI session id is ambiguous: ${sessionRef}; pass the full JSONL path`);
    return matches[0].path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseSession(file, mode);
    const stat = await fs.stat(file);
    const id = String(parsed.meta?.session_id ?? path.basename(file, ".jsonl"));
    const allContent = parsed.messages.flatMap((message) => message.content ?? []);
    const unknownEventKinds = parsed.records.filter((record) => !KNOWN_EVENT_KINDS.has(String(record?.kind ?? "unknown"))).length;
    const unknownContentBlocks = parsed.records.reduce((sum, record) => sum + blocksFromData(record?.data).filter((block) => !KNOWN_BLOCK_KINDS.has(String(block?.kind ?? block?.type ?? "unknown"))).length, 0);
    return createPortableSession({
      id,
      title: parsed.meta?.title ?? firstVisibleText(parsed.messages)?.slice(0, 100) ?? null,
      cwd: parsed.meta?.cwd ?? null,
      startedAt: iso(parsed.meta?.created_at),
      updatedAt: iso(parsed.meta?.updated_at) ?? stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: id, path: file },
      messages: parsed.messages,
      agents: [],
      metadata: {
        model: modelFromMetadata(parsed.meta),
        clearCount: parsed.active.clearCount,
        lastClearIndex: parsed.active.lastClearIndex,
        activeRecordCount: parsed.active.records.length,
        totalRecordCount: parsed.records.length,
        malformedLineCount: parsed.malformedLineCount,
        ...(mode === "lossless" ? { kiroSessionMetadata: parsed.meta } : {})
      },
      events: parsed.events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "kiro-cli/session-jsonl-v1",
        rawRecordCount: parsed.rawRecordCount,
        includesProviderReasoning: allContent.some((part) => part.type === "reasoning"),
        includesUnknownContent: allContent.some((part) => part.type === "kiro-unknown") || unknownContentBlocks > 0,
        includesUnknownEvents: unknownEventKinds > 0 || parsed.malformedLineCount > 0,
        preservesPreClearHistoryAsRawEvents: parsed.active.lastClearIndex >= 0,
        companionMetadata: await exists(parsed.metaFile),
        companionPromptHistory: await exists(parsed.historyFile)
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseSession(file, "portable");
    const id = String(parsed.meta?.session_id ?? path.basename(file, ".jsonl"));
    return {
      kind: "agent-session",
      format: "kiro-cli/session-jsonl-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: file,
      filename: path.basename(file),
      companions: await nativeCompanions(file),
      cwd: parsed.meta?.cwd ?? null,
      sessionId: id,
      model: modelFromMetadata(parsed.meta)
    };
  }
}
