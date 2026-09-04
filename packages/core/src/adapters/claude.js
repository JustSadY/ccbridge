import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "../io/jsonl.js";
import {
  createPortableSession,
  normalizeTransferMode,
  rawEvent,
  reasoningContent,
  textContent,
  toolCallContent,
  toolResultContent
} from "../model.js";
import { defaultClaudeHome } from "../platform/paths.js";
import { pathExists, walkFiles } from "./fs-utils.js";

function flattenClaudeContent(content, options = {}) {
  if (typeof content === "string") {
    return content ? [textContent(content)] : [];
  }
  if (!Array.isArray(content)) return [];

  const lossless = options.mode === "lossless";
  const output = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      output.push(textContent(item.text));
    } else if (item.type === "tool_use") {
      output.push(toolCallContent({ id: item.id, name: item.name, input: item.input }));
    } else if (item.type === "tool_result") {
      output.push(toolResultContent({
        callId: item.tool_use_id,
        output: item.content ?? null,
        isError: item.is_error ?? false
      }));
    } else if (lossless && item.type === "thinking") {
      output.push(reasoningContent({
        provider: "claude-code",
        text: typeof item.thinking === "string" ? item.thinking : null,
        signature: item.signature ?? null,
        raw: item
      }));
    }
  }
  return output;
}

function messageText(message) {
  return (message?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export class ClaudeCodeAdapter {
  constructor(options = {}) {
    this.id = "claude-code";
    this.name = "Claude Code";
    this.aliases = ["claude", "cc"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["claude-code/session-jsonl"];
    this.home = options.home ?? defaultClaudeHome(options);
  }

  async detect() {
    const projects = path.join(this.home, "projects");
    return {
      installed: await pathExists(this.home),
      sessionStore: projects,
      sessionStoreExists: await pathExists(projects)
    };
  }

  async listSessions() {
    const root = path.join(this.home, "projects");
    const files = await walkFiles(root, (file) => file.endsWith(".jsonl"));
    const sessions = [];

    for (const file of files) {
      const stat = await fs.stat(file);
      const summary = await this.#summarize(file);
      sessions.push({
        adapter: this.id,
        id: summary.sessionId ?? path.basename(file, ".jsonl"),
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

  async readSession(sessionRef, options = {}) {
    const mode = normalizeTransferMode(options.mode ?? "portable");
    const sessionPath = await this.resolveSession(sessionRef);
    const messages = [];
    const events = [];
    let sessionId = path.basename(sessionPath, ".jsonl");
    let cwd = null;
    let startedAt = null;
    let updatedAt = null;
    let gitBranch = null;
    let claudeVersion = null;
    let title = null;
    let index = 0;

    for await (const { value: record } of readJsonl(sessionPath)) {
      if (mode === "lossless") {
        events.push(rawEvent({
          index,
          provider: this.id,
          kind: record?.type ?? "unknown",
          timestamp: record?.timestamp ?? null,
          data: record
        }));
      }
      index += 1;

      sessionId = record.sessionId ?? sessionId;
      cwd = record.cwd ?? cwd;
      gitBranch = record.gitBranch ?? gitBranch;
      claudeVersion = record.version ?? claudeVersion;
      startedAt ??= record.timestamp ?? null;
      updatedAt = record.timestamp ?? updatedAt;

      if (record.type !== "user" && record.type !== "assistant") continue;
      const content = flattenClaudeContent(record.message?.content, { mode });
      if (content.length === 0) continue;

      const role = record.type === "assistant" ? "assistant" : "user";
      const message = {
        id: record.uuid ?? null,
        parentId: record.parentUuid ?? null,
        role,
        createdAt: record.timestamp ?? null,
        content,
        metadata: {
          compactSummary: Boolean(record.isCompactSummary),
          sidechain: Boolean(record.isSidechain)
        }
      };
      messages.push(message);
      if (!title && role === "user") {
        const first = messageText(message);
        if (first) title = first.slice(0, 100);
      }
    }

    return createPortableSession({
      id: sessionId,
      title,
      cwd,
      startedAt,
      updatedAt,
      source: { adapter: this.id, sessionId, path: sessionPath },
      messages,
      metadata: { gitBranch, claudeVersion },
      events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "claude-code/session-jsonl",
        rawRecordCount: events.length,
        includesProviderReasoning: true,
        includesUnknownEvents: true
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const sessionPath = await this.resolveSession(sessionRef);
    const summary = await this.#summarize(sessionPath);
    return {
      kind: "agent-session",
      format: "claude-code/session-jsonl",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: sessionPath,
      cwd: summary.cwd,
      sessionId: summary.sessionId ?? path.basename(sessionPath, ".jsonl")
    };
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".jsonl") && await pathExists(ref)) return path.resolve(ref);

    const sessions = await this.listSessions();
    const exact = sessions.find((session) => session.id === ref || session.path === ref);
    if (!exact) throw new Error(`Claude session not found: ${sessionRef}`);
    return exact.path;
  }

  async #summarize(sessionPath) {
    let sessionId = null;
    let cwd = null;
    let title = null;
    let seen = 0;

    for await (const { value: record } of readJsonl(sessionPath)) {
      seen += 1;
      sessionId = record.sessionId ?? sessionId;
      cwd = record.cwd ?? cwd;
      if (!title && record.type === "user") {
        const text = messageText({ content: flattenClaudeContent(record.message?.content) });
        if (text) title = text.slice(0, 100);
      }
      if (sessionId && cwd && title && seen >= 20) break;
    }
    return { sessionId, cwd, title };
  }
}
