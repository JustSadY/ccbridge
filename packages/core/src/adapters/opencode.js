import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

function iso(value) {
  if (value === undefined || value === null) return null;
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function runError(command, args, result) {
  const detail = String(result?.stderr || result?.stdout || result?.error?.message || "unknown error").trim();
  return new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
}

export class OpenCodeAdapter {
  constructor(options = {}) {
    this.id = "opencode";
    this.name = "OpenCode";
    this.aliases = ["open-code", "oc"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: true, losslessRead: true };
    this.nativeExports = ["opencode/session-json"];
    this.nativeImports = ["opencode/session-json"];
    this.command = options.command ?? "opencode";
    this.runner = options.runner ?? spawnSync;
  }

  #run(args, options = {}) {
    const result = this.runner(this.command, args, { encoding: "utf8", windowsHide: true, ...options });
    if (result?.error || result?.status !== 0) throw runError(this.command, args, result);
    return String(result.stdout ?? "");
  }

  async detect() {
    try { return { installed: true, version: this.#run(["--version"]).trim() }; }
    catch (error) { return { installed: false, version: null, error: error.message }; }
  }

  async listSessions() {
    const stdout = this.#run(["session", "list", "--format", "json"]);
    if (!stdout.trim()) return [];
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error("OpenCode session list did not return a JSON array");
    return rows.map((row) => ({ adapter: this.id, id: String(row.id), title: row.title ?? null, cwd: row.directory ?? null, path: null, updatedAt: iso(row.updated), createdAt: iso(row.created), projectId: row.projectId ?? null }));
  }

  async #exportData(sessionRef) {
    const stdout = this.#run(["export", String(sessionRef)]);
    const parsed = JSON.parse(stdout);
    if (!parsed?.info || !Array.isArray(parsed.messages)) throw new Error("OpenCode export returned an unsupported JSON shape");
    return { data: parsed, raw: stdout };
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const { data } = await this.#exportData(sessionRef);
    const messages = [];
    const events = [];
    let eventIndex = 0;
    if (mode === "lossless") events.push(rawEvent({ index: eventIndex++, provider: this.id, kind: "session-info", timestamp: iso(data.info?.time?.created), data: data.info }));

    for (const item of data.messages) {
      const info = item?.info ?? {};
      const content = [];
      if (mode === "lossless") events.push(rawEvent({ index: eventIndex++, provider: this.id, kind: "message-info", timestamp: iso(info.time?.created), data: info }));
      for (const part of item?.parts ?? []) {
        if (mode === "lossless") events.push(rawEvent({ index: eventIndex++, provider: this.id, kind: `part:${part?.type ?? "unknown"}`, timestamp: iso(part?.time?.start), data: part }));
        if (part?.type === "text" && typeof part.text === "string") content.push(textContent(part.text));
        else if (part?.type === "reasoning" && mode === "lossless") content.push(reasoningContent({ provider: this.id, text: part.text ?? null, raw: part }));
        else if (part?.type === "tool") {
          content.push(toolCallContent({ id: part.callID ?? part.id, name: part.tool, input: part.state?.input ?? null }));
          if (part.state?.status === "completed") content.push(toolResultContent({ callId: part.callID ?? part.id, output: part.state.output, isError: false }));
          else if (part.state?.status === "error") content.push(toolResultContent({ callId: part.callID ?? part.id, output: part.state.error, isError: true }));
        }
      }
      if (!content.length) continue;
      messages.push({ id: info.id ?? null, parentId: info.parentID ?? null, role: info.role === "assistant" ? "assistant" : info.role === "user" ? "user" : info.role ?? "system", createdAt: iso(info.time?.created), content, metadata: mode === "lossless" ? { model: info.model ?? null, agent: info.agent ?? null } : {} });
    }

    const info = data.info;
    return createPortableSession({
      id: info.id ?? String(sessionRef),
      title: info.title ?? null,
      cwd: info.directory ?? null,
      startedAt: iso(info.time?.created),
      updatedAt: iso(info.time?.updated),
      source: { adapter: this.id, sessionId: info.id ?? String(sessionRef), path: null },
      messages,
      metadata: { projectId: info.projectID ?? null, summary: info.summary ?? null },
      events,
      lossless: mode === "lossless" ? { enabled: true, sourceFormat: "opencode/session-json", rawRecordCount: events.length, includesProviderReasoning: events.some((event) => event.kind === "part:reasoning"), includesUnknownEvents: true } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const { data, raw } = await this.#exportData(sessionRef);
    return { kind: "agent-session", format: "opencode/session-json", formatVersion: 1, sourceAdapter: this.id, content: raw, encoding: "utf8", filename: `opencode-${data.info?.id ?? String(sessionRef)}.json`, cwd: data.info?.directory ?? null, sessionId: data.info?.id ?? String(sessionRef) };
  }

  async acceptsNativeArtifact(artifact) {
    return artifact?.format === "opencode/session-json" && Boolean(artifact.path || artifact.content);
  }

  async importNativeArtifact(artifact, options = {}) {
    if (!await this.acceptsNativeArtifact(artifact)) throw new Error(`OpenCode cannot import native format: ${artifact?.format ?? "unknown"}`);
    let file = artifact.path ? path.resolve(artifact.path) : null;
    let root = null;
    if (!file) {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-opencode-"));
      file = path.join(root, artifact.filename ?? "session.json");
      await fs.writeFile(file, String(artifact.content), { mode: 0o600 });
    }
    try {
      const stdout = this.#run(["import", file], { cwd: options.cwd ?? artifact.cwd ?? process.cwd() });
      const match = stdout.match(/Imported session:\s*(\S+)/i);
      return { target: this.id, sessionId: match?.[1] ?? artifact.sessionId ?? null, output: stdout.trim() };
    } finally {
      if (root) await fs.rm(root, { recursive: true, force: true });
    }
  }
}
