import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { attachmentContent, createPortableAgent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);

function defaultVibeRoots(options = {}) {
  if (Array.isArray(options.sessionRoots) && options.sessionRoots.length) return options.sessionRoots.map((value) => path.resolve(value));
  const env = options.env ?? process.env;
  const explicit = String(env.CCBRIDGE_VIBE_SESSION_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  if (explicit.length) return explicit.map((value) => path.resolve(value));
  return [path.resolve(options.saveDir ?? path.join(options.userHome ?? os.homedir(), ".vibe", "logs", "session"))];
}

function iso(value) {
  if (value == null) return null;
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cwdFromMetadata(meta) {
  return meta?.environment?.working_directory ?? meta?.origin_directory ?? null;
}

function imageAttachment(image, cwd) {
  if (!image || typeof image !== "object") return null;
  const source = image.source && typeof image.source === "object" ? image.source : image;
  const mimeType = image.mime_type ?? image.mimeType ?? "image/*";
  if (source.kind === "inline" && typeof source.data === "string") {
    return attachmentContent({ name: image.alias ?? null, mimeType, data: source.data, encoding: "base64", metadata: { vibeImageAlias: image.alias ?? null } });
  }
  const rawPath = source.path ?? image.path;
  if (typeof rawPath === "string" && rawPath) {
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd ?? process.cwd(), rawPath);
    return attachmentContent({ name: image.alias ?? path.basename(filePath), mimeType, path: filePath, metadata: { vibeImageAlias: image.alias ?? null } });
  }
  return null;
}

function reasoningBlock(message) {
  const text = typeof message?.reasoning_content === "string" ? message.reasoning_content : null;
  const payloads = Array.isArray(message?.reasoning_payloads) ? message.reasoning_payloads : null;
  const messageId = message?.reasoning_message_id ?? null;
  if (!text && !payloads?.length && !messageId) return null;
  return reasoningContent({ provider: "mistral-vibe", text, raw: { reasoning_payloads: payloads, reasoning_message_id: messageId } });
}

function toolCallParts(message) {
  const output = [];
  for (const call of message?.tool_calls ?? []) {
    if (!call || typeof call !== "object") continue;
    let input = call?.function?.arguments ?? null;
    if (typeof input === "string") { try { input = JSON.parse(input); } catch {} }
    output.push(toolCallContent({ id: call.id ?? null, name: call?.function?.name ?? "unknown", input }));
  }
  return output;
}

function messageMetadata(message) {
  return {
    injected: Boolean(message?.injected),
    name: message?.name ?? null,
    messageId: message?.message_id ?? null,
    reasoningMessageId: message?.reasoning_message_id ?? null,
    userDisplayContent: message?.user_display_content ?? null,
    inputText: message?.input_text ?? null,
    resources: message?.resources ?? null,
    manualShell: message?.manual_shell ?? null,
    contextBoundary: message?.context_boundary ?? null
  };
}

function portableMessage(message, mode, cwd, index) {
  if (!message || typeof message !== "object") return null;
  if (mode !== "lossless" && message.role === "system") return null;
  const content = [];
  if (typeof message.content === "string" && message.content) content.push(textContent(message.content));
  if (mode === "lossless") {
    const reasoning = reasoningBlock(message);
    if (reasoning) content.push(reasoning);
  }
  for (const image of message.images ?? []) {
    const attachment = imageAttachment(image, cwd);
    if (attachment) content.push(attachment);
  }
  content.push(...toolCallParts(message));

  if (message.role === "tool") {
    const result = message.tool_result && typeof message.tool_result === "object" ? message.tool_result : null;
    const output = result?.output ?? message.content ?? null;
    const isError = Boolean(result?.cancelled) || Boolean(result?.output?.error) || Boolean(result?.output?.is_error);
    return {
      id: message.message_id ?? `vibe:${index}`,
      parentId: null,
      role: "tool",
      createdAt: null,
      content: [toolResultContent({ callId: message.tool_call_id ?? null, output, isError }), ...content.filter((part) => part.type === "attachment")],
      metadata: { ...messageMetadata(message), toolResult: result }
    };
  }

  if (!content.length) return null;
  const role = ["user", "assistant", "system"].includes(message.role) ? message.role : "system";
  return {
    id: message.message_id ?? `vibe:${index}`,
    parentId: null,
    role,
    createdAt: null,
    content,
    metadata: messageMetadata(message)
  };
}

async function readMessages(file, mode, cwd, provider = "mistral-vibe") {
  const messages = [];
  const events = [];
  let rawRecordCount = 0;
  let malformedLineCount = 0;
  const input = fsSync.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const raw of lines) {
    lineNumber += 1;
    if (!raw.trim()) continue;
    let value;
    try { value = JSON.parse(raw); }
    catch {
      malformedLineCount += 1;
      if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: "malformed-json", data: { lineNumber, raw } }));
      rawRecordCount += 1;
      continue;
    }
    if (mode === "lossless") events.push(rawEvent({ index: rawRecordCount, provider, kind: `message:${value?.role ?? "unknown"}`, data: value }));
    const portable = portableMessage(value, mode, cwd, rawRecordCount);
    if (portable) messages.push(portable);
    rawRecordCount += 1;
  }
  return { messages, events, rawRecordCount, malformedLineCount };
}

async function readMetadata(sessionDir) {
  try { return JSON.parse(await fs.readFile(path.join(sessionDir, "meta.json"), "utf8")); } catch { return null; }
}

async function listTopLevelSessions(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (await exists(path.join(dir, "meta.json")) && await exists(path.join(dir, "messages.jsonl"))) output.push(dir);
  }
  return output;
}

async function recursiveCompanions(sessionDir) {
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
      else if (entry.isFile() && relative !== "messages.jsonl") {
        const lower = entry.name.toLowerCase();
        const mediaType = lower.endsWith(".json") ? "application/json" : lower.endsWith(".jsonl") ? "application/x-ndjson" : lower.endsWith(".md") ? "text/markdown" : lower.endsWith(".log") ? "text/plain" : "application/octet-stream";
        output.push({ path: absolute, filename: relative.replaceAll(path.sep, "/"), mediaType });
      }
    }
  }
  return output;
}

async function childAgents(parentDir, metadata, mode) {
  const agents = [];
  for (const link of metadata?.child_sessions ?? []) {
    if (!link || typeof link !== "object") continue;
    const childDir = typeof link.relative_path === "string" ? path.resolve(parentDir, link.relative_path) : null;
    if (!childDir || !await exists(path.join(childDir, "messages.jsonl"))) continue;
    const childMeta = await readMetadata(childDir) ?? {};
    const cwd = cwdFromMetadata(childMeta);
    const parsed = await readMessages(path.join(childDir, "messages.jsonl"), mode, cwd);
    agents.push(createPortableAgent({
      id: String(childMeta.session_id ?? link.session_id),
      parentId: metadata.session_id ?? null,
      name: link.agent ?? childMeta.title ?? null,
      kind: "subagent",
      startedAt: iso(childMeta.start_time),
      updatedAt: iso(childMeta.end_time),
      source: { adapter: "mistral-vibe", sessionId: String(childMeta.session_id ?? link.session_id), path: childDir },
      messages: parsed.messages,
      events: parsed.events,
      metadata: {
        toolCallId: link.tool_call_id ?? null,
        relativePath: link.relative_path ?? null,
        parentSessionId: childMeta.parent_session_id ?? metadata.session_id ?? null,
        title: childMeta.title ?? null,
        gitBranch: childMeta.git_branch ?? null,
        gitCommit: childMeta.git_commit ?? null,
        malformedLineCount: parsed.malformedLineCount,
        config: mode === "lossless" ? childMeta.config ?? null : null,
        importProvenance: mode === "lossless" ? childMeta.import_provenance ?? null : null
      }
    }));
  }
  return agents;
}

export class MistralVibeAdapter {
  constructor(options = {}) {
    this.id = "mistral-vibe";
    this.name = "Mistral Vibe";
    this.aliases = ["vibe", "mistral", "mistral-vibe-cli"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["mistral-vibe/session-dir-v1"];
    this.command = options.command ?? "vibe";
    this.runner = options.runner ?? spawnSync;
    this.sessionRoots = defaultVibeRoots(options);
  }

  async detect() {
    const existingRoots = [];
    for (const root of this.sessionRoots) if (await exists(root)) existingRoots.push(root);
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const cliInstalled = !result?.error && result?.status === 0;
    return {
      installed: cliInstalled || existingRoots.length > 0,
      version: cliInstalled ? String(result.stdout || result.stderr || "").trim() || null : null,
      sessionRoots: this.sessionRoots,
      existingRoots,
      storageFormat: "session-dir-meta-messages-jsonl"
    };
  }

  async listSessions() {
    const sessions = [];
    for (const root of this.sessionRoots) {
      for (const dir of await listTopLevelSessions(root)) {
        const meta = await readMetadata(dir);
        if (!meta?.session_id) continue;
        const stat = await fs.stat(path.join(dir, "messages.jsonl"));
        sessions.push({
          adapter: this.id,
          id: String(meta.session_id),
          title: meta.title ?? null,
          cwd: cwdFromMetadata(meta),
          path: dir,
          createdAt: iso(meta.start_time),
          updatedAt: iso(meta.end_time) ?? stat.mtime.toISOString(),
          gitBranch: meta.git_branch ?? null,
          gitCommit: meta.git_commit ?? null,
          parentSessionId: meta.parent_session_id ?? null,
          childCount: Array.isArray(meta.child_sessions) ? meta.child_sessions.length : 0
        });
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (await exists(ref) && (await fs.stat(ref)).isDirectory() && await exists(path.join(ref, "messages.jsonl"))) return path.resolve(ref);
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.id.startsWith(ref) || session.path === ref);
    if (!matches.length) throw new Error(`Mistral Vibe session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((session) => session.path === ref)) throw new Error(`Mistral Vibe session id is ambiguous: ${sessionRef}; pass the full session directory`);
    return matches[0].path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const dir = await this.resolveSession(sessionRef);
    const meta = await readMetadata(dir);
    if (!meta?.session_id) throw new Error(`Mistral Vibe session metadata is missing session_id: ${dir}`);
    const cwd = cwdFromMetadata(meta);
    const parsed = await readMessages(path.join(dir, "messages.jsonl"), mode, cwd);
    const agents = await childAgents(dir, meta, mode);
    const allContent = [...parsed.messages, ...agents.flatMap((agent) => agent.messages ?? [])].flatMap((message) => message.content ?? []);
    return createPortableSession({
      id: String(meta.session_id),
      title: meta.title ?? parsed.messages.find((message) => message.role === "user")?.content?.find((part) => part.type === "text")?.text?.trim()?.slice(0, 100) ?? null,
      cwd,
      startedAt: iso(meta.start_time),
      updatedAt: iso(meta.end_time),
      source: { adapter: this.id, sessionId: String(meta.session_id), path: dir },
      messages: parsed.messages,
      agents,
      metadata: {
        parentSessionId: meta.parent_session_id ?? null,
        gitCommit: meta.git_commit ?? null,
        gitBranch: meta.git_branch ?? null,
        originDirectory: meta.origin_directory ?? null,
        currentDirectory: meta.environment?.working_directory ?? null,
        titleSource: meta.title_source ?? null,
        createdWorktree: meta.created_worktree ?? null,
        childSessions: meta.child_sessions ?? [],
        loops: meta.loops ?? [],
        malformedLineCount: parsed.malformedLineCount,
        ...(mode === "lossless" ? { config: meta.config ?? null, experiments: meta.experiments ?? null, importProvenance: meta.import_provenance ?? null } : {})
      },
      events: parsed.events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "mistral-vibe/session-dir-v1",
        rawRecordCount: parsed.rawRecordCount + agents.reduce((sum, agent) => sum + (agent.events?.length ?? 0), 0),
        includesProviderReasoning: allContent.some((part) => part.type === "reasoning"),
        includesUnknownContent: false,
        includesUnknownEvents: parsed.malformedLineCount > 0,
        includesSubagents: agents.length > 0,
        preservesSystemMessagesAsRawEvents: true,
        preservesReasoningPayloads: true
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const dir = await this.resolveSession(sessionRef);
    const meta = await readMetadata(dir);
    if (!meta?.session_id) throw new Error(`Mistral Vibe session metadata is missing session_id: ${dir}`);
    return {
      kind: "agent-session",
      format: "mistral-vibe/session-dir-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: path.join(dir, "messages.jsonl"),
      filename: "messages.jsonl",
      companions: await recursiveCompanions(dir),
      cwd: cwdFromMetadata(meta),
      sessionId: String(meta.session_id),
      sessionDir: dir
    };
  }
}
