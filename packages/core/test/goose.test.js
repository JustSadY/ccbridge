import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import { GooseAdapter } from "../src/adapters/goose.js";

function exportedSession() {
  return {
    id: "goose-1",
    working_dir: "/work/project",
    name: "Goose task",
    user_set_name: true,
    session_type: "user",
    created_at: "2026-09-04T10:00:00Z",
    updated_at: "2026-09-04T10:05:00Z",
    extension_data: { enabled: ["developer"] },
    usage: { input_tokens: 10, output_tokens: 5 },
    accumulated_usage: { input_tokens: 30, output_tokens: 15 },
    accumulated_cost: 0.02,
    recipe: null,
    conversation: [
      { id: "u1", role: "user", created: 1788516000000, content: [{ type: "text", text: "build it" }], metadata: { userVisible: true, agentVisible: true } },
      { id: "a1", role: "assistant", created: 1788516001000, content: [
        { type: "thinking", thinking: "private thought", signature: "sig" },
        { type: "toolRequest", id: "call-1", toolCall: { status: "success", value: { name: "shell", arguments: { command: "pwd" } } } },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }
      ], metadata: { userVisible: true, agentVisible: true, inference: { provider: "anthropic", requestedModel: "claude" }, usage: { inputTokens: 10, outputTokens: 5 } } },
      { id: "u2", role: "user", created: 1788516002000, content: [
        { type: "toolResponse", id: "call-1", toolResult: { status: "success", value: { content: [{ type: "text", text: "/work/project" }], isError: false } } }
      ], metadata: { userVisible: true, agentVisible: true } },
      { id: "a2", role: "assistant", created: 1788516003000, content: [
        { type: "redactedThinking", data: "opaque-provider-data" },
        { type: "document", data: "ZG9j", mimeType: "text/plain", name: "note.txt" },
        { type: "text", text: "done" }
      ], metadata: { userVisible: true, agentVisible: true } }
    ],
    message_count: 4,
    last_message_at: "2026-09-04T10:05:00Z",
    provider_name: "anthropic",
    model_config: { model: "claude" },
    goose_mode: "smart_approve",
    parent_session_id: null
  };
}

function mockRunner(calls) {
  return (_command, args) => {
    calls.push([...args]);
    if (args.length === 1 && args[0] === "--version") return { status: 0, stdout: "goose 1.20.0\n", stderr: "" };
    if (args.join(" ") === "session list --format json") return { status: 0, stdout: JSON.stringify([{ id: "goose-1", name: "Goose task", working_dir: "/work/project", created_at: "2026-09-04T10:00:00Z", updated_at: "2026-09-04T10:05:00Z", last_message_at: "2026-09-04T10:05:00Z", provider_name: "anthropic" }]), stderr: "" };
    if (args[0] === "session" && args[1] === "export") {
      assert.deepEqual(args, ["session", "export", "--session-id", "goose-1", "--format", "json"]);
      return { status: 0, stdout: JSON.stringify(exportedSession()), stderr: "" };
    }
    if (args[0] === "session" && args[1] === "import") {
      assert.equal(args.length, 3);
      assert.equal(fsSync.existsSync(args[2]), true);
      const input = fsSync.readFileSync(args[2], "utf8");
      assert.ok(input.length > 0);
      return { status: 0, stdout: "Detected format: Claude Code\nSession imported:\ngoose-target - Imported session\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
  };
}

test("Goose adapter uses official list/export CLI and portable mode hides thinking", async () => {
  const calls = [];
  const adapter = new GooseAdapter({ runner: mockRunner(calls) });
  const detected = await adapter.detect();
  assert.equal(detected.installed, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, "/work/project");

  const session = await adapter.readSession("goose-1", { mode: "portable" });
  const parts = session.messages.flatMap((message) => message.content);
  assert.equal(parts.some((part) => part.type === "reasoning"), false);
  assert.ok(parts.some((part) => part.type === "tool-call" && part.id === "call-1"));
  assert.ok(parts.some((part) => part.type === "tool-result" && part.callId === "call-1"));
  assert.equal(parts.filter((part) => part.type === "attachment").length, 2);
  assert.equal(session.metadata.providerName, "anthropic");
});

test("Goose lossless mode preserves thinking/redacted thinking and raw messages", async () => {
  const adapter = new GooseAdapter({ runner: mockRunner([]) });
  const session = await adapter.readSession("goose-1", { mode: "lossless" });
  const reasoning = session.messages.flatMap((message) => message.content).filter((part) => part.type === "reasoning");
  assert.equal(reasoning.length, 2);
  assert.equal(reasoning[0].text, "private thought");
  assert.equal(reasoning[1].encrypted, "opaque-provider-data");
  assert.equal(session.events.length, 4);
  assert.equal(session.lossless.sourceFormat, "goose/session-json");
});

test("Goose native target accepts Goose, Claude, Codex and Pi but exposes no exact native guarantee", async () => {
  const adapter = new GooseAdapter({ runner: mockRunner([]) });
  assert.equal(await adapter.acceptsNativeArtifact({ format: "goose/session-json" }), true);
  assert.equal(await adapter.acceptsNativeArtifact({ format: "claude-code/session-jsonl" }), true);
  assert.equal(await adapter.acceptsNativeArtifact({ format: "codex/rollout-jsonl" }), true);
  assert.equal(await adapter.acceptsNativeArtifact({ format: "pi/session-jsonl" }), true);
  assert.deepEqual(adapter.losslessNativeImports, []);
  assert.equal(adapter.nativeImportPreservation["goose/session-json"], "remapped");
});

test("Goose native import materializes in-memory artifacts and parses target id", async () => {
  const calls = [];
  const adapter = new GooseAdapter({ runner: mockRunner(calls) });
  const result = await adapter.importNativeArtifact({ format: "claude-code/session-jsonl", content: '{"type":"user"}\n', encoding: "utf8", sessionId: "claude-source" });
  assert.equal(result.imported, true);
  assert.equal(result.sourceFormat, "claude-code/session-jsonl");
  assert.equal(result.targetSessionId, "goose-target");
  assert.equal(result.targetName, "Imported session");
  assert.equal(result.preservation, "best-effort");
  assert.ok(calls.some((args) => args[0] === "session" && args[1] === "import"));
});

test("Goose self native import reports remapped preservation", async () => {
  const adapter = new GooseAdapter({ runner: mockRunner([]) });
  const result = await adapter.importNativeArtifact({ format: "goose/session-json", content: `${JSON.stringify(exportedSession())}\n`, encoding: "utf8", sessionId: "goose-1" });
  assert.equal(result.preservation, "remapped");
});
