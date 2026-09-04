import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

let importedPayload = null;
function mockRunner(command, args, options = {}) {
  if (args[0] === "--version") return { status: 0, stdout: "1.2.3\n", stderr: "" };
  if (args[0] === "session") return { status: 0, stdout: JSON.stringify([{ id: "ses_1", title: "Test", updated: 1756976400000, created: 1756976300000, projectId: "p1", directory: "/tmp/project" }]), stderr: "" };
  if (args[0] === "export") return { status: 0, stdout: JSON.stringify({ info: { id: "ses_1", title: "Test", projectID: "p1", directory: "/tmp/project", time: { created: 1756976300000, updated: 1756976400000 } }, messages: [{ info: { id: "msg_u", sessionID: "ses_1", role: "user", time: { created: 1756976310000 }, agent: "build", model: { providerID: "anthropic", modelID: "x" } }, parts: [{ id: "prt_t", sessionID: "ses_1", messageID: "msg_u", type: "text", text: "Fix it" }] }, { info: { id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 1756976320000 }, parentID: "msg_u" }, parts: [{ id: "prt_r", sessionID: "ses_1", messageID: "msg_a", type: "reasoning", text: "private thought", time: { start: 1756976320000 } }, { id: "prt_tool", sessionID: "ses_1", messageID: "msg_a", type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { file: "a.js" }, output: "contents", title: "read", metadata: {}, time: { start: 1, end: 2 } } }] }] }), stderr: "" };
  if (args[0] === "import") { importedPayload = JSON.parse(fs.readFileSync(args[1], "utf8")); return { status: 0, stdout: `Imported session: ${importedPayload.info.id}\n`, stderr: "", cwd: options.cwd }; }
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

test("writes PortableSession through the official OpenCode import format", async () => {
  importedPayload = null;
  const adapter = new OpenCodeAdapter({ runner: mockRunner });
  const session = {
    schemaVersion: 1,
    id: "claude-original",
    title: "Imported task",
    cwd: "/tmp/project",
    startedAt: "2026-09-04T09:00:00Z",
    updatedAt: "2026-09-04T09:01:00Z",
    source: { adapter: "claude-code", sessionId: "claude-original", path: null },
    messages: [
      { id: "u1", role: "user", createdAt: "2026-09-04T09:00:00Z", content: [{ type: "text", text: "Fix it" }], metadata: {} },
      { id: "a1", role: "assistant", createdAt: "2026-09-04T09:00:01Z", content: [{ type: "reasoning", provider: "claude-code", text: "private" }, { type: "text", text: "Checking." }, { type: "tool-call", id: "call-1", name: "Read", input: { file: "a.js" } }], metadata: {} },
      { id: "t1", role: "tool", createdAt: "2026-09-04T09:00:02Z", content: [{ type: "tool-result", callId: "call-1", output: "contents", isError: false }], metadata: {} }
    ],
    metadata: {}, events: [], lossless: { enabled: true }
  };
  const result = await adapter.writePortableSession(session, { cwd: "/tmp/project" });
  assert.ok(result.sessionId.startsWith("ses_"));
  assert.ok(importedPayload.info.id.startsWith("ses_"));
  assert.equal(importedPayload.info.metadata.ccbridgeSourceAdapter, "claude-code");
  assert.equal(importedPayload.messages.length, 2);
  const assistantParts = importedPayload.messages[1].parts;
  assert.deepEqual(assistantParts.map((part) => part.type), ["text", "tool"]);
  assert.equal(assistantParts[1].state.status, "completed");
  assert.equal(assistantParts[1].state.output, "contents");
  assert.equal(JSON.stringify(importedPayload).includes("private"), false);
});
