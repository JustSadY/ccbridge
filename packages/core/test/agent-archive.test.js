import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";

test("ccbridge archives embed and restore subagent attachments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-agent-archive-"));
  const out = path.join(dir, "agent.ccbridge");
  const session = {
    schemaVersion: 1,
    id: "s1",
    title: "Agent tree",
    cwd: "/work",
    startedAt: null,
    updatedAt: null,
    source: { adapter: "claude-code", sessionId: "s1", path: null },
    messages: [],
    agents: [{
      id: "reviewer",
      parentId: null,
      name: "reviewer",
      kind: "subagent",
      startedAt: null,
      updatedAt: null,
      source: { adapter: "claude-code", sessionId: "reviewer", path: null },
      messages: [{ id: "m1", role: "assistant", content: [{ type: "attachment", name: "shot.png", mimeType: "image/png", data: "aW1hZ2U=", encoding: "base64", metadata: {} }], metadata: {} }],
      metadata: {},
      events: []
    }],
    metadata: {},
    events: [],
    lossless: { enabled: true, sourceFormat: "claude-code/session-jsonl" }
  };

  const written = await writeCcbridgeArchive(session, { destination: out, from: "claude-code", mode: "lossless" });
  assert.equal(written.embeddedAttachmentCount, 1);
  const raw = JSON.parse(await fs.readFile(out, "utf8"));
  assert.ok(raw.entries.some((entry) => entry.path.startsWith("attachments/agents/reviewer/")));

  const loaded = await readCcbridgeArchive(out);
  const part = loaded.session.agents[0].messages[0].content[0];
  assert.equal(Buffer.from(part.data, "base64").toString(), "image");
  assert.ok(part.archiveEntry.startsWith("attachments/agents/reviewer/"));
});
