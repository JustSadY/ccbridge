import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachmentContent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";
import { readJsonl } from "../io/jsonl.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const iso = (value) => {
  if (value == null) return null;
  const number = typeof value === "number" ? value : Number.NaN;
  const date = Number.isFinite(number) ? new Date(number) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function defaultRoots(options = {}) {
  if (Array.isArray(options.sessionRoots) && options.sessionRoots.length) return options.sessionRoots.map((value) => path.resolve(value));
  const env = options.env ?? process.env;
  const bridgeRoots = String(env.CCBRIDGE_PI_SESSION_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  if (bridgeRoots.length) return bridgeRoots.map((value) => path.resolve(value));
  if (env.PI_CODING_AGENT_SESSION_DIR) return [path.resolve(env.PI_CODING_AGENT_SESSION_DIR)];
  const agentDir = path.resolve(env.PI_CODING_AGENT_DIR ?? path.join(options.userHome ?? os.homedir(), ".pi", "agent"));
  return [path.join(agentDir, "sessions")];
}

async function walkJsonl(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
    }
  }
  return files;
}

function contentParts(content, mode, provider = "pi") {
  if (typeof content === "string") return content ? [textContent(content)] : [];
  const output = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (block.type === "image" && typeof block.data === "string") output.push(attachmentContent({ mimeType: block.mimeType ?? "image/*", data: block.data, encoding: "base64", metadata: { piContentType: "image" } }));
    else if (block.type === "thinking" && mode === "lossless") output.push(reasoningContent({ provider, text: block.thinking ?? null, signature: block.signature ?? null, raw: block }));
    else if (block.type === "toolCall") output.push(toolCallContent({ id: block.id ?? null, name: block.name ?? "unknown", input: block.arguments ?? null }));
  }
  return output;
}

function titleFromContent(content) {
  if (typeof content === "string") return content.trim().slice(0, 100) || null;
  const text = Array.isArray(content) ? content.find((part) => part?.type === "text" && typeof part.text === "string")?.text : null;
  return text?.trim().slice(0, 100) || null;
}

function activeBranch(entries) {
  if (!entries.length) return [];
  const indexed = new Map(entries.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  const leaf = [...entries].reverse().find((entry) => entry?.id);
  if (!leaf || !indexed.size || !entries.some((entry) => Object.hasOwn(entry ?? {}, "parentId"))) return entries;
  const pathEntries = [];
  const seen = new Set();
  let current = leaf;
  while (current && !seen.has(current.id)) {
    pathEntries.push(current);
    seen.add(current.id);
    current = current.parentId ? indexed.get(current.parentId) : null;
  }
  return pathEntries.reverse();
}

function semanticBranch(branch) {
  let latestCompaction = -1;
  for (let index = 0; index < branch.length; index += 1) if (branch[index]?.type === "compaction") latestCompaction = index;
  if (latestCompaction < 0) return { entries: branch, compaction: null };
  const compaction = branch[latestCompaction];
  const firstKept = branch.findIndex((entry) => entry?.id === compaction.firstKeptEntryId);
  const start = firstKept >= 0 && firstKept < latestCompaction ? firstKept : latestCompaction + 1;
  return { entries: branch.slice(start).filter((entry) => entry !== compaction && entry?.type !== "compaction"), compaction };
}

function portableMessageFromEntry(entry, mode) {
  const timestamp = iso(entry?.message?.timestamp ?? entry?.timestamp);
  if (entry?.type === "message") {
    const message = entry.message ?? {};
    if (message.role === "user") {
      const content = contentParts(message.content, mode, message.provider ?? "pi");
      return content.length ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "user", createdAt: timestamp, content, metadata: {} } : null;
    }
    if (message.role === "assistant") {
      const content = contentParts(message.content, mode, message.provider ?? "pi");
      return content.length ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "assistant", createdAt: timestamp, content, metadata: { api: message.api ?? null, provider: message.provider ?? null, model: message.model ?? null, usage: message.usage ?? null, stopReason: message.stopReason ?? null, errorMessage: message.errorMessage ?? null } } : null;
    }
    if (message.role === "toolResult") {
      const content = [toolResultContent({ callId: message.toolCallId ?? null, output: message.content ?? null, isError: Boolean(message.isError) })];
      for (const part of contentParts(message.content, mode)) if (part.type === "attachment") content.push(part);
      return { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "tool", createdAt: timestamp, content, metadata: { toolName: message.toolName ?? null, details: message.details ?? null } };
    }
    if (message.role === "bashExecution") {
      if (message.excludeFromContext === true) return null;
      const text = [`$ ${message.command ?? ""}`, message.output ?? ""].filter(Boolean).join("\n");
      return text ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "user", createdAt: timestamp, content: [textContent(text)], metadata: { piRole: "bashExecution", exitCode: message.exitCode ?? null, cancelled: Boolean(message.cancelled), truncated: Boolean(message.truncated), fullOutputPath: message.fullOutputPath ?? null } } : null;
    }
    if (message.role === "custom") {
      const content = contentParts(message.content, mode);
      return content.length ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "user", createdAt: timestamp, content, metadata: { piRole: "custom", customType: message.customType ?? null, display: message.display ?? null, details: message.details ?? null } } : null;
    }
    if (message.role === "branchSummary" || message.role === "compactionSummary") {
      const summary = message.summary ?? "";
      return summary ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "system", createdAt: timestamp, content: [textContent(summary)], metadata: { piRole: message.role, fromId: message.fromId ?? null, tokensBefore: message.tokensBefore ?? null } } : null;
    }
    return null;
  }
  if (entry?.type === "custom_message") {
    const content = contentParts(entry.content, mode);
    return content.length ? { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "user", createdAt: iso(entry.timestamp), content, metadata: { piEntryType: "custom_message", customType: entry.customType ?? null, display: entry.display ?? null, details: entry.details ?? null } } : null;
  }
  if (entry?.type === "branch_summary" && typeof entry.summary === "string") {
    return { id: entry.id ?? null, parentId: entry.parentId ?? null, role: "system", createdAt: iso(entry.timestamp), content: [textContent(entry.summary)], metadata: { piEntryType: "branch_summary", fromId: entry.fromId ?? null, details: entry.details ?? null, usage: entry.usage ?? null } };
  }
  return null;
}

async function parseSession(file, mode = "portable") {
  let header = null;
  const entries = [];
  const events = [];
  let index = 0;
  for await (const { value } of readJsonl(file)) {
    if (!header && value?.type === "session") header = value;
    else entries.push(value);
    if (mode === "lossless") events.push(rawEvent({ index, provider: "pi", kind: value?.type === "session" ? "session" : `entry:${value?.type ?? "unknown"}`, timestamp: iso(value?.timestamp), data: value }));
    index += 1;
  }
  if (!header || header.type !== "session") throw new Error(`Pi session is missing a valid session header: ${file}`);
  const branch = activeBranch(entries);
  const semantic = semanticBranch(branch);
  const messages = [];
  if (semantic.compaction?.summary) messages.push({ id: `compaction:${semantic.compaction.id ?? "summary"}`, parentId: null, role: "system", createdAt: iso(semantic.compaction.timestamp), content: [textContent(semantic.compaction.summary)], metadata: { piEntryType: "compaction", firstKeptEntryId: semantic.compaction.firstKeptEntryId ?? null, tokensBefore: semantic.compaction.tokensBefore ?? null, details: semantic.compaction.details ?? null, usage: semantic.compaction.usage ?? null } });
  for (const entry of semantic.entries) {
    const message = portableMessageFromEntry(entry, mode);
    if (message) messages.push(message);
  }
  const sessionInfo = [...branch].reverse().find((entry) => entry?.type === "session_info" && typeof entry.name === "string");
  const firstUser = branch.find((entry) => entry?.type === "message" && entry?.message?.role === "user");
  const modelChange = [...branch].reverse().find((entry) => entry?.type === "model_change");
  const thinkingChange = [...branch].reverse().find((entry) => entry?.type === "thinking_level_change");
  return { header, entries, branch, messages, events, rawCount: index, title: sessionInfo?.name ?? titleFromContent(firstUser?.message?.content), modelChange, thinkingChange, compaction: semantic.compaction };
}

export class PiAdapter {
  constructor(options = {}) {
    this.id = "pi";
    this.name = "Pi Coding Agent";
    this.aliases = ["pi-coding-agent", "pi-agent"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["pi/session-jsonl"];
    this.sessionRoots = defaultRoots(options);
  }

  async detect() {
    const existingRoots = [];
    for (const root of this.sessionRoots) if (await exists(root)) existingRoots.push(root);
    return { installed: existingRoots.length > 0, version: null, sessionRoots: this.sessionRoots, existingRoots, storageFormat: "session-jsonl-v1-v3", currentFormatVersion: 3 };
  }

  async listSessions() {
    const files = [];
    for (const root of this.sessionRoots) files.push(...await walkJsonl(root));
    const sessions = [];
    for (const file of files) {
      try {
        const parsed = await parseSession(file, "portable");
        const stat = await fs.stat(file);
        sessions.push({ adapter: this.id, id: parsed.header.id ?? path.basename(file, ".jsonl"), title: parsed.title, cwd: parsed.header.cwd ?? null, path: file, createdAt: iso(parsed.header.timestamp), updatedAt: stat.mtime.toISOString(), size: stat.size, version: parsed.header.version ?? 1, activeLeafId: parsed.branch.at(-1)?.id ?? null, activeBranchEntries: parsed.branch.length, totalEntries: parsed.entries.length, parentSession: parsed.header.parentSession ?? null });
      } catch {}
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await exists(ref)) return path.resolve(ref);
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.id?.startsWith(ref) || session.path === ref);
    if (!matches.length) throw new Error(`Pi session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((session) => session.path === ref)) throw new Error(`Pi session id is ambiguous: ${sessionRef}; pass the full JSONL path`);
    return matches[0].path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseSession(file, mode);
    const stat = await fs.stat(file);
    const allContent = parsed.messages.flatMap((message) => message.content ?? []);
    return createPortableSession({ id: parsed.header.id ?? path.basename(file, ".jsonl"), title: parsed.title, cwd: parsed.header.cwd ?? null, startedAt: iso(parsed.header.timestamp), updatedAt: stat.mtime.toISOString(), source: { adapter: this.id, sessionId: parsed.header.id ?? path.basename(file, ".jsonl"), path: file }, messages: parsed.messages, agents: [], metadata: { sessionVersion: parsed.header.version ?? 1, parentSession: parsed.header.parentSession ?? null, activeLeafId: parsed.branch.at(-1)?.id ?? null, activeBranchEntryCount: parsed.branch.length, totalEntryCount: parsed.entries.length, currentProvider: parsed.modelChange?.provider ?? null, currentModel: parsed.modelChange?.modelId ?? null, currentThinkingLevel: parsed.thinkingChange?.thinkingLevel ?? null, latestCompaction: parsed.compaction ? { id: parsed.compaction.id ?? null, firstKeptEntryId: parsed.compaction.firstKeptEntryId ?? null, tokensBefore: parsed.compaction.tokensBefore ?? null } : null }, events: parsed.events, lossless: mode === "lossless" ? { enabled: true, sourceFormat: `pi/session-jsonl-v${parsed.header.version ?? 1}`, rawRecordCount: parsed.rawCount, includesProviderReasoning: allContent.some((part) => part.type === "reasoning"), includesUnknownEvents: true, preservesInactiveBranchesAsRawEvents: parsed.entries.length > parsed.branch.length } : null });
  }

  async getNativeArtifact(sessionRef) {
    const file = await this.resolveSession(sessionRef);
    const parsed = await parseSession(file, "portable");
    return { kind: "agent-session", format: "pi/session-jsonl", formatVersion: parsed.header.version ?? 1, sourceAdapter: this.id, path: file, filename: path.basename(file), cwd: parsed.header.cwd ?? null, sessionId: parsed.header.id ?? path.basename(file, ".jsonl"), parentSession: parsed.header.parentSession ?? null };
  }
}
