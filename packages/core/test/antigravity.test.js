import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { AntigravityCliAdapter } from "../src/adapters/antigravity.js";
import { SessionBridge } from "../src/bridge.js";
import { readCcbridgeArchive, materializeCcbridgeNative } from "../src/lossless/archive.js";

test("discovers Antigravity SQLite conversations and preserves WAL companions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-agy-"));
  const store = path.join(home, "conversations");
  const cache = path.join(home, "cache");
  await fs.mkdir(store, { recursive: true });
  await fs.mkdir(cache, { recursive: true });
  const id = "11111111-2222-3333-4444-555555555555";
  const db = path.join(store, `${id}.db`);
  await fs.writeFile(db, "sqlite-main");
  await fs.writeFile(`${db}-wal`, "sqlite-wal");
  await fs.writeFile(path.join(cache, "last_conversations.json"), JSON.stringify({ "/tmp/project": id }));

  const adapter = new AntigravityCliAdapter({ home, command: "__missing_agy__" });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].cwd, "/tmp/project");
  await assert.rejects(() => adapter.readSession(id), /machine-readable transcript export/);
  const lossless = await adapter.readSession(id, { mode: "lossless" });
  assert.equal(lossless.lossless.nativeOnly, true);
  assert.equal(lossless.messages.length, 0);
  const artifact = await adapter.getNativeArtifact(id);
  assert.equal(artifact.format, "antigravity-cli/conversation-sqlite-v1");
  assert.equal(artifact.companions.length, 1);
});

test("exports Antigravity DB and WAL into a ccbridge archive", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-agy-export-"));
  const store = path.join(home, "conversations");
  await fs.mkdir(store, { recursive: true });
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const db = path.join(store, `${id}.db`);
  await fs.writeFile(db, "main-db-bytes");
  await fs.writeFile(`${db}-wal`, "wal-bytes");
  const out = path.join(home, "backup.ccbridge");
  const adapter = new AntigravityCliAdapter({ home, command: "__missing_agy__" });
  const bridge = new SessionBridge(new AdapterRegistry().register(adapter));
  const result = await bridge.exportSession({ from: "antigravity", session: id, destination: out, mode: "lossless" });
  assert.equal(result.embeddedCompanionCount, 1);
  const archive = await readCcbridgeArchive(out);
  assert.equal(archive.nativeArtifact.format, "antigravity-cli/conversation-sqlite-v1");
  assert.equal(archive.nativeArtifact.companions.length, 1);
  const materialized = await materializeCcbridgeNative(archive);
  try {
    assert.equal(await fs.readFile(materialized.artifact.path, "utf8"), "main-db-bytes");
    assert.equal(await fs.readFile(materialized.artifact.companions[0].path, "utf8"), "wal-bytes");
  } finally { await materialized.cleanup(); }
});
