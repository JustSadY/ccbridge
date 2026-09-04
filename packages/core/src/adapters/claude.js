import path from "node:path";
import { ClaudeCodeAdapter as BaseClaudeCodeAdapter } from "./claude-base.js";
import { readJsonl } from "../io/jsonl.js";
import { attachmentContent } from "../model.js";

function claudeAttachment(item) {
  const source = item?.source;
  if (!source || typeof source !== "object") return null;
  const name = item.name ?? item.filename ?? source.name ?? null;
  const mimeType = source.media_type ?? item.media_type ?? item.mime_type ?? (item.type === "image" ? "image/*" : "application/octet-stream");
  if (source.type === "base64" && typeof source.data === "string") return attachmentContent({ name, mimeType, data: source.data, encoding: "base64", metadata: { claudeType: item.type } });
  if (source.type === "text" && typeof source.data === "string") return attachmentContent({ name, mimeType: source.media_type ?? "text/plain", data: source.data, encoding: "utf8", metadata: { claudeType: item.type } });
  if (source.type === "url" && typeof source.url === "string") return attachmentContent({ name, mimeType, uri: source.url, metadata: { claudeType: item.type } });
  if (source.type === "file" && typeof (source.path ?? source.file_path) === "string") { const filePath = source.path ?? source.file_path; return attachmentContent({ name: name ?? path.basename(filePath), mimeType, path: filePath, metadata: { claudeType: item.type } }); }
  return null;
}
function attachmentsFromContent(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((item) => item?.type === "image" || item?.type === "document").map(claudeAttachment).filter(Boolean);
}

export class ClaudeCodeAdapter extends BaseClaudeCodeAdapter {
  async readSession(sessionRef, options = {}) {
    const session = await super.readSession(sessionRef, options);
    const sessionPath = await this.resolveSession(sessionRef);
    const existing = new Map(session.messages.map((message) => [message.id, message]));
    const ordered = [];
    for await (const { value: record } of readJsonl(sessionPath)) {
      if (record?.type !== "user" && record?.type !== "assistant") continue;
      const additions = attachmentsFromContent(record.message?.content);
      const base = existing.get(record.uuid ?? null);
      if (base) { ordered.push(additions.length ? { ...base, content: [...base.content, ...additions] } : base); continue; }
      if (!additions.length) continue;
      ordered.push({
        id: record.uuid ?? null,
        parentId: record.parentUuid ?? null,
        role: record.type === "assistant" ? "assistant" : "user",
        createdAt: record.timestamp ?? null,
        content: additions,
        metadata: { compactSummary: Boolean(record.isCompactSummary), sidechain: Boolean(record.isSidechain) }
      });
    }
    session.messages = ordered;
    return session;
  }
}
