import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachmentContent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const EXTENSION_DIR = "rooveterinaryinc.roo-cline";
const API_HISTORY = "api_conversation_history.json";
const UI_HISTORY = "ui_messages.json";
const TASK_METADATA = "task_metadata.json";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const iso = (value) => { if (value == null) return null; const date = new Date(typeof value === "number" ? value : String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };
const unique = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
const readJson = async (file, fallback = null) => { try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; } };

function defaultHomes(options = {}) {
  if (options.home) return [path.resolve(options.home)];
  if (Array.isArray(options.homes) && options.homes.length) return unique(options.homes);
  const env = options.env ?? process.env;
  if (env.CCBRIDGE_ROO_HOME) return [path.resolve(env.CCBRIDGE_ROO_HOME)];
  const home = options.userHome ?? os.homedir();
  const roots = [];
  if (process.platform === "win32") {
    if (env.APPDATA) for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(env.APPDATA, editor, "User", "globalStorage", EXTENSION_DIR));
  } else if (process.platform === "darwin") {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, "Library", "Application Support", editor, "User", "globalStorage", EXTENSION_DIR));
  } else {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, ".config", editor, "User", "globalStorage", EXTENSION_DIR));
    roots.push(path.join(home, ".vscode-server", "data", "User", "globalStorage", EXTENSION_DIR));
    roots.push(path.join(home, ".vscode-server-insiders", "data", "User", "globalStorage", EXTENSION_DIR));
  }
  return unique(roots);
}

async function taskFiles(home, taskId) {
  const dir = path.join(home, "tasks", taskId);
  const api = path.join(dir, API_HISTORY);
  const legacy = path.join(dir, "claude_messages.json");
  return {
    dir,
    api: await exists(api) ? api : await exists(legacy) ? legacy : null,
    ui: await exists(path.join(dir, UI_HISTORY)) ? path.join(dir, UI_HISTORY) : null,
    metadata: await exists(path.join(dir, TASK_METADATA)) ? path.join(dir, TASK_METADATA) : null
  };
}

function attachment(block) {
  const source = block?.source;
  if (!source || typeof source !== "object") return null;
  const mimeType = source.media_type ?? block.media_type ?? (block.type === "image" ? "image/*" : "application/octet-stream");
  const name = block.name ?? block.filename ?? source.name ?? null;
  if (source.type === "base64" && typeof source.data === "string") return attachmentContent({ name, mimeType, data: source.data, encoding: "base64", metadata: { rooType: block.type } });
  if (source.type === "url" && typeof source.url === "string") return attachmentContent({ name, mimeType, uri: source.url, metadata: { rooType: block.type } });
  if (source.type === "text" && typeof source.data === "string") return attachmentContent({ name, mimeType: source.media_type ?? "text/plain", data: source.data, encoding: "utf8", metadata: { rooType: block.type } });
  return null;
}

function contentParts(message, mode) {
  const output = [];
  if (mode === "lossless" && (message?.type === "reasoning" || message?.reasoning_content || message?.reasoning_details || message?.encrypted_content)) {
    output.push(reasoningContent({
      provider: "roo-code",
      text: message.text ?? message.reasoning_content ?? null,
      summary: message.summary ?? message.reasoning_details ?? null,
      encrypted: message.encrypted_content ?? null,
      raw: message.type === "reasoning" ? message : { reasoning_content: message.reasoning_content ?? null, reasoning_details: message.reasoning_details ?? null, encrypted_content: message.encrypted_content ?? null }
    }));
    if (message?.type === "reasoning") return output;
  }
  if (typeof message?.content === "string") { if (message.content) output.push(textContent(message.content)); return output; }
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (block.type === "thinking" && mode === "lossless") output.push(reasoningContent({ provider: "roo-code", text: block.thinking ?? null, signature: block.signature ?? null, raw: block }));
    else if (block.type === "tool_use") output.push(toolCallContent({ id: block.id ?? null, name: block.name, input: block.input ?? null }));
    else if (block.type === "tool_result") output.push(toolResultContent({ callId: block.tool_use_id ?? null, output: block.content ?? null, isError: Boolean(block.is_error) }));
    else if (block.type === "image" || block.type === "document") { const part = attachment(block); if (part) output.push(part); }
  }
  return output;
}

function titleFromMessages(messages) {
  for (const message of messages ?? []) {
    if (message?.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim().slice(0, 100);
    const block = (message.content ?? []).find((item) => item?.type === "text" && typeof item.text === "string" && item.text.trim());
    if (block) return block.text.trim().slice(0, 100);
  }
  return null;
}

export class RooCodeAdapter {
  constructor(options = {}) {
    this.id = "roo-code";
    this.name = "Roo Code";
    this.aliases = ["roo"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["roo-code/task-files-v1"];
    this.homes = defaultHomes(options);
  }

  async detect() {
    const stores = [];
    for (const home of this.homes) if (await exists(path.join(home, "tasks"))) stores.push(home);
    return { installed: stores.length > 0, version: null, storageRoots: this.homes, detectedStorageRoots: stores, sessionStoreExists: stores.length > 0, storageFormat: "anthropic-api-history+ui-messages", archivedUpstream: true };
  }

  async listSessions() {
    const sessions = [];
    for (const home of this.homes) {
      let entries;
      try { entries = await fs.readdir(path.join(home, "tasks"), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const files = await taskFiles(home, entry.name);
        if (!files.api) continue;
        const native = await readJson(files.api, null);
        if (!Array.isArray(native)) continue;
        const metadata = files.metadata ? await readJson(files.metadata, {}) : {};
        try {
          const stat = await fs.stat(files.api);
          sessions.push({ adapter: this.id, id: entry.name, title: titleFromMessages(native), cwd: metadata?.cwd ?? metadata?.workspacePath ?? null, path: files.api, createdAt: native.map((item) => iso(item?.ts)).find(Boolean) ?? null, updatedAt: stat.mtime.toISOString(), size: stat.size, kind: metadata?.mode ?? "task", parentTaskId: metadata?.parentTaskId ?? null, rootTaskId: metadata?.rootTaskId ?? null, storageRoot: home });
        } catch {}
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if ((ref.endsWith(API_HISTORY) || ref.endsWith("claude_messages.json")) && await exists(ref)) {
      const file = path.resolve(ref);
      const taskId = path.basename(path.dirname(file));
      const home = path.dirname(path.dirname(path.dirname(file)));
      return { home, taskId, files: { ...(await taskFiles(home, taskId)), api: file } };
    }
    for (const home of this.homes) { const files = await taskFiles(home, ref); if (files.api) return { home, taskId: ref, files }; }
    const match = (await this.listSessions()).find((session) => session.id === ref || session.path === ref);
    if (!match) throw new Error(`Roo Code task not found: ${sessionRef}`);
    return { home: match.storageRoot, taskId: match.id, files: await taskFiles(match.storageRoot, match.id) };
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const resolved = await this.resolveSession(sessionRef);
    const native = await readJson(resolved.files.api, null);
    if (!Array.isArray(native)) throw new Error(`Invalid Roo API history: ${resolved.files.api}`);
    const taskMetadata = resolved.files.metadata ? await readJson(resolved.files.metadata, {}) : {};
    const messages = [];
    const events = [];
    let startedAt = null;
    let updatedAt = null;
    for (let index = 0; index < native.length; index += 1) {
      const item = native[index];
      const createdAt = iso(item?.ts);
      startedAt ??= createdAt;
      updatedAt = createdAt ?? updatedAt;
      if (mode === "lossless") events.push(rawEvent({ index, provider: this.id, kind: item?.type === "reasoning" ? "api-message:reasoning" : `api-message:${item?.role ?? "unknown"}`, timestamp: createdAt, data: item }));
      const content = contentParts(item, mode);
      if (!content.length) continue;
      messages.push({ id: item?.id ?? null, parentId: null, role: item?.type === "reasoning" || item?.role === "assistant" ? "assistant" : "user", createdAt, content, metadata: { isSummary: Boolean(item?.isSummary), condenseId: item?.condenseId ?? null, condenseParent: item?.condenseParent ?? null, truncationId: item?.truncationId ?? null, truncationParent: item?.truncationParent ?? null, isTruncationMarker: Boolean(item?.isTruncationMarker) } });
    }
    const stat = await fs.stat(resolved.files.api);
    return createPortableSession({
      id: resolved.taskId,
      title: titleFromMessages(native),
      cwd: taskMetadata?.cwd ?? taskMetadata?.workspacePath ?? null,
      startedAt,
      updatedAt: updatedAt ?? stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: resolved.taskId, path: resolved.files.api },
      messages,
      agents: [],
      metadata: { taskMetadata, uiMessagesPresent: Boolean(resolved.files.ui), storageRoot: resolved.home, archivedUpstream: true },
      events,
      lossless: mode === "lossless" ? { enabled: true, sourceFormat: "roo-code/api-conversation-history-v1", rawRecordCount: events.length, includesProviderReasoning: native.some((item) => item?.type === "reasoning" || item?.reasoning_content || item?.reasoning_details || item?.encrypted_content || (Array.isArray(item?.content) && item.content.some((block) => block?.type === "thinking"))), includesUnknownEvents: true, companionUiHistory: Boolean(resolved.files.ui), companionTaskMetadata: Boolean(resolved.files.metadata) } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const resolved = await this.resolveSession(sessionRef);
    const taskMetadata = resolved.files.metadata ? await readJson(resolved.files.metadata, {}) : {};
    const companions = [];
    if (resolved.files.ui) companions.push({ path: resolved.files.ui, filename: UI_HISTORY, mediaType: "application/json" });
    if (resolved.files.metadata) companions.push({ path: resolved.files.metadata, filename: TASK_METADATA, mediaType: "application/json" });
    return { kind: "agent-session", format: "roo-code/task-files-v1", formatVersion: 1, sourceAdapter: this.id, path: resolved.files.api, filename: path.basename(resolved.files.api), companions, cwd: taskMetadata?.cwd ?? taskMetadata?.workspacePath ?? null, sessionId: resolved.taskId, archivedUpstream: true };
  }
}
