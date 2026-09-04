import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

function mockRunner(command, args, options = {}) {
  if (args[0] === "--version") return { status: 0, stdout: "1.2.3\n", stderr: "" };
  if (args[0] === "session") return { status: 0, stdout: JSON.stringify([{ id: "ses_1", title: "Test", updated: 1756976400000, created: 1756976300000, projectId: "p1", directory: "/tmp/project" }]), stderr: "" };
  if (args[0] === "export") return { status: 0, stdout: JSON.stringify({ info: { id: "ses_1", title: "Test", projectID: "p1", directory: "/tmp/project", time: { created: 1756976300000, updated: 1756976400000 } }, messages: [{ info: { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1756976310000 }, agent: "build", model: { providerID: "anthropic", modelID: "x" } }, parts: [{ id: "prt_t", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "Fix it" }] }, { info: { id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 1756976320000 }, parentID: "msg_u" }, parts: [{ id: "prt_r", sessionID: "ses_1", messageID: "msg_a", type: "reasoning", text: "private thought", time: { start: 1756976320000 } }, { id: "prt_tool", sessionID: "ses_1", messageID: "msg_a", type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { file: "a.js" }, output: "contents", title: "read", metadata: {}, time: { start: 1, end: 2 } } }] }] }), stderr: "" };
  if (args[0] === "import") return { status: 0, stdout: "Imported session: ses_1\n", stderr: "", cwd: options.cwd };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

test("reads OpenCode sessions through official CLI JSON", async () => {
  const adapter = new OpenCodeAdapter({ runner: mockRunner });
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0].id, "ses_1");
  const portable = await adapter.readSession("ses_1");
  assert.equal(portable.messages.length, 2);
  assert.equal(JSON.stringify(portable).includes("private thought"), false);
  const lossless = await adapter.readSession("ses_1", { mode: "lossless" });
  assert.equal(lossless.lossless.enabled, true);
  assert.equal(JSON.stringify(lossless).includes("private thought"), true);
  assert.deepEqual(lossless.messages[1].content.map((part) => part.type), ["reasoning", "tool-call", "tool-result"]);
});

test("exports and imports OpenCode native session JSON through CLI", async () => {
  const adapter = new OpenCodeAdapter({ runner: mockRunner });
  const artifact = await adapter.getNativeArtifact("ses_1");
  assert.equal(artifact.format, "opencode/session-json");
  assert.ok(artifact.content.includes('"messages"'));
  const result = await adapter.importNativeArtifact(artifact, { cwd: "/tmp/project" });
  assert.equal(result.sessionId, "ses_1");
});
