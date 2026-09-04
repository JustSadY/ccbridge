import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-claude-"));
  const dir = path.join(home, "projects", "-tmp-project");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "session-1.jsonl");
  const rows = [
    { type: "user", sessionId: "s1", uuid: "u1", cwd: "/tmp/project", timestamp: "2026-09-04T09:00:00Z", message: { role: "user", content: "Fix the parser" } },
    { type: "assistant", sessionId: "s1", uuid: "a1", parentUuid: "u1", cwd: "/tmp/project", timestamp: "2026-09-04T09:00:01Z", message: { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning", signature: "signed-provider-payload" },
      { type: "text", text: "I will inspect it." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/a.js" } }
    ] } },
    { type: "progress", sessionId: "s1", timestamp: "2026-09-04T09:00:01.500Z", data: { phase: "reading" } },
    { type: "user", sessionId: "s1", uuid: "u2", parentUuid: "a1", cwd: "/tmp/project", timestamp: "2026-09-04T09:00:02Z", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "file contents" }
    ] } }
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { home, rows };
}

test("reads Claude JSONL into a portable session and drops thinking by default", async () => {
  const { home } = await fixture();
  const adapter = new ClaudeCodeAdapter({ home });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "s1");

  const session = await adapter.readSession("s1");
  assert.equal(session.cwd, "/tmp/project");
  assert.equal(session.messages.length, 3);
  assert.deepEqual(session.messages[1].content.map((part) => part.type), ["text", "tool-call"]);
  assert.equal(session.events.length, 0);
  assert.equal(session.lossless, null);
  assert.equal(JSON.stringify(session).includes("private reasoning"), false);
});

test("lossless Claude reads preserve thinking, signatures and raw events", async () => {
  const { home, rows } = await fixture();
  const adapter = new ClaudeCodeAdapter({ home });
  const session = await adapter.readSession("s1", { mode: "lossless" });

  assert.equal(session.lossless.enabled, true);
  assert.equal(session.events.length, rows.length);
  assert.equal(session.events[2].kind, "progress");
  const reasoning = session.messages[1].content.find((part) => part.type === "reasoning");
  assert.equal(reasoning.text, "private reasoning");
  assert.equal(reasoning.signature, "signed-provider-payload");
  assert.equal(JSON.stringify(session).includes("private reasoning"), true);
});
