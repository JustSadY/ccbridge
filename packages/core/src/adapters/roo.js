import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attachmentContent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const EXTENSION_DIR = "rooveterinaryinc.roo-cline";
const API_HISTORY = "api_conversation_history.json";
const UI_HISTORY = "ui_messages.json";
const TASK_METADATA = "task_metadata.json";

function exists(file) { return fs.access(file).then(() => true).catch(() => false); }
function iso(value) { if (value === null || value === undefined) return null; const date = new Date(typeof value === "number" ? value : String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function unique(values) { return [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))]; }

function defaultHomes(options = {}) {
  if (options.home) return [path.resolve(options.home)];
  if (Array.isArray(options.homes) && options.homes.length) return unique(options.homes);
  const env = options.env ?? process.env;
  if (env.CCBRIDGE_ROO_HOME) return [path.resolve(env.CCBRIDGE_ROO_HOME)];
  const home = options.userHome ?? os.homedir();
  const candidates = [];
  if (process.platform === "win32") {
    const appData = env.APPDATA;
    if (appData) {
      candidates.push(path.join(appData, "Code", "User", "globalStorage", EXTENSION_DIR));
      candidates.push(path.join(appData, "Code - Insiders", "User", "globalStorage", EXTENSION_DIR));
      candidates.push(path.join(appData, "VSCodium", "User", "globalStorage", EXTENSION_DIR));
    }
  } else if (process.platform === "darwin") {
    candidates.push(path.join(home, "Library", "Application Support", "Code", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, "Library", "Application Support", "Code - Insiders", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, "Library", "Application Support", "VSCodium", "User", "globalStorage", EXTENSION_DIR));
  } else {
    candidates.push(path.join(home, ".config", "Code", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, ".config", "Code - Insiders", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, ".config", "VSCodium", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, ".vscode-server", "data", "User", "globalStorage", EXTENSION_DIR));
    candidates.push(path.join(home, ".vscode-server-insiders", "data", "User", "globalStorage", EXTENSION_DIR));
  }
  return unique(candidates);
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch { return fallback; }
}

function anthropicAttachment(block) {
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
  if (message?.type === "reasoning") {
    if (mode !== "lossless") return [];
    return [reasoningContent({ provider: "roo-code", text: message.text ?? message.reasoning_content ?? null, summary: message.summary ?? message.reasoning_details ?? null, encrypted: message.encrypted_content ?? null, raw: message })];
  }
  if (typeof message?.content === "string") return message.content ? [textContent(message.content)] : [];
  const output = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (block.type === "thinking" && mode === "lossless") output.push(reasoningContent({ provider: "roo-code", text: block.thinking ?? null, signature: block.signature ?? null, raw: block }));
    else if (block.type === "tool_use") output.push(toolCallContent({ id: block.id ?? null, name: block.name, input: block.input ?? null }));
    else if (block.type === "tool_result") output.push(toolResultContent({ callId: block.tool_use_id ?? null, output: block.content ?? null, isError: Boolean(block.is_error) }));
    else if (block.type === "image" || block.type === "document") { const attachment = anthropicAttachment(block); if (attachment) output.push(attachment); }
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

async function taskFiles(home, taskId) {
  const dir = path.join(home, "tasks", taskId);
  const api = path.join(dir, API_HISTORY);
  const oldApi = path.join(dir, "claude_messages.json");
  const apiPath = await exists(api) ? api : await exists(oldApi) ? oldApi : null;
  return {
    dir,
    api: apiPath,
    ui: await exists(path.join(dir, UI_HISTORY)) ? path.join(dir, UI_HISTORY) : null,
    metadata: await exists(path.join(dir, TASK_METADATA)) ? path.join(dir, TASK_METADATA) : null
  };
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
    return {
      installed: stores.length > 0,
      version: null,
      storageRoots: this.homes,
      detectedStorageRoots: stores,
      sessionStoreExists: stores.length > 0,
      storageFormat: "anthropic-api-history+ui-messages"
    };
  }

  async listSessions() {
    const sessions = [];
    for (const home of this.homes) {
      const root = path.join(home, "tasks");
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const files = await taskFiles(home, entry.name);
        if (!files.api) continue;
        try {
          const messages = await readJson(files.api, []);
          if (!Array.isArray(messages)) continue;
          const metadata = files.metadata ? await readJson(files.metadata, {}) : {};
          const stat = await fs.stat(files.api);
          const firstTs = messages.map((message) => iso(message?.ts)).find(Boolean) ?? null;
          sessions.push({
            adapter: this.id,
            id: entry.name,
            title: titleFromMessages(messages),
            cwd: metadata?.cwd ?? metadata?.workspacePath ?? null,
            path: files.api,
            createdAt: firstTs,
            updatedAt: stat.mtime.toISOString(),
            size: stat.size,
            kind: metadata?.mode ?? "task",
            parentTaskId: metadata?.parentTaskId ?? null,
            rootTaskId: metadata?.rootTaskId ?? null,
            storageRoot: home
          });
        } catch {
          // Ignore malformed or concurrently-written task folders during discovery.
        }
      }
    }
    sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return sessions;
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if ((ref.endsWith(API_HISTORY) || ref.endsWith("claude_messages.json")) && await exists(ref)) {
      const file = path.resolve(ref);
      return { home: path.dirname(path.dirname(file)), taskId: path.basename(path.dirname(file)), files: { ...(await taskFiles(path.dirname(path.dirname(path.dirname(file))), path.basename(path.dirname(file)))), api: file } };
    }
    for (const home of this.homes) {
      const files = await taskFiles(home, ref);
      if (files.api) return { home, taskId: ref, files };
    }
    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.id === ref || session.path === ref);
    if (!match) throw new Error(`Roo Code task not found: ${sessionRef}`);
    const home = match.storageRoot;
    return { home, taskId: match.id, files: await taskFiles(home, match.id) };
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const resolved = await this.resolveSession(sessionRef);
    const nativeMessages = await readJson(resolved.files.api, []);
    if (!Array.isArray(nativeMessages)) throw new Error(`Invalid Roo API history: ${resolved.files.api}`);
    const metadata = resolved.files.metadata ? await readJson(resolved.files.metadata, {}) : {};
    const messages = [];
    const events = [];
    let startedAt = null;
    let updatedAt = null;
    for (let index = 0; index < nativeMessages.length; index += 1) {
      const native = nativeMessages[index];
      const createdAt = iso(native?.ts);
      startedAt ??= createdAt;
      updatedAt = createdAt ?? updatedAt;
      if (mode === "lossless") events.push(rawEvent({ index, provider: this.id, kind: native?.type === "reasoning" ? "api-message:reasoning" : `api-message:${native?.role ?? "unknown"}`, timestamp: createdAt, data: native }));
      const content = contentParts(native, mode);
      if (!content.length) continue;
      messages.push({
        id: native?.id ?? null,
        parentId: null,
        role: native?.type === "reasoning" ? "assistant" : native?.role === "assistant" ? "assistant" : "user",
        createdAt,
        content,
        metadata: {
          isSummary: Boolean(native?.isSummary),
          condenseId: native?.condenseId ?? null,
          condenseParent: native?.condenseParent ?? null,
          truncationId: native?.truncationId ?? null,
          truncationParent: native?.truncationParent ?? null,
          isTruncationMarker: Boolean(native?.isTruncationMarker)
        }
      });
    }
    const apiStat = await fs.stat(resolved.files.api);
    return createPortableSession({
      id: resolved.taskId,
      title: titleFromMessages(nativeMessages),
      cwd: metadata?.cwd ?? metadata?.workspacePath ?? null,
      startedAt,
      updatedAt: updatedAt ?? apiStat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: resolved.taskId, path: resolved.files.api },
      messages,
      agents: [],
      metadata: {
        taskMetadata: metadata,
        uiMessagesPresent: Boolean(resolved.files.ui),
        storageRoot: resolved.home,
        archivedUpstream: true
      },
      events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "roo-code/api-conversation-history-v1",
        rawRecordCount: events.length,
        includesProviderReasoning: nativeMessages.some((message) => message?.type === "reasoning" || Boolean(message?.reasoning_content) || (message?.content ?? []).some?.((block) => block?.type === "thinking")),
        includesUnknownEvents: true,
        companionUiHistory: Boolean(resolved.files.ui),
        companionTaskMetadata: Boolean(resolved.files.metadata)
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const resolved = await this.resolveSession(sessionRef);
    const companions = [];
    if (resolved.files.ui) companions.push({ path: resolved.files.ui, filename: UI_HISTORY, mediaType: "application/json" });
    if (resolved.files.metadata) companions.push({ path: resolved.files.metadata, filename: TASK_METADATA, mediaType: "application/json" });
    return {
      kind: "agent-session",
      format: "roo-code/task-files-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: resolved.files.api,
      filename: API_HISTORY,
      companions,
      cwd: null,
      sessionId: resolved.taskId,
      archivedUpstream: true
    };
  }
}
