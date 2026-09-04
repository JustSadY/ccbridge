import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createPortableSession, rawEvent } from "../model.js";
import { defaultAntigravityCliHome } from "../platform/paths.js";

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readWorkspaceCache(home) {
  const file = path.join(home, "cache", "last_conversations.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function reverseWorkspaceCache(cache) {
  const result = new Map();
  for (const [cwd, id] of Object.entries(cache)) {
    if (typeof id === "string" && id) result.set(id, cwd);
  }
  return result;
}

export class AntigravityCliAdapter {
  constructor(options = {}) {
    this.id = "antigravity-cli";
    this.name = "Google Antigravity CLI";
    this.aliases = ["antigravity", "agy"];
    this.capabilities = {
      discover: true,
      read: true,
      write: false,
      nativeExport: true,
      nativeImport: false,
      portableRead: false,
      losslessRead: true
    };
    this.nativeExports = ["antigravity-cli/conversation-sqlite-v1"];
    this.home = options.home ?? defaultAntigravityCliHome(options);
    this.command = options.command ?? "agy";
    this.runner = options.runner ?? spawnSync;
  }

  async detect() {
    const store = path.join(this.home, "conversations");
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    return {
      installed: !result?.error && result?.status === 0,
      version: result?.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
      home: this.home,
      sessionStore: store,
      sessionStoreExists: await exists(store),
      storageFormat: "sqlite-private-protobuf"
    };
  }

  async listSessions() {
    const store = path.join(this.home, "conversations");
    let entries;
    try { entries = await fs.readdir(store, { withFileTypes: true }); }
    catch { return []; }

    const cwdById = reverseWorkspaceCache(await readWorkspaceCache(this.home));
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
      const id = entry.name.slice(0, -3);
      const file = path.join(store, entry.name);
      try {
        const stat = await fs.stat(file);
        const wal = `${file}-wal`;
        const shm = `${file}-shm`;
        sessions.push({
          adapter: this.id,
          id,
          title: null,
          cwd: cwdById.get(id) ?? null,
          path: file,
          updatedAt: stat.mtime.toISOString(),
          size: stat.size,
          wal: await exists(wal) ? wal : null,
          shm: await exists(shm) ? shm : null,
          nativeOnly: true
        });
      } catch {
        // Ignore files that disappear while the conversation store is being updated.
      }
    }
    sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return sessions;
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".db") && await exists(ref)) return path.resolve(ref);
    const direct = path.join(this.home, "conversations", `${ref}.db`);
    if (await exists(direct)) return direct;
    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.id === ref || session.path === ref);
    if (!match) throw new Error(`Antigravity CLI conversation not found: ${sessionRef}`);
    return match.path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    if (mode !== "lossless") {
      throw new Error("Antigravity CLI does not expose a supported machine-readable transcript export. Use --all/--mode lossless for a raw SQLite backup.");
    }

    const db = await this.resolveSession(sessionRef);
    const id = path.basename(db, ".db");
    const stat = await fs.stat(db);
    const cache = reverseWorkspaceCache(await readWorkspaceCache(this.home));
    const companions = [];
    for (const suffix of ["-wal", "-shm"]) {
      const file = `${db}${suffix}`;
      if (await exists(file)) {
        const companionStat = await fs.stat(file);
        companions.push({ filename: path.basename(file), size: companionStat.size });
      }
    }

    return createPortableSession({
      id,
      title: null,
      cwd: cache.get(id) ?? null,
      startedAt: null,
      updatedAt: stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: id, path: db },
      messages: [],
      metadata: {
        nativeOnly: true,
        sqliteUserSchema: "private/unsupported",
        databaseBytes: stat.size,
        companions
      },
      events: [rawEvent({
        index: 0,
        provider: this.id,
        kind: "sqlite-container",
        timestamp: stat.mtime.toISOString(),
        data: { filename: path.basename(db), size: stat.size, companions }
      })],
      lossless: {
        enabled: true,
        sourceFormat: "antigravity-cli/conversation-sqlite-v1",
        rawRecordCount: 0,
        includesProviderReasoning: false,
        providerReasoningOpaque: true,
        includesUnknownEvents: true,
        nativeOnly: true
      }
    });
  }

  async getNativeArtifact(sessionRef) {
    const db = await this.resolveSession(sessionRef);
    const id = path.basename(db, ".db");
    const cache = reverseWorkspaceCache(await readWorkspaceCache(this.home));
    const companions = [];
    for (const suffix of ["-wal", "-shm"]) {
      const file = `${db}${suffix}`;
      if (await exists(file)) companions.push({ path: file, filename: path.basename(file) });
    }
    return {
      kind: "agent-session",
      format: "antigravity-cli/conversation-sqlite-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      path: db,
      filename: path.basename(db),
      companions,
      cwd: cache.get(id) ?? null,
      sessionId: id,
      opaque: true
    };
  }
}
