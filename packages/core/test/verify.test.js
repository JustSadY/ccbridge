import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { forkCcbridgeArchive } from "../src/session-ops.js";
import { verifyCcbridgeArchive, verifyPortableTransfer } from "../src/verify.js";
import { writeCcbridgeArchive } from "../src/lossless/archive.js";

function sourceSession() {
  return {
    schemaVersion: 1,
    id: "s1",
    title: "Source",
    cwd: "/work",
    startedAt: null,
    updatedAt: null,
    source: { adapter: "claude-code", sessionId: "s1", path: null },
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "fix" }, { type: "attachment", name: "a.png", mimeType: "image/png", data: "aW1hZ2U=", encoding: "base64", metadata: {} }], metadata: {} },
      { id: "a1", role: "assistant", content: [{ type: "reasoning", provider: "claude-code", text: "private" }, { type: "tool-call", id: "call-1", name: "Read", input: { file: "a.js" } }], metadata: {} },
      { id: "t1", role: "tool", content: [{ type: "tool-result", callId: "call-1", output: "contents", isError: false }], metadata: {} }
    ],
    agents: [],
    metadata: {},
    events: [],
    lossless: { enabled: true, sourceFormat: "claude-code/session-jsonl", rawRecordCount: 0, includesProviderReasoning: true }
  };
}

test("archive verification validates integrity and deep provenance", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-verify-"));
  const source = path.join(dir, "source.ccbridge");
  const fork = path.join(dir, "fork.ccbridge");
  await writeCcbridgeArchive(sourceSession(), { destination: source, from: "claude-code", mode: "lossless" });
  await forkCcbridgeArchive(source, { destination: fork, id: "forked" });

  const result = await verifyCcbridgeArchive(fork, { deep: true });
  assert.equal(result.valid, true);
  assert.equal(result.manifestValid, true);
  assert.equal(result.portableValid, true);
  assert.equal(result.provenance.entries, 1);
  assert.equal(result.provenance.deepChecked, 1);
  assert.equal(result.attachments.count, 1);
});

test("archive verification fails when an entry checksum no longer matches", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-corrupt-"));
  const archive = path.join(dir, "source.ccbridge");
  await writeCcbridgeArchive(sourceSession(), { destination: archive, from: "claude-code", mode: "lossless" });
  const parsed = JSON.parse(await fs.readFile(archive, "utf8"));
  parsed.entries.find((entry) => entry.path === "portable/session.json").content += "tampered";
  await fs.writeFile(archive, JSON.stringify(parsed));
  const result = await verifyCcbridgeArchive(archive);
  assert.equal(result.valid, false);
  assert.equal(result.manifestValid, false);
  assert.ok(result.errors.some((error) => error.includes("mismatch") || error.includes("Invalid JSON")));
});

test("transfer verification reports only missing semantic features", () => {
  const source = sourceSession();
  const target = structuredClone(source);
  target.source = { adapter: "opencode", sessionId: "target", path: null };
  target.messages[1].content = target.messages[1].content.filter((part) => part.type !== "reasoning");
  target.lossless = null;

  const result = verifyPortableTransfer(source, target);
  assert.equal(result.complete, false);
  assert.equal(result.features.text.missingCount, 0);
  assert.equal(result.features.toolCall.missingCount, 0);
  assert.equal(result.features.toolResult.missingCount, 0);
  assert.equal(result.features.attachment.missingCount, 0);
  assert.equal(result.features.reasoning.missingCount, 1);
  assert.equal(result.missingAtoms, 1);
});
