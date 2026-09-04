import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VsCodeChatAdapter, reconstructVsCodeChatMutationLog } from "../src/adapters/vscode-chat.js";

function initialState() {
  return {
    version: 3,
    sessionId: "session-1",
    creationDate: 1700000000000,
    customTitle: "Copilot task",
    initialLocation: 1,
    responderUsername: "GitHub Copilot",
    workingDirectory: "file:///work/project",
    requests: [{
      requestId: "req-1",
      timestamp: 1700000001000,
      message: { text: "build it", parts: [] },
      variableData: { variables: [] },
      responseId: "resp-1",
      responseTimestamp: 1700000002000,
      response: [{ value: "starting" }]
    }]
  };
}

function mutationLog() {
  return [
    { kind: 0, v: initialState() },
    { kind: 1, k: ["requests", 0, "modelId"], v: "gpt-5" },
    { kind: 2, k: ["requests", 0, "response"], v: [
      { kind: "thinking", value: "private reasoning" },
      { kind: "toolInvocationSerialized", toolCallId: "tool-1", toolId: "terminal", toolSpecificData: { kind: "terminal", commandLine: { original: "pwd" }, terminalCommandOutput: { text: "/work/project" } } },
      { value: "done" }
    ] },
    { kind: 1, k: ["requests", 0, "completionTokens"], v: 12 }
  ].map(JSON.stringify).join("\n") + "\n";
}

test("VS Code mutation-log reconstruction applies set and push entries", () => {
  const result = reconstructVsCodeChatMutationLog(mutationLog());
  assert.equal(result.entryCount, 4);
  assert.equal(result.state.requests[0].modelId, "gpt-5");
  assert.equal(result.state.requests[0].response.length, 4);
  assert.equal(result.state.requests[0].completionTokens, 12);
});

test("VS Code adapter prefers jsonl over duplicate flat json snapshot", async () => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-vscode-chat-"));
  const dir = path.join(userRoot, "workspaceStorage", "workspace-1", "chatSessions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "session-1.json"), JSON.stringify({ ...initialState(), customTitle: "old flat" }));
  await fs.writeFile(path.join(dir, "session-1.jsonl"), mutationLog());
  const adapter = new VsCodeChatAdapter({ userRoot });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].storageKind, "mutation-log");
  assert.equal(sessions[0].title, "Copilot task");
});

test("VS Code portable read maps text and tools but hides thinking", async () => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-vscode-chat-"));
  const dir = path.join(userRoot, "workspaceStorage", "workspace-1", "chatSessions");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "session-1.jsonl");
  await fs.writeFile(file, mutationLog());
  const adapter = new VsCodeChatAdapter({ userRoot });
  const session = await adapter.readSession(file, { mode: "portable" });
  const parts = session.messages.flatMap((message) => message.content);
  assert.ok(parts.some((part) => part.type === "text" && part.text === "build it"));
  assert.ok(parts.some((part) => part.type === "tool-call" && part.id === "tool-1"));
  assert.ok(parts.some((part) => part.type === "tool-result" && part.output === "/work/project"));
  assert.equal(parts.some((part) => part.type === "reasoning"), false);
  assert.equal(session.metadata.storageKind, "mutation-log");
});

test("VS Code lossless read preserves thinking and raw response parts", async () => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-vscode-chat-"));
  const emptyDir = path.join(userRoot, "globalStorage", "emptyWindowChatSessions");
  await fs.mkdir(emptyDir, { recursive: true });
  const file = path.join(emptyDir, "session-1.jsonl");
  await fs.writeFile(file, mutationLog());
  const adapter = new VsCodeChatAdapter({ userRoot });
  const session = await adapter.readSession(file, { mode: "lossless" });
  assert.ok(session.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning" && part.text === "private reasoning"));
  assert.ok(session.events.some((event) => event.kind === "session-state"));
  assert.ok(session.events.some((event) => event.kind === "response-part:toolInvocationSerialized"));
  assert.equal(session.lossless.sourceFormat, "vscode-chat/session-v3");
  const artifact = await adapter.getNativeArtifact(file);
  assert.equal(artifact.format, "vscode-chat/session-v3");
});

test("VS Code adapter rejects unknown future session versions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-vscode-chat-"));
  const file = path.join(dir, "future.json");
  await fs.writeFile(file, JSON.stringify({ ...initialState(), version: 99 }));
  const adapter = new VsCodeChatAdapter({ userRoot: dir });
  await assert.rejects(() => adapter.readSession(file, { mode: "lossless" }), /Unsupported VS Code Chat session version/);
});
