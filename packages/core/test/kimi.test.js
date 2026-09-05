import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KimiCodeAdapter } from "../src/adapters/kimi.js";
import { checkAdapterCompatibility } from "../src/compatibility.js";

const sessionId = "44444444-4444-4444-8444-444444444444";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });
const line = (record) => JSON.stringify(record);

async function fixture({ unknownRecord = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-kimi-"));
  const sessionDir = path.join(home, "sessions", "wd_project_abcd12345678", sessionId);
  const mainDir = path.join(sessionDir, "agents", "main");
  const subDir = path.join(sessionDir, "agents", "agent-0");
  await fs.mkdir(path.join(mainDir, "blobs"), { recursive: true });
  await fs.mkdir(path.join(mainDir, "plans"), { recursive: true });
  await fs.mkdir(subDir, { recursive: true });
  await fs.mkdir(path.join(sessionDir, "tasks", "task-1"), { recursive: true });
  await fs.mkdir(path.join(sessionDir, "cron"), { recursive: true });

  await fs.writeFile(path.join(sessionDir, "state.json"), JSON.stringify({
    id: sessionId,
    version: 2,
    cwd: "/work/kimi",
    title: "Kimi fixture",
    titleKind: "custom",
    lastPrompt: "new task",
    createdAt: 1788570000000,
    updatedAt: 1788570300000,
    archived: false,
    forkedFrom: "parent-session",
    custom: { project: "demo" },
    lastTurnReason: "completed",
    agents: {
      main: { type: "main", homedir: mainDir },
      "agent-0": { type: "sub", homedir: subDir, parentAgentId: "main", forkedFrom: "main", labels: { name: "researcher" } }
    }
  }, null, 2));
  await fs.writeFile(path.join(sessionDir, "upcoming-goals.json"), JSON.stringify([{ objective: "later" }]), "utf8");
  await fs.writeFile(path.join(mainDir, "plans", "plan-1.md"), "# Plan\n", "utf8");
  await fs.writeFile(path.join(mainDir, "blobs", "abc123"), "image-bytes", "utf8");
  await fs.writeFile(path.join(sessionDir, "tasks", "task-1.json"), JSON.stringify({ status: "done" }), "utf8");
  await fs.writeFile(path.join(sessionDir, "tasks", "task-1", "output.log"), "task output\n", "utf8");
  await fs.writeFile(path.join(sessionDir, "cron", "job.json"), JSON.stringify({ schedule: "daily" }), "utf8");

  const oldMessage = {
    role: "user",
    content: [{ type: "text", text: "old task" }],
    toolCalls: [],
    origin: { kind: "user" }
  };
  const newMessage = {
    role: "user",
    content: [{ type: "text", text: "new task" }, { type: "image_url", imageUrl: { url: "blobref:image/png;abc123", id: "img-1" } }],
    toolCalls: [],
    origin: { kind: "user" }
  };
  const mainRecords = [
    { type: "metadata", protocol_version: "1.5", created_at: 1788570000000 },
    { type: "context.append_message", time: 1788570000001, message: oldMessage },
    { type: "context.clear", time: 1788570010000 },
    { type: "context.append_message", time: 1788570020000, message: newMessage },
    { type: "context.append_loop_event", time: 1788570021000, event: { type: "step.begin", uuid: "step-1", turnId: "1", step: 1 } },
    { type: "context.append_loop_event", time: 1788570022000, event: { type: "content.part", stepUuid: "step-1", part: { type: "think", think: "private reasoning", encrypted: "sig-1" } } },
    { type: "context.append_loop_event", time: 1788570023000, event: { type: "content.part", stepUuid: "step-1", part: { type: "text", text: "working" } } },
    { type: "context.append_loop_event", time: 1788570024000, event: { type: "tool.call", stepUuid: "step-1", toolCallId: "call-1", name: "Read", args: { path: "a.txt" } } },
    { type: "context.append_loop_event", time: 1788570025000, event: { type: "tool.result", stepUuid: "step-1", toolCallId: "call-1", result: { output: "file contents", isError: false, note: "ok" } } },
    { type: "context.append_loop_event", time: 1788570026000, event: { type: "step.end", uuid: "step-1", usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 } } },
    ...(unknownRecord ? [{ type: "future.new_operation", time: 1788570027000, payload: { value: 1 } }] : [])
  ];
  await fs.writeFile(path.join(mainDir, "wire.jsonl"), `${mainRecords.map(line).join("\n")}\n`, "utf8");

  const subRecords = [
    { type: "metadata", protocol_version: "1.5", created_at: 1788570030000 },
    { type: "context.append_message", time: 1788570031000, message: { role: "user", content: [{ type: "text", text: "sub task" }], toolCalls: [], origin: { kind: "user" } } },
    { type: "context.append_message", time: 1788570032000, message: { role: "assistant", content: [{ type: "think", think: "sub private", encrypted: "sub-sig" }, { type: "text", text: "sub answer" }], toolCalls: [] } }
  ];
  await fs.writeFile(path.join(subDir, "wire.jsonl"), `${subRecords.map(line).join("\n")}\n`, "utf8");
  return { home, sessionDir, mainDir, subDir };
}

test("Kimi portable mode reconstructs current main context and subagent tree", async () => {
  const fx = await fixture();
  const adapter = new KimiCodeAdapter({ kimiHome: fx.home, runner: noCli });
  const listed = await adapter.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, sessionId);
  assert.equal(listed[0].title, "Kimi fixture");
  assert.equal(listed[0].cwd, "/work/kimi");
  assert.equal(listed[0].agentCount, 2);

  const session = await adapter.readSession(sessionId, { mode: "portable" });
  assert.equal(session.metadata.forkedFrom, "parent-session");
  assert.equal(session.agents.length, 1);
  assert.equal(session.agents[0].id, "agent-0");
  assert.equal(session.agents[0].parentId, "main");
  assert.equal(session.agents[0].name, "researcher");
  const serialized = JSON.stringify(session.messages);
  assert.equal(serialized.includes("old task"), false);
  assert.equal(serialized.includes("new task"), true);
  assert.equal(serialized.includes("private reasoning"), false);
  assert.equal(serialized.includes("working"), true);
  const call = session.messages.flatMap((message) => message.content).find((part) => part.type === "tool-call");
  assert.deepEqual(call, { type: "tool-call", id: "call-1", name: "Read", input: { path: "a.txt" } });
  const result = session.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result");
  assert.equal(result.callId, "call-1");
  assert.equal(result.output, "file contents");
  const image = session.messages.flatMap((message) => message.content).find((part) => part.type === "attachment");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.path, path.join(fx.mainDir, "blobs", "abc123"));
});

test("Kimi lossless mode retains reasoning signatures and all raw wire records", async () => {
  const fx = await fixture();
  const adapter = new KimiCodeAdapter({ kimiHome: fx.home, runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.sourceFormat, "kimi-code/session-dir-v1");
  assert.equal(session.lossless.includesProviderReasoning, true);
  assert.equal(session.lossless.includesSubagents, true);
  assert.ok(session.events.some((event) => event.kind === "wire:context.clear"));
  assert.ok(session.events.some((event) => JSON.stringify(event.data).includes("old task")));
  const reasoning = session.messages.flatMap((message) => message.content).find((part) => part.type === "reasoning");
  assert.equal(reasoning.text, "private reasoning");
  assert.equal(reasoning.encrypted, "sig-1");
  const subReasoning = session.agents[0].messages.flatMap((message) => message.content).find((part) => part.type === "reasoning");
  assert.equal(subReasoning.text, "sub private");
  assert.equal(subReasoning.encrypted, "sub-sig");
});

test("Kimi native artifact preserves the complete session directory as companions", async () => {
  const fx = await fixture();
  const adapter = new KimiCodeAdapter({ kimiHome: fx.home, runner: noCli });
  const artifact = await adapter.getNativeArtifact(sessionId);
  assert.equal(artifact.format, "kimi-code/session-dir-v1");
  assert.equal(artifact.path, path.join(fx.sessionDir, "state.json"));
  const names = artifact.companions.map((item) => item.filename);
  assert.ok(names.includes("agents/main/wire.jsonl"));
  assert.ok(names.includes("agents/agent-0/wire.jsonl"));
  assert.ok(names.includes("agents/main/blobs/abc123"));
  assert.ok(names.includes("agents/main/plans/plan-1.md"));
  assert.ok(names.includes("upcoming-goals.json"));
  assert.ok(names.includes("tasks/task-1/output.log"));
  assert.ok(names.includes("cron/job.json"));
});

test("Kimi compatibility flags new wire record types while preserving them raw", async () => {
  const fx = await fixture({ unknownRecord: true });
  const adapter = new KimiCodeAdapter({ kimiHome: fx.home, runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.includesUnknownEvents, true);
  assert.ok(session.events.some((event) => event.kind === "wire:future.new_operation"));
  const report = await checkAdapterCompatibility(adapter, { sessionRef: sessionId });
  assert.equal(report.status, "drift-detected");
  assert.ok(report.sessionProbe.unknownRecordKinds.includes("wire:future.new_operation"));
});

test("Kimi compaction marks semantic approximation so strict fidelity can see it in metadata", async () => {
  const fx = await fixture();
  const wire = path.join(fx.mainDir, "wire.jsonl");
  await fs.appendFile(wire, `${JSON.stringify({ type: "context.apply_compaction", time: 1788570040000, summary: "summary", compactedCount: 4, keptUserMessageCount: 1, tokensBefore: 100, tokensAfter: 20 })}\n`);
  await fs.appendFile(wire, `${JSON.stringify({ type: "context.append_message", time: 1788570041000, message: { role: "user", content: [{ type: "text", text: "after compact" }], toolCalls: [], origin: { kind: "user" } } })}\n`);
  const adapter = new KimiCodeAdapter({ kimiHome: fx.home, runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "portable" });
  assert.equal(session.metadata.compactionApproximation, true);
  assert.equal(JSON.stringify(session.messages).includes("summary"), true);
  assert.equal(JSON.stringify(session.messages).includes("after compact"), true);
  assert.equal(JSON.stringify(session.messages).includes("new task"), false);
});
