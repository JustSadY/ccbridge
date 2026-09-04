import fs from "node:fs/promises";
import { GeminiCliAdapter as BaseGeminiCliAdapter } from "./gemini-base.js";
import { readJsonl } from "../io/jsonl.js";
import { attachmentContent } from "../model.js";

function isMessageRecord(record) { return Boolean(record && typeof record === "object" && typeof record.id === "string"); }
function geminiAttachments(content) {
  const parts = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const output = [];
  for (const part of parts) {
    if (part?.inlineData && typeof part.inlineData === "object" && typeof part.inlineData.data === "string") output.push(attachmentContent({ mimeType: part.inlineData.mimeType ?? "application/octet-stream", data: part.inlineData.data, encoding: "base64", metadata: { geminiType: "inlineData" } }));
    else if (part?.fileData && typeof part.fileData === "object" && typeof part.fileData.fileUri === "string") output.push(attachmentContent({ name: part.fileData.displayName ?? null, mimeType: part.fileData.mimeType ?? "application/octet-stream", uri: part.fileData.fileUri, metadata: { geminiType: "fileData" } }));
  }
  return output;
}
async function nativeMessages(file) {
  if (file.endsWith(".json")) { const parsed = JSON.parse(await fs.readFile(file, "utf8")); return Array.isArray(parsed.messages) ? parsed.messages : []; }
  const messages = new Map();
  for await (const { value: record } of readJsonl(file)) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.$rewindTo === "string") { let found = false; for (const id of [...messages.keys()]) { if (id === record.$rewindTo) found = true; if (found) messages.delete(id); } if (!found) messages.clear(); continue; }
    if (record.$set && typeof record.$set === "object") { if (Array.isArray(record.$set.messages)) { messages.clear(); for (const message of record.$set.messages) if (isMessageRecord(message)) messages.set(message.id, message); } continue; }
    if (isMessageRecord(record)) { messages.set(record.id, record); continue; }
    if (Array.isArray(record.messages)) for (const message of record.messages) if (isMessageRecord(message)) messages.set(message.id, message);
  }
  return [...messages.values()];
}

export class GeminiCliAdapter extends BaseGeminiCliAdapter {
  async readSession(sessionRef, options = {}) {
    const session = await super.readSession(sessionRef, options);
    const file = await this.resolveSession(sessionRef);
    const native = await nativeMessages(file);
    const existing = new Map(session.messages.map((message) => [message.id, message]));
    const merged = [];
    for (const record of native) {
      const attachments = geminiAttachments(record.content);
      const base = existing.get(record.id);
      if (base) { merged.push(attachments.length ? { ...base, content: [...base.content, ...attachments] } : base); continue; }
      if (!attachments.length) continue;
      merged.push({ id: record.id, parentId: null, role: record.type === "user" ? "user" : record.type === "gemini" ? "assistant" : "system", createdAt: record.timestamp ?? null, content: attachments, metadata: { geminiType: record.type ?? null, model: record.model ?? null, tokens: record.tokens ?? null } });
    }
    session.messages = merged;
    return session;
  }
}
