import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { diffCcbridgeArchives, diffPortableSessions } from "../src/diff.js";
import { writeCcbridgeArchive } from "../src/lossless/archive.js";

function base(text = "hello") {
  return {
    schemaVersion: 1,
    id: "s1",
    title: "Test",
    cwd: "/work",
    startedAt: "2026-09-04T09:00:00Z",
    updatedAt: "2026-09-04T09:00:01Z",
    source: { adapter: "test", sessionId: "s1", path: null },
    messages: [{ id: "m1", role: "user", createdAt: "2026-09-04T09:00:00Z", content: [{ type: "text", text }], metadata: {} }],
    agents: [],
    metadata: {},
    events: [],
    lossless: null
  };
}

test("portable diff reports changed content under the same message id", () => {
  const result = diffPortableSessions(base("before"), base("after"));
  assert.equal(result.equal, false);
  assert.equal(result.messages.changedById.count, 1);
  assert.equal(result.messages.leftOnlyCount, 1);
  assert.equal(result.messages.rightOnlyCount, 1);
  assert.equal(result.features.text.delta, 0);
});

test("attachment semantic comparison ignores transient path and archive entry when bytes match", () => {
  const left = base();
  const right = base();
  left.messages[0].content = [{ type: "attachment", name: "a.png", mimeType: "image/png", data: "aW1hZ2U=", encoding: "base64", path: "/tmp/a.png", archiveEntry: "attachments/a.png", metadata: {} }];
  right.messages[0].content = [{ type: "attachment", name: "a.png", mimeType: "image/png", data: "aW1hZ2U=", encoding: "base64", path: "C:\\tmp\\a.png", archiveEntry: "attachments/other.png", metadata: {} }];
  const result = diffPortableSessions(left, right);
  assert.equal(result.contentEqual, true);
  assert.equal(result.messages.equivalentCount, 1);
});

test("archive diff distinguishes byte identity from semantic equality and reports entry changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-diff-"));
  const leftPath = path.join(dir, "left.ccbridge");
  const rightPath = path.join(dir, "right.ccbridge");
  await writeCcbridgeArchive(base(), { destination: leftPath, from: "test", mode: "portable" });
  await writeCcbridgeArchive(base(), { destination: rightPath, from: "test", mode: "portable", extraEntries: [{ entryPath: "provenance/sources/example.ccbridge", content: "source", encoding: "utf8", mediaType: "text/plain" }] });

  const same = await diffCcbridgeArchives(leftPath, leftPath);
  assert.equal(same.byteIdentical, true);
  assert.equal(same.semanticEqual, true);

  const changed = await diffCcbridgeArchives(leftPath, rightPath);
  assert.equal(changed.byteIdentical, false);
  assert.equal(changed.semanticEqual, true);
  assert.equal(changed.archive.entries.rightOnlyCount, 1);
  assert.equal(changed.archive.entries.rightOnly[0].path, "provenance/sources/example.ccbridge");
});
