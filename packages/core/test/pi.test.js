import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiAdapter } from "../src/adapters/pi.js";

async function writeJsonl(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-pi-"));
  const file = path.join(root, "--work-project--", "2026-09-04_session.jsonl");
  await writeJsonl(file, [
    { type: "session", version: 3, id: "pi-session", timestamp: "2026-09-04T10:00:00.000Z", cwd: "/work/project" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-09-04T10:00:01.000Z", message: { role: "user", content: "start", timestamp: 1788516001000 } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-04T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "base" }], provider: "anthropic", model: "claude", usage: { input: 1, output: 1 }, stopReason: "stop", timestamp: 1788516002000 } },
    { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-04T10:00:03.000Z", message: { role: "user", content: "abandoned branch", timestamp: 1788516003000 } },
    { type: "message", id: "a2", parentId: "u2", timestamp: "2026-09-04T10:00:04.000Z", message: { role: "assistant", content: [{ type: "text", text: "abandoned answer" }], provider: "anthropic", model: "claude", usage: {}, stopReason: "stop", timestamp: 1788516004000 } },
    { type: "branch_summary", id: "bs1", parentId: "a1", timestamp: "2026-09-04T10:00:05.000Z", summary: "work from abandoned branch", fromId: "a2", details: { readFiles: ["old.ts"] } },
    { type: "message", id: "u3", parentId: "bs1", timestamp: "2026-09-04T10:00:06.000Z", message: { role: "user", content: [{ type: "text", text: "current branch" }], timestamp: 1788516006000 } },
    { type: "message", id: "a3", parentId: "u3", timestamp: "2026-09-04T10:00:07.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "private pi thought" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }, { type: "text", text: "reading" }], provider: "openai", model: "gpt-test", usage: { input: 10, output: 5 }, stopReason: "toolUse", timestamp: 1788516007000 } },
    { type: "message", id: "tr1", parentId: "a3", timestamp: "2026-09-04T10:00:08.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }, { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }], details: { path: "a.txt" }, isError: false, timestamp: 1788516008000 } },
    { type: "compaction", id: "cmp1", parentId: "tr1", timestamp: "2026-09-04T10:00:09.000Z", summary: "compacted working context", firstKeptEntryId: "u3", tokensBefore: 1000, details: { readFiles: ["a.txt"], modifiedFiles: [] } },
    { type: "session_info", id: "info1", parentId: "cmp1", timestamp: "2026-09-04T10:00:10.000Z", name: "Pi task" },
    { type: "message", id: "u4", parentId: "info1", timestamp: "2026-09-04T10:00:11.000Z", message: { role: "user", content: "continue", timestamp: 1788516011000 } },
    { type: "message", id: "a4", parentId: "u4", timestamp: "2026-09-04T10:00:12.000Z", message: { role: "assistant", content: [{ type: "text", text: "final" }], provider: "openai", model: "gpt-test", usage: {}, stopReason: "stop", timestamp: 1788516012000 } },
    { type: "model_change", id: "model1", parentId: "a4", timestamp: "2026-09-04T10:00:13.000Z", provider: "openai", modelId: "gpt-next" },
    { type: "thinking_level_change", id: "think1", parentId: "model1", timestamp: "2026-09-04T10:00:14.000Z", thinkingLevel: "high" },
    { type: "custom", id: "custom1", parentId: "think1", timestamp: "2026-09-04T10:00:15.000Z", customType: "fixture", data: { opaque: true } }
  ]);
  return { root, file };
}

test("Pi adapter discovers v3 JSONL sessions and uses header cwd", async () => {
  const { root } = await fixture();
  const adapter = new PiAdapter({ sessionRoots: [root] });
  const detected = await adapter.detect();
  assert.equal(detected.installed, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "pi-session");
  assert.equal(sessions[0].title, "Pi task");
  assert.equal(sessions[0].cwd, "/work/project");
  assert.equal(sessions[0].version, 3);
});

test("Pi portable mode follows active branch and current compaction context", async () => {
  const { root } = await fixture();
  const adapter = new PiAdapter({ sessionRoots: [root] });
  const session = await adapter.readSession("pi-session", { mode: "portable" });
  const text = session.messages.flatMap((message) => message.content).filter((part) => part.type === "text").map((part) => part.text);
  assert.equal(text.includes("abandoned branch"), false);
  assert.equal(text.includes("abandoned answer"), false);
  assert.equal(text.includes("start"), false);
  assert.equal(text.includes("compacted working context"), true);
  assert.equal(text.includes("current branch"), true);
  assert.equal(text.includes("continue"), true);
  const parts = session.messages.flatMap((message) => message.content);
  assert.equal(parts.some((part) => part.type === "reasoning"), false);
  assert.ok(parts.some((part) => part.type === "tool-call" && part.id === "call-1"));
  assert.ok(parts.some((part) => part.type === "tool-result" && part.callId === "call-1"));
  assert.ok(parts.some((part) => part.type === "attachment" && part.mimeType === "image/png"));
  assert.equal(session.metadata.currentProvider, "openai");
  assert.equal(session.metadata.currentModel, "gpt-next");
  assert.equal(session.metadata.currentThinkingLevel, "high");
  assert.equal(session.metadata.latestCompaction.tokensBefore, 1000);
});

test("Pi lossless mode preserves thinking and inactive branches as raw events", async () => {
  const { file } = await fixture();
  const adapter = new PiAdapter({ sessionRoots: [path.dirname(path.dirname(file))] });
  const session = await adapter.readSession(file, { mode: "lossless" });
  const reasoning = session.messages.flatMap((message) => message.content).find((part) => part.type === "reasoning");
  assert.equal(reasoning.text, "private pi thought");
  assert.ok(session.events.some((event) => event.kind === "entry:message" && event.data?.id === "u2"));
  assert.ok(session.events.some((event) => event.kind === "entry:custom" && event.data?.id === "custom1"));
  assert.equal(session.lossless.sourceFormat, "pi/session-jsonl-v3");
  assert.equal(session.lossless.preservesInactiveBranchesAsRawEvents, true);
  assert.equal(session.events.length, 16);
});

test("Pi native artifact keeps the original JSONL for native targets", async () => {
  const { root } = await fixture();
  const adapter = new PiAdapter({ sessionRoots: [root] });
  const artifact = await adapter.getNativeArtifact("pi-session");
  assert.equal(artifact.format, "pi/session-jsonl");
  assert.equal(artifact.formatVersion, 3);
  assert.equal(artifact.cwd, "/work/project");
  assert.equal(artifact.sessionId, "pi-session");
  assert.ok(artifact.path.endsWith(".jsonl"));
});
