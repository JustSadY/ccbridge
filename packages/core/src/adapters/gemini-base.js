import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import { defaultGeminiHome } from "../platform/paths.js";
import { pathExists, walkFiles } from "./fs-utils.js";

function isMessageRecord(record) {
  return Boolean(record && typeof record === "object" && typeof record.id === "string");
}

function contentParts(content) {
  if (typeof content === "string") return content ? [textContent(content)] : [];
  const parts = Array.isArray(content) ? content : content && typeof content === "object" ? [content] : [];
  const output = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      output.push(textContent(part.text));
    } else if (part.functionCall && typeof part.functionCall === "object") {
      output.push(toolCallContent({
        id: part.functionCall.id ?? null,
        name: part.functionCall.name,
        input: part.functionCall.args ?? null
      }));
    } else if (part.functionResponse && typeof part.functionResponse === "object") {
      output.push(toolResultContent({
        callId: part.functionResponse.id ?? null,
        output: part.functionResponse.response ?? part.functionResponse
      }));
    }
  }
  return output;
}

function portableMessage(record, options = {}) {
  const output = contentParts(record.content);
  const knownCallIds = new Set(output.filter((part) => part.type === "tool-call" && part.id).map((part) => part.id));

  for (const call of record.toolCalls ?? []) {
    if (!knownCallIds.has(call.id)) {
      output.push(toolCallContent({ id: call.id, name: call.name, input: call.args }));
    }
    if (call.result !== undefined && call.result !== null) {
      output.push(toolResultContent({
        callId: call.id,
        output: call.result,
        isError: call.status === "error" || call.status === "failed"
      }));
    }
  }

  if (options.mode === "lossless") {
    for (const thought of record.thoughts ?? []) {
      output.push(reasoningContent({
        provider: "gemini-cli",
        text: typeof thought?.description === "string" ? thought.description : null,
        summary: thought?.subject ?? null,
        raw: thought
      }));
    }
  }

  if (!output.length) return null;
  const role = record.type === "user" ? "user" : record.type === "gemini" ? "assistant" : "system";
  return {
    id: record.id ?? null,
    parentId: null,
    role,
    createdAt: record.timestamp ?? null,
    content: output,
    metadata: {
      geminiType: record.type ?? null,
      model: record.model ?? null,
      tokens: record.tokens ?? null
    }
  };
}

function firstText(message) {
  return message?.content?.find((part) => part.type === "text")?.text?.trim() ?? "";
}

async function loadConversation(file) {
  if (file.endsWith(".json")) {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      metadata: parsed,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      rawRecords: [parsed]
    };
  }

  let metadata = {};
  const messages = new Map();
  const rawRecords = [];

  for await (const { value: record } of readJsonl(file)) {
    if (!record || typeof record !== "object") continue;
    rawRecords.push(record);

    if (typeof record.$rewindTo === "string") {
      let found = false;
      for (const id of [...messages.keys()]) {
        if (id === record.$rewindTo) found = true;
        if (found) messages.delete(id);
      }
      if (!found) messages.clear();
      continue;
    }

    if (record.$set && typeof record.$set === "object") {
      if (Array.isArray(record.$set.messages)) {
        messages.clear();
        for (const message of record.$set.messages) {
          if (isMessageRecord(message)) messages.set(message.id, message);
        }
      }
      metadata = { ...metadata, ...record.$set };
      continue;
    }

    if (isMessageRecord(record)) {
      messages.set(record.id, record);
      continue;
    }

    if (typeof record.sessionId === "string" && typeof record.projectHash === "string") {
      metadata = { ...metadata, ...record };
      if (Array.isArray(record.messages)) {
        for (const message of record.messages) {
          if (isMessageRecord(message)) messages.set(message.id, message);
        }
      }
    }
  }

  return { metadata, messages: [...messages.values()], rawRecords };
}

export class GeminiCliAdapter {
  constructor(options = {}) {
    this.id = "gemini-cli";
    this.name = "Gemini CLI";
    this.aliases = ["gemini"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: false, nativeImport: false, losslessRead: true };
    this.home = options.home ?? defaultGeminiHome(options);
    this.command = options.command ?? "gemini";
  }

  async detect() {
    const result = spawnSync(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const sessionStore = path.join(this.home, "tmp");
    return {
      installed: !result.error && result.status === 0,
      version: result.status === 0 ? String(result.stdout || result.stderr).trim() : null,
      home: this.home,
      sessionStore,
      sessionStoreExists: await pathExists(sessionStore)
    };
  }

  async listSessions() {
    const root = path.join(this.home, "tmp");
    const files = await walkFiles(root, (file) => {
      const normalized = file.replaceAll("\\", "/");
      return normalized.includes("/chats/") && (file.endsWith(".jsonl") || file.endsWith(".json"));
    });
    const sessions = [];

    for (const file of files) {
      try {
        const stat = await fs.stat(file);
        const { metadata, messages } = await loadConversation(file);
        if (!metadata.sessionId) continue;
        const firstUser = messages.map((message) => portableMessage(message)).find((message) => message?.role === "user");
        sessions.push({
          adapter: this.id,
          id: metadata.sessionId,
          title: firstText(firstUser) || metadata.summary || null,
          cwd: null,
          path: file,
          updatedAt: metadata.lastUpdated ?? stat.mtime.toISOString(),
          size: stat.size,
          projectHash: metadata.projectHash ?? null,
          kind: metadata.kind ?? "main"
        });
      } catch {
        // Ignore malformed or concurrently-written session files during discovery.
      }
    }

    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return sessions;
  }

  async readSession(sessionRef, options = {}) {
    const mode = normalizeTransferMode(options.mode ?? "portable");
    const sessionPath = await this.resolveSession(sessionRef);
    const { metadata, messages: nativeMessages, rawRecords } = await loadConversation(sessionPath);
    const messages = nativeMessages.map((message) => portableMessage(message, { mode })).filter(Boolean);
    const firstUser = messages.find((message) => message.role === "user");
    const id = metadata.sessionId ?? path.basename(sessionPath, path.extname(sessionPath));
    const events = mode === "lossless"
      ? rawRecords.map((record, index) => rawEvent({
          index,
          provider: this.id,
          kind: typeof record.$rewindTo === "string"
            ? "rewind"
            : record.$set
              ? "metadata-update"
              : record.type ?? "metadata",
          timestamp: record.timestamp ?? record.lastUpdated ?? null,
          data: record
        }))
      : [];

    return createPortableSession({
      id,
      title: firstText(firstUser) || metadata.summary || null,
      cwd: null,
      startedAt: metadata.startTime ?? null,
      updatedAt: metadata.lastUpdated ?? null,
      source: { adapter: this.id, sessionId: id, path: sessionPath },
      messages,
      metadata: {
        projectHash: metadata.projectHash ?? null,
        directories: metadata.directories ?? [],
        kind: metadata.kind ?? "main",
        summary: metadata.summary ?? null
      },
      events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: sessionPath.endsWith(".jsonl") ? "gemini-cli/session-jsonl" : "gemini-cli/session-json",
        rawRecordCount: events.length,
        includesProviderReasoning: true,
        includesRewoundHistory: true,
        includesUnknownEvents: true
      } : null
    });
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if ((ref.endsWith(".jsonl") || ref.endsWith(".json")) && await pathExists(ref)) {
      return path.resolve(ref);
    }

    const sessions = await this.listSessions();
    const exact = sessions.find((session) => session.id === ref || session.path === ref);
    if (!exact) throw new Error(`Gemini CLI session not found: ${sessionRef}`);
    return exact.path;
  }
}
