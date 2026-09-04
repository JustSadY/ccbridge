import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen.js";

const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

async function writeSession(records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-qwen-tool-"));
  const projects = path.join(root, "projects");
  const chats = path.join(projects, "project", "chats");
  await fs.mkdir(chats, { recursive: true });
  const file = path.join(chats, `${records[0].sessionId}.jsonl`);
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return { projects, file };
}

function base(sessionId, overrides) {
  return { sessionId, timestamp: "2026-09-04T10:00:00.000Z", cwd: "/work/project", version: "1.0.0", gitBranch: "main", ...overrides };
}

test("Qwen tool_result prefers toolCallResult.callId and propagates top-level errors", async () => {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const fx = await writeSession([
    base(sessionId, { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", parts: [{ text: "run" }] } }),
    base(sessionId, { uuid: "a1", parentUuid: "u1", type: "assistant", message: { role: "model", parts: [{ functionCall: { id: "call-1", name: "shell", args: { command: "false" } } }] } }),
    base(sessionId, { uuid: "r1", parentUuid: "a1", type: "tool_result", message: { role: "user", parts: [{ functionResponse: { name: "shell", response: { output: "failed" } } }] }, toolCallResult: { callId: "call-1", displayName: "Shell", status: "error", error: { message: "exit 1" } } })
  ]);
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "portable" });
  const resultMessage = session.messages.find((message) => message.role === "tool");
  assert.ok(resultMessage);
  const result = resultMessage.content.find((part) => part.type === "tool-result");
  assert.equal(result.callId, "call-1");
  assert.equal(result.isError, true);
  assert.deepEqual(result.output, { output: "failed" });
  assert.deepEqual(resultMessage.metadata.qwenToolResult, { callId: "call-1", displayName: "Shell", status: "error", isError: true });
});

test("Qwen tool_result falls back to record uuid instead of tool name when no call id exists", async () => {
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const fx = await writeSession([
    base(sessionId, { uuid: "u1", parentUuid: null, type: "user", message: { role: "user", parts: [{ text: "run" }] } }),
    base(sessionId, { uuid: "r-fallback", parentUuid: "u1", type: "tool_result", message: { role: "user", parts: [{ functionResponse: { name: "shell", response: { output: "ok" } } }] } })
  ]);
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "portable" });
  const result = session.messages.find((message) => message.role === "tool").content.find((part) => part.type === "tool-result");
  assert.equal(result.callId, "r-fallback");
  assert.equal(result.isError, false);
});
