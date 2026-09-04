import fs from "node:fs/promises";
import path from "node:path";
import { ClaudeCodeAdapter as BaseClaudeCodeAdapter } from "./claude-base.js";
import { readJsonl } from "../io/jsonl.js";
import { attachmentContent, createPortableAgent } from "../model.js";

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
async function addAttachments(session, sessionPath) {
  const existing = new Map(session.messages.map((message) => [message.id, message]));
  const ordered = [];
  for await (const { value: record } of readJsonl(sessionPath)) {
    if (record?.type !== "user" && record?.type !== "assistant") continue;
    const additions = attachmentsFromContent(record.message?.content);
    const base = existing.get(record.uuid ?? null);
    if (base) { ordered.push(additions.length ? { ...base, content: [...base.content, ...additions] } : base); continue; }
    if (!additions.length) continue;
    ordered.push({ id: record.uuid ?? null, parentId: record.parentUuid ?? null, role: record.type === "assistant" ? "assistant" : "user", createdAt: record.timestamp ?? null, content: additions, metadata: { compactSummary: Boolean(record.isCompactSummary), sidechain: Boolean(record.isSidechain) } });
  }
  session.messages = ordered;
  return session;
}
async function readJsonIfPresent(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; return { ccbridgeMetaReadError: error.message }; }
}
function agentIdFromPath(file) { return path.basename(file, ".jsonl").replace(/^agent-/, ""); }
function workflowIdFromPath(file) { const match = file.replaceAll("\\", "/").match(/\/workflows\/([^/]+)\//); return match?.[1] ?? null; }
async function findAgentFiles(roots) {
  const output = [];
  const seenDirs = new Set();
  const seenFiles = new Set();
  async function visit(dir) {
    let realDir;
    try { realDir = await fs.realpath(dir); } catch { return; }
    if (seenDirs.has(realDir)) return;
    seenDirs.add(realDir);
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let stat;
      try { stat = entry.isSymbolicLink() ? await fs.stat(full) : null; } catch { continue; }
      if (entry.isDirectory() || stat?.isDirectory()) { await visit(full); continue; }
      if (!(entry.isFile() || stat?.isFile()) || !/^agent-.*\.jsonl$/i.test(entry.name)) continue;
      let realFile;
      try { realFile = await fs.realpath(full); } catch { realFile = full; }
      if (seenFiles.has(realFile)) continue;
      seenFiles.add(realFile);
      output.push(full);
    }
  }
  for (const root of roots) await visit(root);
  return output.sort();
}

export class ClaudeCodeAdapter extends BaseClaudeCodeAdapter {
  async listSessions() {
    const sessions = await super.listSessions();
    return sessions.filter((session) => !session.path.replaceAll("\\", "/").includes("/subagents/"));
  }

  async readSession(sessionRef, options = {}) {
    const session = await super.readSession(sessionRef, options);
    const sessionPath = await this.resolveSession(sessionRef);
    await addAttachments(session, sessionPath);

    const sessionDir = path.dirname(sessionPath);
    const basename = path.basename(sessionPath, ".jsonl");
    const roots = [...new Set([
      path.join(sessionDir, session.id, "subagents"),
      path.join(sessionDir, basename, "subagents")
    ])];
    const agentFiles = await findAgentFiles(roots);
    const agents = [];
    for (const file of agentFiles) {
      const agentId = agentIdFromPath(file);
      const meta = await readJsonIfPresent(file.replace(/\.jsonl$/i, ".meta.json"));
      try {
        const parsed = await super.readSession(file, options);
        await addAttachments(parsed, file);
        const workflowId = workflowIdFromPath(file);
        agents.push(createPortableAgent({
          id: agentId,
          parentId: meta.parentAgentId ?? meta.parent_agent_id ?? meta.parentId ?? null,
          name: meta.agentType ?? meta.subagent_type ?? meta.name ?? null,
          kind: workflowId ? "workflow-subagent" : meta.agentType ?? meta.subagent_type ?? "subagent",
          startedAt: parsed.startedAt,
          updatedAt: parsed.updatedAt,
          source: { adapter: this.id, sessionId: agentId, path: file },
          messages: parsed.messages,
          events: parsed.events,
          metadata: { ...meta, workflowId, nativeSessionId: parsed.id }
        }));
      } catch (error) {
        agents.push(createPortableAgent({ id: agentId, name: meta.agentType ?? meta.subagent_type ?? null, kind: "unparsed-subagent", source: { adapter: this.id, sessionId: agentId, path: file }, messages: [], events: [], metadata: { ...meta, workflowId: workflowIdFromPath(file), readError: error.message } }));
      }
    }
    agents.sort((a, b) => String(a.startedAt ?? a.id).localeCompare(String(b.startedAt ?? b.id)));
    session.agents = agents;
    if (session.lossless) session.lossless.includesSubagents = agents.length > 0;
    return session;
  }
}
