import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJsonl } from "../io/jsonl.js";
import { createPortableSession, textContent, toolCallContent, toolResultContent } from "../model.js";
import { defaultCodexHome } from "../platform/paths.js";
import { CodexAppServerClient } from "../codex/app-server-client.js";
import { pathExists, walkFiles } from "./fs-utils.js";

function responseItemContent(payload) {
  if (!payload || typeof payload !== "object") return [];

  if (payload.type === "message") {
    const parts = [];
    for (const item of payload.content ?? []) {
      if ((item.type === "input_text" || item.type === "output_text") && typeof item.text === "string") {
        parts.push(textContent(item.text));
      }
    }
    return parts;
  }

  if (payload.type === "function_call") {
    let input = payload.arguments ?? null;
    if (typeof input === "string") {
      try { input = JSON.parse(input); } catch { /* keep raw string */ }
    }
    return [toolCallContent({ id: payload.call_id, name: payload.name, input })];
  }

  if (payload.type === "function_call_output") {
    return [toolResultContent({ callId: payload.call_id, output: payload.output })];
  }

  return [];
}

export class CodexAdapter {
  constructor(options = {}) {
    this.id = "codex";
    this.name = "OpenAI Codex";
    this.aliases = ["openai-codex"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: false, nativeImport: true };
    this.nativeImports = ["claude-code/session-jsonl"];
    this.home = options.home ?? defaultCodexHome(options);
    this.command = options.command ?? "codex";
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new CodexAppServerClient(clientOptions));
  }

  async detect() {
    const result = spawnSync(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const sessions = path.join(this.home, "sessions");
    return {
      installed: !result.error && result.status === 0,
      version: result.status === 0 ? String(result.stdout || result.stderr).trim() : null,
      home: this.home,
      sessionStore: sessions,
      sessionStoreExists: await pathExists(sessions)
    };
  }

  async listSessions() {
    const root = path.join(this.home, "sessions");
    const files = await walkFiles(root, (file) => file.endsWith(".jsonl"));
    const sessions = [];

    for (const file of files) {
      const stat = await fs.stat(file);
      const summary = await this.#summarize(file);
      sessions.push({
        adapter: this.id,
        id: summary.id ?? path.basename(file, ".jsonl"),
        title: summary.title,
        cwd: summary.cwd,
        path: file,
        updatedAt: stat.mtime.toISOString(),
        size: stat.size
      });
    }

    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return sessions;
  }

  async readSession(sessionRef) {
    const sessionPath = await this.resolveSession(sessionRef);
    let id = path.basename(sessionPath, ".jsonl");
    let cwd = null;
    let startedAt = null;
    let updatedAt = null;
    let title = null;
    const messages = [];

    for await (const { value: record } of readJsonl(sessionPath)) {
      startedAt ??= record.timestamp ?? null;
      updatedAt = record.timestamp ?? updatedAt;

      if (record.type === "session_meta") {
        id = record.payload?.id ?? record.payload?.session_id ?? id;
        cwd = record.payload?.cwd ?? cwd;
        continue;
      }
      if (record.type !== "response_item") continue;

      const payload = record.payload;
      const content = responseItemContent(payload);
      if (!content.length) continue;
      const role = payload?.role === "assistant" ? "assistant" : payload?.role === "user" ? "user" : "tool";
      const message = {
        id: payload?.id ?? payload?.call_id ?? null,
        parentId: null,
        role,
        createdAt: record.timestamp ?? null,
        content,
        metadata: {}
      };
      messages.push(message);

      if (!title && role === "user") {
        const firstText = content.find((part) => part.type === "text")?.text?.trim();
        if (firstText) title = firstText.slice(0, 100);
      }
    }

    return createPortableSession({
      id,
      title,
      cwd,
      startedAt,
      updatedAt,
      source: { adapter: this.id, sessionId: id, path: sessionPath },
      messages,
      metadata: {}
    });
  }

  async acceptsNativeArtifact(artifact) {
    return artifact?.format === "claude-code/session-jsonl" && Boolean(artifact.path);
  }

  async importNativeArtifact(artifact, options = {}) {
    if (!await this.acceptsNativeArtifact(artifact)) {
      throw new Error(`Codex cannot natively import artifact format: ${artifact?.format ?? artifact?.kind ?? "unknown"}`);
    }

    const cwd = options.cwd ?? artifact.cwd;
    if (!cwd) throw new Error("A cwd is required to import an external session into Codex");
    if (options.dryRun) {
      return { dryRun: true, target: this.id, artifact, cwd };
    }

    const client = this.clientFactory({ command: this.command, cwd });
    await client.start();
    try {
      const completed = client.waitForNotification("externalAgentConfig/import/completed");
      const result = await client.request("externalAgentConfig/import", {
        migrationItems: [
          {
            itemType: "SESSIONS",
            description: `Import session ${path.basename(artifact.path)}`,
            details: {
              agents: [],
              commands: [],
              skills: [],
              plugins: [],
              sessions: [{ path: artifact.path, cwd, title: null }],
              mcpServers: []
            }
          }
        ],
        source: "ccbridge"
      });
      const completion = await completed;
      return { target: this.id, result, completion, cwd };
    } finally {
      await client.close();
    }
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await pathExists(ref)) return path.resolve(ref);
    const sessions = await this.listSessions();
    const exact = sessions.find((session) => session.id === ref || session.path === ref);
    if (!exact) throw new Error(`Codex session not found: ${sessionRef}`);
    return exact.path;
  }

  async #summarize(sessionPath) {
    let id = null;
    let cwd = null;
    let title = null;
    let seen = 0;

    for await (const { value: record } of readJsonl(sessionPath)) {
      seen += 1;
      if (record.type === "session_meta") {
        id = record.payload?.id ?? record.payload?.session_id ?? id;
        cwd = record.payload?.cwd ?? cwd;
      } else if (!title && record.type === "response_item" && record.payload?.type === "message" && record.payload?.role === "user") {
        const parts = responseItemContent(record.payload);
        const text = parts.find((part) => part.type === "text")?.text?.trim();
        if (text) title = text.slice(0, 100);
      }
      if (id && cwd && title && seen >= 20) break;
    }
    return { id, cwd, title };
  }
}
