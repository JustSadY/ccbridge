import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { OpenCodeAdapter as BaseOpenCodeAdapter } from "./opencode-base.js";
import { attachmentContent } from "../model.js";

function iso(value) { if (value === undefined || value === null) return null; const date = new Date(typeof value === "number" ? value : String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function epoch(value, fallback = Date.now()) { const parsed = value ? new Date(value).getTime() : NaN; return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback; }
function id(prefix) { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }
function outputString(value) { if (typeof value === "string") return value; try { return JSON.stringify(value); } catch { return String(value); } }
function inputObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : { value: value ?? null }; }
function providerFor(session) { const adapter = session.source?.adapter; if (adapter === "claude-code") return { providerID: "anthropic", modelID: "imported-claude" }; if (adapter === "codex") return { providerID: "openai", modelID: "imported-codex" }; if (adapter === "gemini-cli") return { providerID: "google", modelID: "imported-gemini" }; return { providerID: "ccbridge", modelID: "imported-session" }; }
function isAttachment(part) { return ["attachment", "file", "image", "document", "audio", "video"].includes(part?.type); }
function parseDataUrl(uri) {
  const match = typeof uri === "string" ? uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s) : null;
  if (!match) return null;
  return { mimeType: match[1] || "application/octet-stream", data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64") };
}
function openCodeAttachment(part) {
  const inline = parseDataUrl(part?.url);
  if (inline) return attachmentContent({ name: part.filename ?? null, mimeType: part.mime ?? inline.mimeType, data: inline.data, encoding: "base64", uri: part.url, metadata: { source: part.source ?? null } });
  let filePath = null;
  if (part?.source?.type === "file" && part.source.path) filePath = part.source.path;
  else if (typeof part?.url === "string" && part.url.startsWith("file://")) { try { filePath = fileURLToPath(part.url); } catch {} }
  return attachmentContent({ name: part?.filename ?? (filePath ? path.basename(filePath) : null), mimeType: part?.mime ?? "application/octet-stream", path: filePath, uri: filePath ? null : part?.url ?? null, metadata: { source: part?.source ?? null } });
}
async function attachmentUrl(part) {
  const mime = part?.mimeType ?? part?.mime ?? "application/octet-stream";
  if (typeof part?.data === "string") {
    const bytes = Buffer.from(part.data, part.encoding === "base64" ? "base64" : "utf8");
    return `data:${mime};base64,${bytes.toString("base64")}`;
  }
  if (part?.path) return `data:${mime};base64,${(await fs.readFile(path.resolve(part.path))).toString("base64")}`;
  if (typeof part?.uri === "string" && part.uri.startsWith("file://")) return `data:${mime};base64,${(await fs.readFile(fileURLToPath(part.uri))).toString("base64")}`;
  return part?.uri ?? null;
}
async function portableToOpenCode(session, cwd) {
  const sessionID = id("ses"); const created = epoch(session.startedAt); const updated = epoch(session.updatedAt, created); const model = providerFor(session); const resultByCall = new Map(); for (const message of session.messages ?? []) for (const part of message.content ?? []) if (part?.type === "tool-result" && part.callId) resultByCall.set(part.callId, part);
  const messages = []; let lastUserID = null; let pendingSystem = []; let tick = created;
  const pushSyntheticUser = () => { const messageID = id("msg"); messages.push({ info: { id: messageID, sessionID, role: "user", time: { created: tick++ }, agent: "build", model }, parts: [{ id: id("prt"), sessionID, messageID, type: "text", text: "Imported conversation context", synthetic: true, metadata: { ccbridgeSynthetic: true } }] }); lastUserID = messageID; };
  for (const message of session.messages ?? []) {
    const messageTime = epoch(message.createdAt, tick++);
    if (message.role === "system") { pendingSystem.push(...(message.content ?? []).filter((part) => part.type === "text").map((part) => part.text)); continue; }
    if (message.role === "tool") continue;
    const messageID = id("msg"); const parts = [];
    for (const part of message.content ?? []) {
      if (part?.type === "text") parts.push({ id: id("prt"), sessionID, messageID, type: "text", text: String(part.text ?? ""), metadata: message.id ? { ccbridgeOriginalMessageId: message.id } : undefined });
      else if (isAttachment(part)) { const url = await attachmentUrl(part); if (url) parts.push({ id: id("prt"), sessionID, messageID, type: "file", mime: part.mimeType ?? part.mime ?? "application/octet-stream", filename: part.name ?? part.filename ?? undefined, url }); }
      else if (part?.type === "tool-call" && message.role === "assistant") { const callID = String(part.id ?? id("call")); const result = resultByCall.get(part.id); let state; if (result?.isError) state = { status: "error", input: inputObject(part.input), error: outputString(result.output), metadata: {}, time: { start: messageTime, end: messageTime } }; else if (result) state = { status: "completed", input: inputObject(part.input), output: outputString(result.output), title: String(part.name ?? "tool"), metadata: {}, time: { start: messageTime, end: messageTime } }; else state = { status: "pending", input: inputObject(part.input), raw: outputString(part.input ?? {}) }; parts.push({ id: id("prt"), sessionID, messageID, type: "tool", callID, tool: String(part.name ?? "unknown"), state, metadata: { ccbridgeOriginalCallId: part.id ?? null } }); }
    }
    if (!parts.length) continue;
    if (message.role === "user") { const info = { id: messageID, sessionID, role: "user", time: { created: messageTime }, agent: "build", model }; if (pendingSystem.length) { info.system = pendingSystem.join("\n\n"); pendingSystem = []; } messages.push({ info, parts }); lastUserID = messageID; continue; }
    if (message.role === "assistant") { if (!lastUserID) pushSyntheticUser(); messages.push({ info: { id: messageID, sessionID, role: "assistant", time: { created: messageTime, completed: messageTime }, parentID: lastUserID, modelID: model.modelID, providerID: model.providerID, mode: "build", agent: "build", path: { cwd, root: cwd }, cost: 0, tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" }, parts }); }
  }
  return { info: { id: sessionID, slug: `ccbridge-${session.source?.adapter ?? "session"}-${sessionID.slice(-8)}`, projectID: "ccbridge", directory: cwd, title: session.title || `Imported ${session.source?.adapter ?? "session"} session`, version: "ccbridge-import-v1", metadata: { ccbridgeSourceAdapter: session.source?.adapter ?? null, ccbridgeSourceSessionId: session.source?.sessionId ?? session.id }, time: { created, updated } }, messages };
}

export class OpenCodeAdapter extends BaseOpenCodeAdapter {
  constructor(options = {}) { super(options); this.portableSupport = { ...this.portableSupport, attachment: true, metadata: false }; }
  #runExport(sessionRef) {
    const result = this.runner(this.command, ["export", String(sessionRef)], { encoding: "utf8", windowsHide: true });
    if (result?.error || result?.status !== 0) throw new Error(`${this.command} export ${sessionRef} failed: ${String(result?.stderr || result?.error?.message || "unknown error").trim()}`);
    const data = JSON.parse(String(result.stdout ?? ""));
    if (!data?.info || !Array.isArray(data.messages)) throw new Error("OpenCode export returned an unsupported JSON shape");
    return data;
  }
  async readSession(sessionRef, options = {}) {
    const session = await super.readSession(sessionRef, options);
    const data = this.#runExport(sessionRef);
    const existing = new Map(session.messages.map((message) => [message.id, message]));
    const merged = [];
    for (const item of data.messages) {
      const info = item?.info ?? {};
      const attachments = (item?.parts ?? []).filter((part) => part?.type === "file").map(openCodeAttachment);
      const base = existing.get(info.id);
      if (base) { merged.push({ ...base, content: [...base.content, ...attachments] }); continue; }
      if (!attachments.length) continue;
      merged.push({ id: info.id ?? null, parentId: info.parentID ?? null, role: info.role === "assistant" ? "assistant" : info.role === "user" ? "user" : info.role ?? "system", createdAt: iso(info.time?.created), content: attachments, metadata: options.mode === "lossless" ? { model: info.model ?? null, agent: info.agent ?? null } : {} });
    }
    session.messages = merged;
    return session;
  }
  async writePortableSession(session, options = {}) {
    if (!session || !Array.isArray(session.messages)) throw new Error("OpenCode portable import requires a PortableSession");
    if (session.lossless?.nativeOnly || session.metadata?.nativeOnly) throw new Error("OpenCode cannot semantically import a native-only session");
    const cwd = path.resolve(options.cwd ?? session.cwd ?? process.cwd());
    const data = await portableToOpenCode(session, cwd);
    return this.importNativeArtifact({ kind: "agent-session", format: "opencode/session-json", formatVersion: 1, sourceAdapter: "ccbridge", content: `${JSON.stringify(data, null, 2)}\n`, encoding: "utf8", filename: `ccbridge-${data.info.id}.json`, cwd, sessionId: data.info.id }, { cwd });
  }
}
