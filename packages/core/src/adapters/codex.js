import path from "node:path";
import { CodexAdapter as BaseCodexAdapter } from "./codex-base.js";
import { readJsonl } from "../io/jsonl.js";
import { attachmentContent, createPortableSession, normalizeTransferMode, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

function mediaAttachment(url, fallbackMime, metadata = {}) {
  if (typeof url !== "string" || !url) return null;
  const match = url.match(/^data:([^;,]*)(;base64)?,(.*)$/s);
  if (match) return attachmentContent({ mimeType: match[1] || fallbackMime, data: match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64"), encoding: "base64", uri: url, metadata });
  return attachmentContent({ mimeType: fallbackMime, uri: url, metadata });
}
function responseContent(payload, mode) {
  if (!payload || typeof payload !== "object") return [];
  if (payload.type === "message") {
    const parts = [];
    for (const item of payload.content ?? []) {
      if ((item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") parts.push(textContent(item.text));
      else if (item.type === "input_image") { const part = mediaAttachment(item.image_url ?? item.imageUrl, "image/*", { codexType: "input_image", detail: item.detail ?? null }); if (part) parts.push(part); }
      else if (item.type === "input_audio") { const part = mediaAttachment(item.audio_url ?? item.audioUrl, "audio/*", { codexType: "input_audio" }); if (part) parts.push(part); }
    }
    return parts;
  }
  if (payload.type === "function_call") { let input = payload.arguments ?? null; if (typeof input === "string") { try { input = JSON.parse(input); } catch {} } return [toolCallContent({ id: payload.call_id, name: payload.name, input })]; }
  if (payload.type === "function_call_output") return [toolResultContent({ callId: payload.call_id, output: payload.output })];
  if (mode === "lossless" && payload.type === "reasoning") return [reasoningContent({ provider: "codex", text: typeof payload.content === "string" ? payload.content : null, summary: payload.summary ?? null, encrypted: payload.encrypted_content ?? payload.encryptedContent ?? null, raw: payload })];
  return [];
}

export class CodexAdapter extends BaseCodexAdapter {
  async readSession(sessionRef, options = {}) {
    const mode = normalizeTransferMode(options.mode ?? "portable");
    const sessionPath = await this.resolveSession(sessionRef);
    let id = path.basename(sessionPath, ".jsonl"); let cwd = null; let startedAt = null; let updatedAt = null; let title = null; const messages = []; const events = []; let index = 0;
    for await (const { value: record } of readJsonl(sessionPath)) {
      if (mode === "lossless") events.push(rawEvent({ index, provider: this.id, kind: record?.type ?? "unknown", timestamp: record?.timestamp ?? null, data: record }));
      index += 1; startedAt ??= record.timestamp ?? null; updatedAt = record.timestamp ?? updatedAt;
      if (record.type === "session_meta") { id = record.payload?.id ?? record.payload?.session_id ?? id; cwd = record.payload?.cwd ?? cwd; continue; }
      if (record.type !== "response_item") continue;
      const payload = record.payload; const content = responseContent(payload, mode); if (!content.length) continue;
      const role = payload?.type === "reasoning" ? "assistant" : payload?.role === "assistant" ? "assistant" : payload?.role === "user" ? "user" : "tool";
      messages.push({ id: payload?.id ?? payload?.call_id ?? null, parentId: null, role, createdAt: record.timestamp ?? null, content, metadata: {} });
      if (!title && role === "user") { const firstText = content.find((part) => part.type === "text")?.text?.trim(); if (firstText) title = firstText.slice(0, 100); }
    }
    return createPortableSession({ id, title, cwd, startedAt, updatedAt, source: { adapter: this.id, sessionId: id, path: sessionPath }, messages, metadata: {}, events, lossless: mode === "lossless" ? { enabled: true, sourceFormat: "codex/rollout-jsonl", rawRecordCount: events.length, includesProviderReasoning: true, includesUnknownEvents: true } : null });
  }
}
