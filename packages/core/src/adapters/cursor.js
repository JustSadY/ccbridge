import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPortableAgent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";
import { readJsonl } from "../io/jsonl.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const iso = (value) => { if (value == null) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };

function cursorHome(options = {}) {
  if (options.home) return path.resolve(options.home);
  const env = options.env ?? process.env;
  return path.resolve(env.CURSOR_AGENT_HOME ?? path.join(options.userHome ?? os.homedir(), ".cursor"));
}

function parts(record, mode) {
  const output = [];
  for (const block of record?.message?.content ?? []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (block.type === "tool_use") output.push(toolCallContent({ id: block.id ?? null, name: block.name, input: block.input ?? null }));
    else if (block.type === "tool_result") output.push(toolResultContent({ callId: block.tool_use_id ?? block.call_id ?? null, output: block.content ?? block.output ?? null, isError: Boolean(block.is_error) }));
    else if ((block.type === "thinking" || block.type === "reasoning") && mode === "lossless") output.push(reasoningContent({ provider: "cursor", text: block.thinking ?? block.text ?? null, summary: block.summary ?? null, signature: block.signature ?? null, encrypted: block.encrypted_content ?? null, raw: block }));
  }
  return output;
}

function titleFromMessages(messages) {
  return messages.find((message) => message.role === "user")?.content?.find((part) => part.type === "text")?.text?.replace(/<[^>]+>/g, " ").trim().slice(0, 100) ?? null;
}

async function parseTranscript(file, mode, provider = "cursor") {
  const messages = [];
  const events = [];
  let index = 0;
  for await (const { value: record } of readJsonl(file)) {
    if (mode === "lossless") events.push(rawEvent({ index, provider, kind: record?.role ? `message:${record.role}` : record?.type ? `record:${record.type}` : record?.status ? `record:${record.status}` : "record:unknown", timestamp: iso(record?.timestamp ?? record?.ts), data: record }));
    index += 1;
    if (record?.role !== "user" && record?.role !== "assistant") continue;
    const content = parts(record, mode);
    if (!content.length) continue;
    messages.push({ id: record?.id ?? null, parentId: null, role: record.role, createdAt: iso(record?.timestamp ?? record?.ts), content, metadata: {} });
  }
  return { messages, events, rawCount: index };
}

async function subagentsFor(sessionDir, mode) {
  const dir = path.join(sessionDir, "subagents");
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    const parsed = await parseTranscript(file, mode, "cursor");
    agents.push(createPortableAgent({ id: path.basename(entry.name, ".jsonl"), parentId: null, name: path.basename(entry.name, ".jsonl"), kind: "subagent", source: { adapter: "cursor", sessionId: path.basename(entry.name, ".jsonl"), path: file }, messages: parsed.messages, events: parsed.events, metadata: { sourceFormat: "cursor/agent-transcript-jsonl-v1" } }));
  }
  return agents;
}

async function discoverProjectTranscripts(projectDir) {
  const root = path.join(projectDir, "agent-transcripts");
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push({ id: path.basename(entry.name, ".jsonl"), file: path.join(root, entry.name), sessionDir: root, legacyFlat: true });
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const file = path.join(root, id, `${id}.jsonl`);
    if (await exists(file)) found.push({ id, file, sessionDir: path.join(root, id), legacyFlat: false });
  }
  return found;
}

export class CursorAdapter {
  constructor(options = {}) {
    this.id = "cursor";
    this.name = "Cursor";
    this.aliases = ["cursor-agent"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["cursor/agent-transcript-jsonl-v1"];
    this.home = cursorHome(options);
  }

  async detect() {
    const projects = path.join(this.home, "projects");
    return { installed: await exists(projects), version: null, home: this.home, sessionStore: projects, sessionStoreExists: await exists(projects), storageFormat: "agent-transcript-jsonl", metadataDatabase: "state.vscdb (not mutated)" };
  }

  async listSessions() {
    const projectsRoot = path.join(this.home, "projects");
    let projects;
    try { projects = await fs.readdir(projectsRoot, { withFileTypes: true }); } catch { return []; }
    const sessions = [];
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(projectsRoot, project.name);
      for (const item of await discoverProjectTranscripts(projectDir)) {
        try {
          const stat = await fs.stat(item.file);
          const parsed = await parseTranscript(item.file, "portable");
          sessions.push({ adapter: this.id, id: item.id, title: titleFromMessages(parsed.messages), cwd: null, path: item.file, updatedAt: stat.mtime.toISOString(), size: stat.size, projectKey: project.name, legacyFlat: item.legacyFlat, subagents: item.legacyFlat ? 0 : (await subagentsFor(item.sessionDir, "portable")).length });
        } catch {}
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await exists(ref)) {
      const file = path.resolve(ref);
      return { id: path.basename(file, ".jsonl"), file, sessionDir: path.dirname(file), projectKey: path.basename(path.dirname(path.dirname(path.dirname(file)))) };
    }
    const matches = (await this.listSessions()).filter((session) => session.id === ref || session.path === ref);
    if (!matches.length) throw new Error(`Cursor transcript not found: ${sessionRef}`);
    if (matches.length > 1 && !matches.some((item) => item.path === ref)) throw new Error(`Cursor transcript id is ambiguous across projects: ${sessionRef}; pass the full JSONL path`);
    const match = matches[0];
    return { id: match.id, file: match.path, sessionDir: match.legacyFlat ? path.dirname(match.path) : path.dirname(match.path), projectKey: match.projectKey };
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const resolved = await this.resolveSession(sessionRef);
    const parsed = await parseTranscript(resolved.file, mode);
    const stat = await fs.stat(resolved.file);
    const sessionDir = path.dirname(resolved.file);
    const agents = path.basename(sessionDir) === "agent-transcripts" ? [] : await subagentsFor(sessionDir, mode);
    const content = [...parsed.messages.flatMap((message) => message.content), ...agents.flatMap((agent) => agent.messages.flatMap((message) => message.content))];
    const hasToolResult = content.some((part) => part.type === "tool-result");
    const hasReasoning = content.some((part) => part.type === "reasoning");
    return createPortableSession({ id: resolved.id, title: titleFromMessages(parsed.messages), cwd: null, startedAt: null, updatedAt: stat.mtime.toISOString(), source: { adapter: this.id, sessionId: resolved.id, path: resolved.file }, messages: parsed.messages, agents, metadata: { projectKey: resolved.projectKey, transcriptOnly: true, chatMetadataStore: "state.vscdb", toolResultsObserved: hasToolResult }, events: parsed.events, lossless: mode === "lossless" ? { enabled: true, sourceFormat: "cursor/agent-transcript-jsonl-v1", rawRecordCount: parsed.rawCount + agents.reduce((sum, agent) => sum + agent.events.length, 0), includesProviderReasoning: hasReasoning, includesUnknownEvents: true, transcriptMayOmitToolResults: !hasToolResult, transcriptMayOmitReasoning: !hasReasoning } : null });
  }

  async getNativeArtifact(sessionRef) {
    const resolved = await this.resolveSession(sessionRef);
    const companions = [];
    const sessionDir = path.dirname(resolved.file);
    if (path.basename(sessionDir) !== "agent-transcripts") {
      let entries = [];
      try { entries = await fs.readdir(path.join(sessionDir, "subagents"), { withFileTypes: true }); } catch {}
      for (const entry of entries) if (entry.isFile() && entry.name.endsWith(".jsonl")) companions.push({ path: path.join(sessionDir, "subagents", entry.name), filename: `subagents/${entry.name}`, mediaType: "application/x-ndjson" });
    }
    return { kind: "agent-session", format: "cursor/agent-transcript-jsonl-v1", formatVersion: 1, sourceAdapter: this.id, path: resolved.file, filename: path.basename(resolved.file), companions, cwd: null, sessionId: resolved.id, projectKey: resolved.projectKey };
  }
}
