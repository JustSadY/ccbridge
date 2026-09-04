import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractProvenanceArchive, forkCcbridgeArchive, mergeCcbridgeArchives, mergePortableSessions } from "../src/session-ops.js";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";

function session(id, side, createdAt) {
  return {
    schemaVersion: 1,
    id,
    title: side,
    cwd: "/work",
    startedAt: createdAt,
    updatedAt: createdAt,
    source: { adapter: "test-agent", sessionId: id, path: null },
    messages: [{ id: "shared-message-id", role: "user", createdAt, content: [{ type: "text", text: side }], metadata: { original: side } }],
    agents: [{ id: "reviewer", parentId: null, name: `${side}-reviewer`, kind: "subagent", startedAt: createdAt, updatedAt: createdAt, source: { adapter: "test-agent", sessionId: `${id}-reviewer`, path: null }, messages: [{ id: `${side}-agent-message`, role: "assistant", createdAt, content: [{ type: "text", text: `${side} review` }], metadata: {} }], metadata: { sourceSide: side }, events: [] }],
    metadata: { originalMetadata: side },
    events: [{ index: 0, provider: "test-agent", kind: "event", timestamp: createdAt, data: { side } }],
    lossless: { enabled: true, sourceFormat: "test/json", rawRecordCount: 1, includesProviderReasoning: false, includesUnknownEvents: true, includesSubagents: true }
  };
}

test("portable merge keeps both branches without deduplication and namespaces agents", () => {
  const left = session("left", "left", "2026-09-04T09:00:00Z");
  const right = session("right", "right", "2026-09-04T09:00:01Z");
  const merged = mergePortableSessions(left, right, { id: "merged" });
  assert.equal(merged.messages.length, 2);
  assert.deepEqual(merged.messages.map((message) => message.content[0].text), ["left", "right"]);
  assert.deepEqual(merged.agents.map((agent) => agent.id), ["left:reviewer", "right:reviewer"]);
  assert.equal(merged.agents[0].metadata.ccbridgeMergeSource.originalAgentId, "reviewer");
  assert.equal(merged.metadata.ccbridgeMergeSources.left.metadata.originalMetadata, "left");
  assert.equal(merged.metadata.ccbridgeMergeSources.right.lossless.sourceFormat, "test/json");
});

test("fork embeds the complete parent archive as extractable provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-fork-"));
  const source = path.join(dir, "source.ccbridge");
  const forked = path.join(dir, "fork.ccbridge");
  const restored = path.join(dir, "restored-parent.ccbridge");
  await writeCcbridgeArchive(session("source", "source", "2026-09-04T09:00:00Z"), { destination: source, from: "test-agent", mode: "lossless" });
  const originalBytes = await fs.readFile(source);

  const result = await forkCcbridgeArchive(source, { destination: forked, id: "forked" });
  assert.equal(result.sessionId, "forked");
  const loaded = await readCcbridgeArchive(forked);
  assert.equal(loaded.session.source.adapter, "ccbridge");
  const provenance = loaded.entries.find((entry) => entry.path.startsWith("provenance/sources/parent-"));
  assert.ok(provenance);

  await extractProvenanceArchive(forked, provenance.path, restored);
  assert.deepEqual(await fs.readFile(restored), originalBytes);
});

test("merge embeds both complete source archives and restores them byte-for-byte", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-merge-"));
  const leftPath = path.join(dir, "left.ccbridge");
  const rightPath = path.join(dir, "right.ccbridge");
  const mergedPath = path.join(dir, "merged.ccbridge");
  await writeCcbridgeArchive(session("left", "left", "2026-09-04T09:00:00Z"), { destination: leftPath, from: "test-agent", mode: "lossless" });
  await writeCcbridgeArchive(session("right", "right", "2026-09-04T09:00:01Z"), { destination: rightPath, from: "test-agent", mode: "lossless" });
  const leftBytes = await fs.readFile(leftPath);
  const rightBytes = await fs.readFile(rightPath);

  const result = await mergeCcbridgeArchives(leftPath, rightPath, { destination: mergedPath, id: "merged" });
  assert.equal(result.messageCount, 2);
  assert.equal(result.agentCount, 2);
  assert.equal(result.provenanceEntries, 2);

  const loaded = await readCcbridgeArchive(mergedPath);
  assert.deepEqual(loaded.session.agents.map((agent) => agent.id), ["left:reviewer", "right:reviewer"]);
  const sourceEntries = loaded.entries.filter((entry) => entry.path.startsWith("provenance/sources/"));
  assert.equal(sourceEntries.length, 2);

  const leftRestored = path.join(dir, "left-restored.ccbridge");
  const rightRestored = path.join(dir, "right-restored.ccbridge");
  const leftEntry = sourceEntries.find((entry) => entry.path.includes("left-left.ccbridge"));
  const rightEntry = sourceEntries.find((entry) => entry.path.includes("right-right.ccbridge"));
  await extractProvenanceArchive(mergedPath, leftEntry.path, leftRestored);
  await extractProvenanceArchive(mergedPath, rightEntry.path, rightRestored);
  assert.deepEqual(await fs.readFile(leftRestored), leftBytes);
  assert.deepEqual(await fs.readFile(rightRestored), rightBytes);
});
