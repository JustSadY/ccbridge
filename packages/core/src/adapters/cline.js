import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

function exists(file) { return fs.access(file).then(() => true).catch(() => false); }
function iso(value) { if (value === null || value === undefined) return null; const date = new Date(typeof value === "number" ? value : String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
function defaultHome(options = {}) { return options.home ?? options.env?.CCBRIDGE_CLINE_HOME ?? process.env.CCBRIDGE_CLINE_HOME ?? path.join(os.homedir(), ".cline"); }

function portableContent(blocks, mode) {
  const output = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (block.type === "thinking" && mode === "lossless") output.push(reasoningContent({ provider: "cline", text: typeof block.thinking === "string" ? block.thinking : null, raw: block }));
    else if (block.type === "tool_use") output.push(toolCallContent({ id: block.id ?? null, name: block.name, input: block.input ?? null }));
    else if (block.type === "tool_result") output.push(toolResultContent({ callId: block.tool_use_id ?? null, output: block.content ?? null, isError: Boolean(block.is_error) }));
  }
  return output;
}

function titleFromMessages(messages) {
  for (const message of messages ?? []) {
    if (message?.role !== "user") continue;
    const block = (message.content ?? []).find((item) => item?.type === "text" && typeof item.text === "string" && item.text.trim());
    if (block) return block.text.trim().slice(0, 100);
  }
  return null;
}

async function loadMessagesFile(file) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  if (parsed?.version !== 1) throw new Error(`Unsupported Cline messages contract version: ${parsed?.version ?? "unknown"}`);
  if (!parsed.sessionId || !Array.isArray(parsed.messages)) throw new Error(`Invalid Cline messages v1 file: ${file}`);
  return parsed;
}

export class ClineAdapter {
  constructor(options = {}) {
    this.id = "cline";
    this.name = "Cline";
    this.aliases = [];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["cline/messages-json-v1"];
    this.home = defaultHome(options);
    this.command = options.command ?? "cline";
    this.runner = options.runner ?? spawnSync;
  }

  get sessionStore() { return path.join(this.home, "data", "sessions"); }

  async detect() {
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    return {
      installed: !result?.error && result?.status === 0,
      version: result?.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
      home: this.home,
      sessionStore: this.sessionStore,
      sessionStoreExists: await exists(this.sessionStore),
      storageFormat: "messages-contract-v1"
    };
  }

  async listSessions() {
    let entries;
    try { entries = await fs.readdir(this.sessionStore, { withFileTypes: true }); }
    catch { return []; }
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const file = path.join(this.sessionStore, entry.name, `${entry.name}.messages.json`);
      if (!await exists(file)) continue;
      try {
        const parsed = await loadMessagesFile(file);
        const stat = await fs.stat(file);
        sessions.push({
          adapter: this.id,
          id: String(parsed.sessionId),
          title: titleFromMessages(parsed.messages),
          cwd: null,
          path: file,
          createdAt: parsed.messages.map((message) => iso(message?.ts)).find(Boolean) ?? null,
          updatedAt: iso(parsed.updated_at) ?? stat.mtime.toISOString(),
          size: stat.size,
          kind: parsed.agent ?? "lead",
          taskType: parsed.taskType ?? null
        });
      } catch {
        // Ignore malformed or concurrently-written session files during discovery.
      }
    }
    sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return sessions;
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".messages.json") && await exists(ref)) return path.resolve(ref);
    const direct = path.join(this.sessionStore, ref, `${ref}.messages.json`);
    if (await exists(direct)) return direct;
    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.id === ref || session.path === ref);
    if (!match) throw new Error(`Cline session not found: ${sessionRef}`);
    return match.path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const file = await this.resolveSession(sessionRef);
    const parsed = await loadMessagesFile(file);
    const stat = await fs.stat(file);
    const messages = [];
    const events = [];
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (let index = 0; index < parsed.messages.length; index += 1) {
      const native = parsed.messages[index];
      if (mode === "lossless") events.push(rawEvent({ index, provider: this.id, kind: `message:${native?.role ?? "unknown"}`, timestamp: iso(native?.ts), data: native }));
      const content = portableContent(native?.content, mode);
      if (!content.length) continue;
      const createdAt = iso(native?.ts);
      firstTimestamp ??= createdAt;
      lastTimestamp = createdAt ?? lastTimestamp;
      messages.push({
        id: native.id ?? null,
        parentId: null,
        role: native.role === "assistant" ? "assistant" : "user",
        createdAt,
        content,
        metadata: {
          modelInfo: native.modelInfo ?? null,
          metrics: native.metrics ?? null
        }
      });
    }
    return createPortableSession({
      id: String(parsed.sessionId),
      title: titleFromMessages(parsed.messages),
      cwd: null,
      startedAt: firstTimestamp,
      updatedAt: iso(parsed.updated_at) ?? lastTimestamp ?? stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: String(parsed.sessionId), path: file },
      messages,
      agents: [],
      metadata: {
        contractVersion: parsed.version,
        agent: parsed.agent ?? null,
        taskType: parsed.taskType ?? null,
        systemPrompt: mode === "lossless" ? parsed.system_prompt ?? null : null
      },
      events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "cline/messages-json-v1",
        rawRecordCount: events.length,
        includesProviderReasoning: parsed.messages.some((message) => (message.content ?? []).some((block) => block?.type === "thinking")),
        includesUnknownEvents: true,
        canonicalReplayArtifact: true
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const file = await this.resolveSession(sessionRef);
    const parsed = await loadMessagesFile(file);
    return {
      kind: "agent-session",
      format: "cline/messages-json-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: file,
      filename: path.basename(file),
      cwd: null,
      sessionId: String(parsed.sessionId)
    };
  }
}
