import os from "node:os";
import path from "node:path";
import { OpenCodeAdapter } from "./opencode.js";
import { RooCodeAdapter } from "./roo.js";

const EXTENSION_DIR = "kilocode.kilo-code";
const unique = (values) => [...new Set(values.filter(Boolean).map((value) => path.resolve(value)))];

function legacyHomes(options = {}) {
  if (options.legacyHome) return [path.resolve(options.legacyHome)];
  if (Array.isArray(options.legacyHomes) && options.legacyHomes.length) return unique(options.legacyHomes);
  const env = options.env ?? process.env;
  if (env.CCBRIDGE_KILO_LEGACY_HOME) return [path.resolve(env.CCBRIDGE_KILO_LEGACY_HOME)];
  const home = options.userHome ?? os.homedir();
  const roots = [];
  if (process.platform === "win32") {
    if (env.APPDATA) for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(env.APPDATA, editor, "User", "globalStorage", EXTENSION_DIR));
  } else if (process.platform === "darwin") {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, "Library", "Application Support", editor, "User", "globalStorage", EXTENSION_DIR));
  } else {
    for (const editor of ["Code", "Code - Insiders", "VSCodium"]) roots.push(path.join(home, ".config", editor, "User", "globalStorage", EXTENSION_DIR));
    roots.push(path.join(home, ".vscode-server", "data", "User", "globalStorage", EXTENSION_DIR));
    roots.push(path.join(home, ".vscode-server-insiders", "data", "User", "globalStorage", EXTENSION_DIR));
  }
  return unique(roots);
}

function patchCurrentSession(session) {
  session.source = { ...session.source, adapter: "kilo-code" };
  session.metadata = { ...session.metadata, kiloBackend: "cli" };
  if (session.lossless) session.lossless = { ...session.lossless, sourceFormat: "kilo/session-json" };
  return session;
}

function patchLegacySession(session) {
  session.source = { ...session.source, adapter: "kilo-code" };
  session.metadata = { ...session.metadata, kiloBackend: "legacy-extension", legacyRooCompatible: true, archivedUpstream: false };
  session.events = (session.events ?? []).map((event) => ({ ...event, provider: "kilo-code" }));
  for (const message of session.messages ?? []) {
    message.content = (message.content ?? []).map((part) => part?.type === "reasoning" ? { ...part, provider: "kilo-code" } : part);
  }
  if (session.lossless) session.lossless = { ...session.lossless, sourceFormat: "kilo/legacy-task-files-v1" };
  return session;
}

export class KiloCodeAdapter {
  constructor(options = {}) {
    this.id = "kilo-code";
    this.name = "Kilo Code";
    this.aliases = ["kilo", "kilocode"];
    this.capabilities = { discover: true, read: true, write: true, nativeExport: true, nativeImport: true, losslessRead: true };
    this.portableSupport = { text: true, toolCall: true, toolResult: true, system: false, reasoning: false, attachment: true, unknownContent: false, rawEvent: false, metadata: false };
    this.nativeExports = ["kilo/session-json", "kilo/legacy-task-files-v1"];
    this.nativeImports = ["kilo/session-json", "opencode/session-json"];
    this.losslessNativeImports = [];
    this.nativeImportPreservation = {
      "kilo/session-json": "remapped",
      "opencode/session-json": "remapped"
    };
    this.command = options.command ?? "kilo";
    this.current = new OpenCodeAdapter({ command: this.command, runner: options.runner });
    this.current.id = this.id;
    this.current.name = this.name;
    this.current.aliases = [];
    this.legacy = new RooCodeAdapter({ homes: legacyHomes(options), env: options.env, userHome: options.userHome });
  }

  async detect() {
    const [current, legacy] = await Promise.all([
      this.current.detect().catch((error) => ({ installed: false, error: error.message })),
      this.legacy.detect().catch((error) => ({ installed: false, error: error.message }))
    ]);
    return {
      installed: Boolean(current.installed || legacy.installed),
      version: current.version ?? null,
      storageFormat: current.installed ? "official-cli-session-export-import" : legacy.installed ? "legacy-roo-compatible-task-files" : null,
      current,
      legacy: { ...legacy, archivedUpstream: false },
      database: current.installed ? "~/.local/share/kilo/kilo.db (not mutated by ccbridge)" : null
    };
  }

  async listSessions() {
    const sessions = [];
    try {
      for (const session of await this.current.listSessions()) sessions.push({ ...session, adapter: this.id, backend: "cli", ref: `current:${session.id}` });
    } catch {}
    try {
      for (const session of await this.legacy.listSessions()) sessions.push({ ...session, adapter: this.id, backend: "legacy-extension", ref: `legacy:${session.id}` });
    } catch {}
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async #resolve(sessionRef) {
    const ref = String(sessionRef);
    if (ref.startsWith("current:")) return { backend: "cli", ref: ref.slice("current:".length) };
    if (ref.startsWith("legacy:")) return { backend: "legacy-extension", ref: ref.slice("legacy:".length) };
    const listed = await this.listSessions();
    const matches = listed.filter((session) => session.id === ref || session.path === ref || session.ref === ref);
    if (matches.length > 1) throw new Error(`Kilo session reference is ambiguous across current/legacy stores: ${sessionRef}; use current:<id> or legacy:<id>`);
    if (matches.length === 1) return { backend: matches[0].backend, ref: matches[0].id === ref ? matches[0].id : matches[0].path ?? matches[0].id };
    if (ref.includes("api_conversation_history.json") || ref.includes("claude_messages.json")) return { backend: "legacy-extension", ref };
    return { backend: "cli", ref };
  }

  async readSession(sessionRef, options = {}) {
    const resolved = await this.#resolve(sessionRef);
    if (resolved.backend === "legacy-extension") return patchLegacySession(await this.legacy.readSession(resolved.ref, options));
    return patchCurrentSession(await this.current.readSession(resolved.ref, options));
  }

  async getNativeArtifact(sessionRef) {
    const resolved = await this.#resolve(sessionRef);
    if (resolved.backend === "legacy-extension") {
      const artifact = await this.legacy.getNativeArtifact(resolved.ref);
      return { ...artifact, format: "kilo/legacy-task-files-v1", sourceAdapter: this.id, archivedUpstream: false };
    }
    const artifact = await this.current.getNativeArtifact(resolved.ref);
    return { ...artifact, format: "kilo/session-json", sourceAdapter: this.id, filename: `kilo-${artifact.sessionId ?? "session"}.json` };
  }

  async acceptsNativeArtifact(artifact) {
    return this.nativeImports.includes(String(artifact?.format ?? "")) && Boolean(artifact?.path || artifact?.content);
  }

  async importNativeArtifact(artifact, options = {}) {
    if (!await this.acceptsNativeArtifact(artifact)) throw new Error(`Kilo Code cannot import native format: ${artifact?.format ?? "unknown"}`);
    const normalized = artifact.format === "kilo/session-json" ? { ...artifact, format: "opencode/session-json" } : artifact;
    const result = await this.current.importNativeArtifact(normalized, options);
    return { ...result, target: this.id, sourceFormat: artifact.format, preservation: this.nativeImportPreservation[artifact.format] ?? "best-effort" };
  }

  async writePortableSession(session, options = {}) {
    const result = await this.current.writePortableSession(session, options);
    return { ...result, target: this.id, preservation: "portable" };
  }
}
