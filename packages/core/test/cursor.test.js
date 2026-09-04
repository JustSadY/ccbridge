import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CursorAdapter } from "../src/adapters/cursor.js";

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-cursor-"));
  const root = path.join(home, "projects", "home-me-project", "agent-transcripts");
  const session = path.join(root, "session-1", "session-1.jsonl");
  await writeJsonl(session, [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>build this</user_query>" }] } },
    { status: "running", type: "status" },
    { role: "assistant", message: { content: [{ type: "text", text: "working" }, { type: "tool_use", name: "Shell", input: { command: "pwd" } }] } },
    { role: "assistant", message: { content: [{ type: "thinking", thinking: "hidden thought", signature: "sig" }, { type: "text", text: "done" }] } }
  ]);
  await writeJsonl(path.join(root, "session-1", "subagents", "researcher.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "research" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "result" }] } }
  ]);
  await writeJsonl(path.join(root, "legacy.jsonl"), [
    { role: "user", message: { content: [{ type: "text", text: "legacy" }] } }
  ]);
  return { home, root, session };
}

test("Cursor adapter discovers current and legacy transcript layouts", async () => {
  const { home } = await fixture();
  const adapter = new CursorAdapter({ home });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  const current = sessions.find((item) => item.id === "session-1");
  assert.ok(current);
  assert.equal(current.projectKey, "home-me-project");
  assert.equal(current.subagents, 1);
  assert.ok(sessions.some((item) => item.id === "legacy" && item.legacyFlat));
});

test("Cursor portable mode keeps visible text/tool calls and subagent tree", async () => {
  const { home } = await fixture();
  const adapter = new CursorAdapter({ home });
  const session = await adapter.readSession("session-1", { mode: "portable" });
  const parts = session.messages.flatMap((message) => message.content);
  assert.ok(parts.some((part) => part.type === "tool-call" && part.name === "Shell"));
  assert.equal(parts.some((part) => part.type === "reasoning"), false);
  assert.equal(session.agents.length, 1);
  assert.equal(session.agents[0].id, "researcher");
});

test("Cursor lossless mode preserves raw/status rows and observed thinking", async () => {
  const { home, session: file } = await fixture();
  const adapter = new CursorAdapter({ home });
  const session = await adapter.readSession(file, { mode: "lossless" });
  assert.ok(session.events.some((event) => event.kind === "record:status"));
  assert.ok(session.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning" && part.text === "hidden thought"));
  assert.equal(session.lossless.sourceFormat, "cursor/agent-transcript-jsonl-v1");
  assert.equal(session.lossless.transcriptMayOmitToolResults, true);
  assert.equal(session.agents[0].events.length, 2);
});

test("Cursor native artifact carries subagent transcript companions", async () => {
  const { home } = await fixture();
  const adapter = new CursorAdapter({ home });
  const artifact = await adapter.getNativeArtifact("session-1");
  assert.equal(artifact.format, "cursor/agent-transcript-jsonl-v1");
  assert.deepEqual(artifact.companions.map((item) => item.filename), ["subagents/researcher.jsonl"]);
});
