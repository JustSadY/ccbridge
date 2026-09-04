import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";
import { CCBRIDGE_ARCHIVE_FORMAT, CCBRIDGE_ARCHIVE_VERSION, materializeCcbridgeNative, readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";

function losslessSession() {
  return { schemaVersion: 1, id: "session-1", title: "Test", cwd: "/work", startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "session-1", path: null }, messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }], metadata: {} }], metadata: {}, events: [{ index: 0, provider: "source", kind: "thinking", timestamp: null, data: { secretThinking: "keep me" } }], lossless: { enabled: true, sourceFormat: "vendor/session-jsonl", rawRecordCount: 1, includesProviderReasoning: true, includesUnknownEvents: false } };
}

test("writes and reads ccbridge v2 entries with embedded native bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-archive-"));
  const native = path.join(dir, "session.jsonl");
  const wal = path.join(dir, "session.jsonl-wal");
  const out = path.join(dir, "backup.ccbridge");
  await fs.writeFile(native, '{"type":"raw"}\n');
  await fs.writeFile(wal, "wal-bytes");
  const written = await writeCcbridgeArchive(losslessSession(), { destination: out, from: "source", nativeArtifact: { kind: "agent-session", format: "vendor/session-jsonl", formatVersion: 1, sourceAdapter: "source", path: native, cwd: "/work", sessionId: "session-1", companions: [{ path: wal, filename: "session.jsonl-wal" }] } });
  assert.equal(written.format, CCBRIDGE_ARCHIVE_FORMAT);
  assert.equal(written.version, CCBRIDGE_ARCHIVE_VERSION);
  assert.equal(written.entryCount, 4);
  assert.equal(written.embeddedCompanionCount, 1);
  assert.ok(written.embeddedNativeBytes > 0);

  const stored = JSON.parse(await fs.readFile(out, "utf8"));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.manifest.entries.map((entry) => entry.path), ["portable/session.json", "raw/events.json", "native/session.jsonl", "native/session.jsonl-wal"]);
  assert.ok(stored.manifest.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));

  const loaded = await readCcbridgeArchive(out);
  assert.equal(loaded.session.events[0].data.secretThinking, "keep me");
  assert.equal(loaded.nativeArtifact.format, "vendor/session-jsonl");
  const materialized = await materializeCcbridgeNative(loaded);
  try {
    assert.equal(await fs.readFile(materialized.artifact.path, "utf8"), '{"type":"raw"}\n');
    assert.equal(await fs.readFile(materialized.artifact.companions[0].path, "utf8"), "wal-bytes");
  } finally { await materialized.cleanup(); }
});

test("rejects corrupted ccbridge v2 entry content", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-corrupt-"));
  const out = path.join(dir, "backup.ccbridge");
  await writeCcbridgeArchive(losslessSession(), { destination: out, from: "source" });
  const stored = JSON.parse(await fs.readFile(out, "utf8"));
  const events = stored.entries.find((entry) => entry.path === "raw/events.json");
  events.content = events.content.replace("keep me", "changed");
  await assert.rejects(() => readCcbridgeArchive(stored), /size mismatch|checksum mismatch/);
});

test("reads ccbridge/session v1 archives for backward compatibility", async () => {
  const legacy = { format: CCBRIDGE_ARCHIVE_FORMAT, version: 1, createdAt: null, source: { adapter: "source", sessionId: "session-1" }, intendedTarget: null, mode: "lossless", session: losslessSession(), nativeArtifact: null, metadata: {} };
  const loaded = await readCcbridgeArchive(legacy);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.session.id, "session-1");
  assert.equal(loaded.metadata.archiveVersion, 1);
});

test("exports then imports from embedded native data after original file is gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-restore-"));
  const native = path.join(dir, "original.jsonl");
  const archive = path.join(dir, "session.ccbridge");
  await fs.writeFile(native, "native-session-data\n");
  const source = { id: "source", name: "Source", aliases: [], capabilities: { read: true, nativeExport: true, losslessRead: true }, async readSession() { return losslessSession(); }, async getNativeArtifact() { return { kind: "agent-session", format: "vendor/session-jsonl", formatVersion: 1, sourceAdapter: "source", path: native, cwd: "/work", sessionId: "session-1" }; } };
  const target = { id: "target", name: "Target", aliases: [], nativeImports: ["vendor/session-jsonl"], async importNativeArtifact(artifact) { return { bytes: await fs.readFile(artifact.path, "utf8"), format: artifact.format }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  await bridge.exportSession({ from: "source", session: "session-1", destination: archive, mode: "lossless" });
  await fs.rm(native);
  const plan = await bridge.importArchive({ archive, to: "target", dryRun: true });
  assert.equal(plan.route, "native");
  assert.equal(plan.format, "vendor/session-jsonl");
  const restored = await bridge.importArchive({ archive, to: "target" });
  assert.equal(restored.route, "native");
  assert.equal(restored.result.bytes, "native-session-data\n");
});
