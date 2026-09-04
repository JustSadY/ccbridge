import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { attachmentContent, createPortableSession, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent } from "../model.js";

const exists = (file) => fs.access(file).then(() => true).catch(() => false);
const iso = (value) => { if (value == null) return null; const n = Number(value); const date = Number.isFinite(n) ? new Date(n < 10_000_000_000 ? n * 1000 : n) : new Date(String(value)); return Number.isNaN(date.getTime()) ? null : date.toISOString(); };

function toolRequest(block) {
  const result = block?.toolCall ?? block?.tool_call;
  if (!result || result.status !== "success") return null;
  const call = result.value ?? {};
  return toolCallContent({ id: block.id ?? null, name: call.name ?? "unknown", input: call.arguments ?? null });
}
function toolResponse(block) {
  const result = block?.toolResult ?? block?.tool_result;
  if (!result) return null;
  if (result.status === "error") return toolResultContent({ callId: block.id ?? null, output: result.error ?? "tool error", isError: true });
  if (result.status !== "success") return null;
  return toolResultContent({ callId: block.id ?? null, output: result.value?.content ?? result.value ?? null, isError: Boolean(result.value?.isError ?? result.value?.is_error) });
}
function contentParts(native, mode) {
  const output = [];
  for (const block of Array.isArray(native?.content) ? native.content : []) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text" && typeof block.text === "string") output.push(textContent(block.text));
    else if (type === "image" && typeof block.data === "string") output.push(attachmentContent({ mimeType: block.mimeType ?? block.mime_type ?? "image/*", data: block.data, encoding: "base64", metadata: { gooseType: type } }));
    else if (type === "document" && typeof block.data === "string") output.push(attachmentContent({ name: block.name ?? null, mimeType: block.mimeType ?? block.mime_type ?? "application/octet-stream", data: block.data, encoding: "base64", metadata: { gooseType: type } }));
    else if (type === "toolRequest") { const part = toolRequest(block); if (part) output.push(part); }
    else if (type === "toolResponse") { const part = toolResponse(block); if (part) output.push(part); }
    else if (type === "thinking" && mode === "lossless") output.push(reasoningContent({ provider: "goose", text: block.thinking ?? null, signature: block.signature ?? null, raw: block }));
    else if (type === "redactedThinking" && mode === "lossless") output.push(reasoningContent({ provider: "goose", encrypted: block.data ?? null, raw: block }));
  }
  return output;
}
function parseExport(data, mode) {
  if (!data || typeof data !== "object" || !Array.isArray(data.conversation)) throw new Error("Goose export returned an unsupported session JSON shape");
  const messages = []; const events = [];
  for (let index = 0; index < data.conversation.length; index += 1) {
    const native = data.conversation[index]; const role = String(native?.role ?? "").toLowerCase(); const createdAt = iso(native?.created);
    if (mode === "lossless") events.push(rawEvent({ index, provider: "goose", kind: `message:${role || "unknown"}`, timestamp: createdAt, data: native }));
    if (role !== "user" && role !== "assistant") continue;
    const content = contentParts(native, mode); if (!content.length) continue;
    messages.push({ id: native?.id ?? null, parentId: null, role, createdAt, content, metadata: { ...(native?.metadata ?? {}), inference: native?.metadata?.inference ?? null, usage: native?.metadata?.usage ?? null } });
  }
  return { messages, events };
}
function defaultExportRoots(options = {}) {
  if (Array.isArray(options.exportRoots) && options.exportRoots.length) return options.exportRoots.map((value) => path.resolve(value));
  const env = options.env ?? process.env;
  return String(env.CCBRIDGE_GOOSE_EXPORT_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean).map((value) => path.resolve(value));
}

export class GooseAdapter {
  constructor(options = {}) {
    this.id = "goose"; this.name = "Goose"; this.aliases = ["goose-ai"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: true, losslessRead: true };
    this.nativeExports = ["goose/session-json"];
    this.nativeImports = ["goose/session-json", "claude-code/session-jsonl", "codex/rollout-jsonl"];
    this.losslessNativeImports = ["goose/session-json"];
    this.command = options.command ?? "goose"; this.runner = options.runner ?? spawnSync; this.exportRoots = defaultExportRoots(options);
  }
  #run(args) {
    const result = this.runner(this.command, args, { encoding: "utf8", windowsHide: true });
    if (result?.error || result?.status !== 0) throw new Error(`${this.command} ${args.join(" ")} failed: ${String(result?.stderr || result?.error?.message || "unknown error").trim()}`);
    return String(result.stdout ?? "");
  }
  async detect() {
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    return { installed: !result?.error && result?.status === 0, version: result?.status === 0 ? String(result.stdout || result.stderr || "").trim() : null, storageFormat: "official-cli-session-export-import", exportRoots: this.exportRoots };
  }
  async listSessions() {
    try {
      const data = JSON.parse(this.#run(["session", "list", "--format", "json"]));
      if (!Array.isArray(data)) throw new Error("Goose session list did not return an array");
      return data.map((session) => ({ adapter: this.id, id: session.id, title: session.name || session.last_message_snippet || null, cwd: session.working_dir ?? null, path: null, createdAt: iso(session.created_at), updatedAt: iso(session.last_message_at ?? session.updated_at), provider: session.provider_name ?? null, model: session.model_config ?? null, sessionType: session.session_type ?? null, parentSessionId: session.parent_session_id ?? null }));
    } catch (error) {
      if (!this.exportRoots.length) throw error;
      const exported = [];
      for (const root of this.exportRoots) {
        let entries = []; try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const file = path.join(root, entry.name);
          try {
            const data = JSON.parse(await fs.readFile(file, "utf8")); if (!Array.isArray(data?.conversation) || !data?.id) continue;
            const stat = await fs.stat(file);
            exported.push({ adapter: this.id, id: data.id, title: data.name || null, cwd: data.working_dir ?? null, path: file, createdAt: iso(data.created_at), updatedAt: iso(data.last_message_at ?? data.updated_at) ?? stat.mtime.toISOString(), exportedOnly: true });
          } catch {}
        }
      }
      return exported;
    }
  }
  async #export(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".json") && await exists(ref)) return { data: JSON.parse(await fs.readFile(ref, "utf8")), path: path.resolve(ref) };
    return { data: JSON.parse(this.#run(["session", "export", "--session-id", ref, "--format", "json"])), path: null };
  }
  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const exported = await this.#export(sessionRef); const data = exported.data; const parsed = parseExport(data, mode); const allParts = parsed.messages.flatMap((message) => message.content);
    return createPortableSession({ id: data.id, title: data.name || parsed.messages.find((message) => message.role === "user")?.content?.find((part) => part.type === "text")?.text?.slice(0, 100) ?? null, cwd: data.working_dir ?? null, startedAt: iso(data.created_at), updatedAt: iso(data.last_message_at ?? data.updated_at), source: { adapter: this.id, sessionId: data.id, path: exported.path }, messages: parsed.messages, agents: [], metadata: { sessionType: data.session_type ?? null, extensionData: data.extension_data ?? null, usage: data.usage ?? null, accumulatedUsage: data.accumulated_usage ?? null, accumulatedCost: data.accumulated_cost ?? null, providerName: data.provider_name ?? null, modelConfig: data.model_config ?? null, gooseMode: data.goose_mode ?? null, parentSessionId: data.parent_session_id ?? null, recipe: data.recipe ?? null }, events: parsed.events, lossless: mode === "lossless" ? { enabled: true, sourceFormat: "goose/session-json", rawRecordCount: parsed.events.length, includesProviderReasoning: allParts.some((part) => part.type === "reasoning"), includesUnknownEvents: true } : null });
  }
  async getNativeArtifact(sessionRef) {
    const exported = await this.#export(sessionRef); const data = exported.data;
    return { kind: "agent-session", format: "goose/session-json", formatVersion: 1, sourceAdapter: this.id, content: `${JSON.stringify(data, null, 2)}\n`, encoding: "utf8", filename: `goose-${data.id ?? "session"}.json`, cwd: data.working_dir ?? null, sessionId: data.id ?? String(sessionRef) };
  }
  async acceptsNativeArtifact(artifact) { return this.nativeImports.includes(String(artifact?.format ?? "")); }
  async importNativeArtifact(artifact) {
    if (!await this.acceptsNativeArtifact(artifact)) throw new Error(`Goose cannot import native format: ${artifact?.format ?? "unknown"}`);
    let file = artifact?.path ? path.resolve(artifact.path) : null; let temporary = null;
    if (!file) {
      const content = typeof artifact?.content === "string" ? artifact.content : null; if (!content) throw new Error("Goose native import requires a path or textual artifact content");
      temporary = path.join(os.tmpdir(), `ccbridge-goose-${randomUUID()}${artifact.format === "goose/session-json" ? ".json" : ".jsonl"}`);
      await fs.writeFile(temporary, content, { mode: 0o600 }); file = temporary;
    }
    try {
      const stdout = this.#run(["session", "import", file]); const match = stdout.match(/Session imported:\s*[\r\n]+([^\s]+)\s*-\s*(.*)/i);
      return { imported: true, sourceFormat: artifact.format, sourceSessionId: artifact.sessionId ?? null, targetSessionId: match?.[1] ?? null, targetName: match?.[2]?.trim() ?? null, output: stdout.trim() };
    } finally { if (temporary) await fs.rm(temporary, { force: true }); }
  }
}
