import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RooCodeAdapter } from "../src/adapters/roo.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-roo-"));
  const home = path.join(root, "storage");
  const task = path.join(home, "tasks", "task-1");
  await fs.mkdir(task, { recursive: true });
  const api = path.join(task, "api_conversation_history.json");
  await fs.writeFile(api, JSON.stringify([
    { id: "u1", role: "user", ts: 1000, content: [{ type: "text", text: "build it" }] },
    { id: "a1", role: "assistant", ts: 2000, reasoning_content: "private chain", content: [
      { type: "thinking", thinking: "provider thought", signature: "sig" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.js" } }
    ] },
    { id: "u2", role: "user", ts: 3000, content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }] },
    { id: "r1", type: "reasoning", role: "assistant", ts: 4000, text: "opaque reasoning", summary: [{ text: "summary" }], encrypted_content: "enc" },
    { id: "a2", role: "assistant", ts: 5000, content: [{ type: "text", text: "done" }] }
  ]));
  await fs.writeFile(path.join(task, "ui_messages.json"), JSON.stringify([{ type: "say", text: "ui" }]));
  await fs.writeFile(path.join(task, "task_metadata.json"), JSON.stringify({ cwd: "/work/project", mode: "code" }));
  return { root, home, task, api };
}

test("Roo adapter discovers task history and reads portable content", async () => {
  const { home } = await fixture();
  const adapter = new RooCodeAdapter({ home });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "task-1");
  assert.equal(sessions[0].cwd, "/work/project");

  const session = await adapter.readSession("task-1", { mode: "portable" });
  assert.equal(session.cwd, "/work/project");
  assert.equal(session.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning"), false);
  assert.equal(session.messages.flatMap((message) => message.content).some((part) => part.type === "tool-call"), true);
  assert.equal(session.messages.flatMap((message) => message.content).some((part) => part.type === "tool-result"), true);
});

test("Roo lossless mode preserves thinking, top-level reasoning, and raw events", async () => {
  const { home } = await fixture();
  const adapter = new RooCodeAdapter({ home });
  const session = await adapter.readSession("task-1", { mode: "lossless" });
  const reasoning = session.messages.flatMap((message) => message.content).filter((part) => part.type === "reasoning");
  assert.ok(reasoning.length >= 3);
  assert.equal(session.events.length, 5);
  assert.equal(session.lossless.sourceFormat, "roo-code/api-conversation-history-v1");
  assert.equal(session.lossless.companionUiHistory, true);
  assert.equal(session.lossless.companionTaskMetadata, true);
});

test("Roo native artifact includes UI/metadata companions and correct cwd", async () => {
  const { home, api } = await fixture();
  const adapter = new RooCodeAdapter({ home });
  const artifact = await adapter.getNativeArtifact(api);
  assert.equal(artifact.sessionId, "task-1");
  assert.equal(artifact.cwd, "/work/project");
  assert.equal(artifact.filename, "api_conversation_history.json");
  assert.deepEqual(artifact.companions.map((item) => item.filename).sort(), ["task_metadata.json", "ui_messages.json"]);
  const direct = await adapter.readSession(api, { mode: "lossless" });
  assert.equal(direct.metadata.storageRoot, home);
});
