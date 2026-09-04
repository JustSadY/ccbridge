import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const unique = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];
const iso = (value) => { if (value == null) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };

function defaultUserRoots(options = {}) {
  if (Array.isArray(options.userRoots) && options.userRoots.length) return unique(options.userRoots);
  if (options.userRoot) return [path.resolve(options.userRoot)];
  const env = options.env ?? process.env;
  const configured = String(env.CCBRIDGE_VSCODE_CHAT_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  if (configured.length) return unique(configured);
  const home = options.userHome ?? os.homedir();
  const roots = [];
  if (process.platform === "win32") {
    if (env.APPDATA) for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(env.APPDATA, editor, "User"));
  } else if (process.platform === "darwin") {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, "Library", "Application Support", editor, "User"));
  } else {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, ".config", editor, "User"));
    roots.push(path.join(home, ".vscode-server", "data", "User"));
    roots.push(path.join(home, ".vscode-server-insiders", "data", "User"));
  }
  return unique(roots);
}

function applySet(state, keys, value) {
  if (!Array.isArray(keys) || !keys.length) return state;
  let current = state;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") current[key] = typeof keys[i + 1] === "number" ? [] : {};
    current = current[key];
  }
  current[keys.at(-1)] = value;
  return state;
}

function applyPush(state, keys, values, index) {
  if (!Array.isArray(keys) || !keys.length) return state;
  let current = state;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") current[key] = typeof keys[i + 1] === "number" ? [] : {};
    current = current[key];
  }
  const key = keys.at(-1);
  const array = Array.isArray(current[key]) ? current[key] : [];
  if (Number.isInteger(index) && index >= 0) array.length = index;
  if (Array.isArray(values)) array.push(...values);
  current[key] = array;
  return state;
}

export function reconstructVsCodeChatMutationLog(text) {
  let state;
  let count = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const entry = JSON.parse(raw);
    count += 1;
    if (entry.kind === 0) { state = structuredClone(entry.v); continue; }
    if (state === undefined) throw new Error("VS Code chat mutation log is missing an initial entry");
    if (entry.kind === 1) applySet(state, entry.k, entry.v);
    else if (entry.kind === 2) applyPush(state, entry.k, entry.v, entry.i);
    else if (entry.kind === 3) applySet(state, entry.k, undefined);
    else throw new Error(`Unsupported VS Code chat mutation entry kind: ${entry.kind}`);
  }
  if (!count) throw new Error("Empty VS Code chat session log");
  return { state, entryCount: count };
}

async function readStoredSession(file) {
  const text = await fs.readFile(file, "utf8");
  if (file.endsWith(".jsonl")) {
    const reconstructed = reconstructVsCodeChatMutationLog(text);
    return { data: reconstructed.state, raw: text, logEntries: reconstructed.entryCount, storageKind: "mutation-log" };
  }
  return { data: JSON.parse(text), raw: text, logEntries: 1, storageKind: "snapshot" };
}

function stringValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.value === "string") return value.value;
  if (Array.isArray(value.value)) return value.value.map(stringValue).join("");
  if (typeof value.text === "string") return value.text;
  if (typeof value.message === "string") return value.message;
  return "";
}

function requestText(request) {
  if (typeof request?.message === "string") return request.message;
  if (typeof request?.message?.text === "string") return request.message.text;
  return stringValue(request?.message);
}

function toolName(part) { return part?.toolId ?? part?.toolName ?? part?.name ?? "unknown"; }
function toolInput(part) { return part?.input ?? part?.toolInput ?? part?.toolSpecificData?.input ?? part?.toolSpecificData ?? null; }
function toolOutput(part) {
  if (part?.result !== undefined) return part.result;
  if (part?.output !== undefined) return part.output;
  if (part?.toolResult !== undefined) return part.toolResult;
  if (part?.toolSpecificData?.terminalCommandOutput?.text !== undefined) return part.toolSpecificData.terminalCommandOutput.text;
  return undefined;
}

function responseParts(request, mode, rawEvents, eventIndexRef) {
  const output = [];
  const response = Array.isArray(request?.response) ? request.response : request?.response ? [request.response] : [];
  for (const part of response) {
    const kind = part?.kind ?? (typeof part === "string" || typeof part?.value === "string" ? "markdown" : "unknown");
    if (mode === "lossless") rawEvents.push(rawEvent({ index: eventIndexRef.value++, provider: "vscode-chat", kind: `response-part:${kind}`, timestamp: iso(request?.responseTimestamp), data: part }));
    if (kind === "thinking") {
      if (mode === "lossless") output.push(reasoningContent({ provider: "vscode-chat", text: stringValue(part.value), summary: part.generatedTitle ?? null, raw: part }));
      continue;
    }
    if (kind === "toolInvocationSerialized" || kind === "toolInvocation") {
      const callId = part?.toolCallId ?? part?.callId ?? null;
      output.push(toolCallContent({ id: callId, name: toolName(part), input: toolInput(part) }));
      const result = toolOutput(part);
      if (result !== undefined) output.push(toolResultContent({ callId, output: result, isError: Boolean(part?.isError || part?.error) }));
      continue;
    }
    const text = kind === "markdownContent" ? stringValue(part.content) : stringValue(part);
    if (text) output.push(textContent(text));
  }
  return output;
}

function sessionMessages(data, mode) {
  const messages = [];
  const events = [];
  const eventIndexRef = { value: 0 };
  for (const request of Array.isArray(data?.requests) ? data.requests : []) {
    if (mode === "lossless") events.push(rawEvent({ index: eventIndexRef.value++, provider: "vscode-chat", kind: "request", timestamp: iso(request?.timestamp), data: request }));
    const userText = requestText(request);
    if (userText) messages.push({ id: request?.requestId ? `${request.requestId}:user` : null, parentId: null, role: "user", createdAt: iso(request?.timestamp), content: [textContent(userText)], metadata: { requestId: request?.requestId ?? null, modelId: request?.modelId ?? null, agent: request?.agent ?? null, hiddenFromTranscript: Boolean(request?.requestHiddenFromTranscript || request?.hiddenFromTranscript) } });
    const content = responseParts(request, mode, events, eventIndexRef);
    if (content.length) messages.push({ id: request?.responseId ?? (request?.requestId ? `${request.requestId}:assistant` : null), parentId: request?.requestId ? `${request.requestId}:user` : null, role: "assistant", createdAt: iso(request?.responseTimestamp), content, metadata: { requestId: request?.requestId ?? null, modelId: request?.modelId ?? null, result: request?.result ?? null, modelState: request?.modelState ?? null, usage: { promptTokens: request?.promptTokens ?? null, completionTokens: request?.completionTokens ?? null, promptTokenDetails: request?.promptTokenDetails ?? null, copilotCredits: request?.copilotCredits ?? null, modelTotals: request?.modelTotals ?? null } } });
  }
  return { messages, events };
}

function titleFromData(data, messages) {
  return data?.customTitle ?? data?.computedTitle ?? messages.find((message) => message.role === "user")?.content?.[0]?.text?.slice(0, 100) ?? null;
}

async function sessionFilesUnder(root, workspaceKey, scope) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const selected = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".json") && !entry.name.endsWith(".jsonl"))) continue;
    const ext = path.extname(entry.name);
    const id = path.basename(entry.name, ext);
    const candidate = { id, file: path.join(root, entry.name), workspaceKey, scope, storageKind: ext === ".jsonl" ? "mutation-log" : "snapshot" };
    const existing = selected.get(id);
    if (!existing || candidate.storageKind === "mutation-log") selected.set(id, candidate);
  }
  return [...selected.values()];
}

async function discoverFromUserRoot(userRoot) {
  const found = [];
  const workspaceRoot = path.join(userRoot, "workspaceStorage");
  let workspaces = [];
  try { workspaces = await fs.readdir(workspaceRoot, { withFileTypes: true }); } catch {}
  for (const workspace of workspaces) if (workspace.isDirectory()) found.push(...await sessionFilesUnder(path.join(workspaceRoot, workspace.name, "chatSessions"), workspace.name, "workspace"));
  found.push(...await sessionFilesUnder(path.join(userRoot, "globalStorage", "emptyWindowChatSessions"), "empty-window", "empty-window"));
  return found;
}

export class VsCodeChatAdapter {
  constructor(options = {}) {
    this.id = "vscode-chat";
    this.name = "VS Code Chat / GitHub Copilot";
    this.aliases = ["copilot", "github-copilot", "copilot-chat"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["vscode-chat/session-v3"];
    this.userRoots = defaultUserRoots(options);
  }

  async detect() {
    const detected = [];
    for (const root of this.userRoots) if (await exists(path.join(root, "workspaceStorage")) || await exists(path.join(root, "globalStorage", "emptyWindowChatSessions"))) detected.push(root);
    return { installed: detected.length > 0, version: null, userRoots: this.userRoots, detectedUserRoots: detected, sessionStoreExists: detected.length > 0, storageFormat: "vscode-chat-json-or-mutation-log-v3" };
  }

  async listSessions() {
    const sessions = [];
    for (const userRoot of this.userRoots) {
      for (const candidate of await discoverFromUserRoot(userRoot)) {
        try {
          const loaded = await readStoredSession(candidate.file);
          const data = loaded.data;
          if (!data || typeof data !== "object" || !Array.isArray(data.requests)) continue;
          const parsed = sessionMessages(data, "portable");
          const stat = await fs.stat(candidate.file);
          sessions.push({ adapter: this.id, id: data.sessionId ?? candidate.id, title: titleFromData(data, parsed.messages), cwd: typeof data.workingDirectory === "string" ? data.workingDirectory : null, path: candidate.file, createdAt: iso(data.creationDate), updatedAt: stat.mtime.toISOString(), size: stat.size, version: data.version ?? null, workspaceKey: candidate.workspaceKey, scope: candidate.scope, storageKind: loaded.storageKind, userRoot });
        } catch {}
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if ((ref.endsWith(".json") || ref.endsWith(".jsonl")) && await exists(ref)) return { file: path.resolve(ref), id: path.basename(ref, path.extname(ref)), userRoot: null, workspaceKey: null, scope: "direct" };
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.path === ref);
    if (!matches.length) throw new Error(`VS Code Chat session not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((item) => item.path === ref)) throw new Error(`VS Code Chat session id is ambiguous across workspaces: ${sessionRef}; pass the full session file path`);
    const match = matches[0];
    return { file: match.path, id: match.id, userRoot: match.userRoot, workspaceKey: match.workspaceKey, scope: match.scope };
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const resolved = await this.resolveSession(sessionRef);
    const loaded = await readStoredSession(resolved.file);
    const data = loaded.data;
    if (![1, 2, 3].includes(Number(data?.version))) throw new Error(`Unsupported VS Code Chat session version: ${data?.version ?? "missing"}`);
    const parsed = sessionMessages(data, mode);
    const stat = await fs.stat(resolved.file);
    if (mode === "lossless") parsed.events.unshift(rawEvent({ index: -1, provider: this.id, kind: "session-state", timestamp: iso(data.creationDate), data }));
    const content = parsed.messages.flatMap((message) => message.content);
    return createPortableSession({
      id: data.sessionId ?? resolved.id,
      title: titleFromData(data, parsed.messages),
      cwd: typeof data.workingDirectory === "string" ? data.workingDirectory : null,
      startedAt: iso(data.creationDate),
      updatedAt: stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: data.sessionId ?? resolved.id, path: resolved.file },
      messages: parsed.messages,
      agents: [],
      metadata: { version: data.version, initialLocation: data.initialLocation ?? null, responderUsername: data.responderUsername ?? null, workspaceKey: resolved.workspaceKey, scope: resolved.scope, storageKind: loaded.storageKind, logEntries: loaded.logEntries, repoData: data.repoData ?? null, inputState: data.inputState ?? null, pendingRequests: data.pendingRequests ?? null },
      events: parsed.events,
      lossless: mode === "lossless" ? { enabled: true, sourceFormat: `vscode-chat/session-v${data.version}`, rawRecordCount: parsed.events.length, includesProviderReasoning: content.some((part) => part.type === "reasoning"), includesUnknownEvents: true, storageKind: loaded.storageKind, mutationLogEntries: loaded.logEntries } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const resolved = await this.resolveSession(sessionRef);
    const loaded = await readStoredSession(resolved.file);
    const data = loaded.data;
    return { kind: "agent-session", format: `vscode-chat/session-v${data?.version ?? "unknown"}`, formatVersion: data?.version ?? null, sourceAdapter: this.id, path: resolved.file, filename: path.basename(resolved.file), cwd: typeof data?.workingDirectory === "string" ? data.workingDirectory : null, sessionId: data?.sessionId ?? resolved.id, storageKind: loaded.storageKind, workspaceKey: resolved.workspaceKey };
  }
}
