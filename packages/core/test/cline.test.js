import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClineAdapter } from "../src/adapters/cline.js";

function runner(_command, args) {
  if (args[0] === "--version") return { status: 0, stdout: "cline 4.1.4\n", stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

async function fixture(version = 1) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-cline-"));
  const id = "session-123";
  const dir = path.join(home, "data", "sessions", id);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.messages.json`);
  const payload = {
    version,
    updated_at: "2026-09-04T10:00:00.000Z",
    agent: "lead",
    sessionId: id,
    system_prompt: "private system prompt",
    messages: [
      { id: "u1", role: "user", content: [{ type: "text", text: "Fix the parser" }] },
      { id: "a1", role: "assistant", ts: 1788512400000, modelInfo: { id: "claude-sonnet-4-6", provider: "anthropic" }, content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "I will inspect it." },
        { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "parser.js" } }
      ] },
      { id: "u2", role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents", is_error: false }] },
      { id: "a2", role: "assistant", ts: 1788512401000, modelInfo: { id: "claude-sonnet-4-6", provider: "anthropic" }, metrics: { inputTokens: 21, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 1, cost: 0.13 }, content: [{ type: "text", text: "Done." }] }
    ]
  };
  await fs.writeFile(file, JSON.stringify(payload, null, 2));
  return { home, id, file, payload };
}

test("discovers canonical Cline messages v1 sessions", async () => {
  const { home, id, file } = await fixture();
  const adapter = new ClineAdapter({ home, runner });
  const detection = await adapter.detect();
  assert.equal(detection.installed, true);
  assert.equal(detection.storageFormat, "messages-contract-v1");
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].path, file);
  assert.equal(sessions[0].title, "Fix the parser");
});

test("portable Cline read maps text and tool history but omits thinking", async () => {
  const { home, id } = await fixture();
  const adapter = new ClineAdapter({ home, runner });
  const session = await adapter.readSession(id);
  assert.equal(session.lossless, null);
  assert.equal(JSON.stringify(session).includes("private reasoning"), false);
  assert.deepEqual(session.messages[1].content.map((part) => part.type), ["text", "tool-call"]);
  assert.deepEqual(session.messages[2].content.map((part) => part.type), ["tool-result"]);
  assert.equal(session.messages[3].metadata.metrics.cost, 0.13);
  assert.equal(session.metadata.systemPrompt, null);
});

test("lossless Cline read preserves thinking, system prompt and raw native messages", async () => {
  const { home, id, payload } = await fixture();
  const adapter = new ClineAdapter({ home, runner });
  const session = await adapter.readSession(id, { mode: "lossless" });
  assert.equal(session.lossless.enabled, true);
  assert.equal(session.lossless.sourceFormat, "cline/messages-json-v1");
  assert.equal(session.events.length, payload.messages.length);
  assert.equal(session.events[1].kind, "message:assistant");
  assert.equal(session.messages[1].content[0].type, "reasoning");
  assert.equal(session.messages[1].content[0].text, "private reasoning");
  assert.equal(session.metadata.systemPrompt, "private system prompt");

  const artifact = await adapter.getNativeArtifact(id);
  assert.equal(artifact.format, "cline/messages-json-v1");
  assert.equal(artifact.formatVersion, 1);
});

test("unsupported Cline messages contract version fails explicitly", async () => {
  const { home, file } = await fixture(2);
  const adapter = new ClineAdapter({ home, runner });
  assert.deepEqual(await adapter.listSessions(), []);
  await assert.rejects(adapter.readSession(file), /Unsupported Cline messages contract version: 2/);
});
