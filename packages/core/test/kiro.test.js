import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KiroCliAdapter } from "../src/adapters/kiro.js";
import { checkAdapterCompatibility } from "../src/compatibility.js";

const sessionId = "33333333-3333-4333-8333-333333333333";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

async function fixture({ unknownBlock = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-kiro-"));
  const sessions = path.join(root, "sessions", "cli");
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `${sessionId}.jsonl`);
  const metaFile = path.join(sessions, `${sessionId}.json`);
  const historyFile = path.join(sessions, `${sessionId}.history`);
  const extraDir = path.join(sessions, sessionId);
  await fs.mkdir(extraDir, { recursive: true });

  await fs.writeFile(metaFile, JSON.stringify({
    session_id: sessionId,
    cwd: "/work/kiro",
    title: "Kiro fixture",
    created_at: "2026-09-05T01:00:00.000Z",
    updated_at: "2026-09-05T01:05:00.000Z",
    session_state: {
      rts_model_state: {
        model_info: { model_name: "auto" }
      }
    }
  }, null, 2));
  await fs.writeFile(historyFile, "old prompt\nnew task\n", "utf8");
  await fs.writeFile(path.join(extraDir, "worker.json"), JSON.stringify({ kind: "companion", value: 1 }), "utf8");

  const records = [
    {
      version: 1,
      kind: "Prompt",
      timestamp: "2026-09-05T01:00:00.000Z",
      data: { content: [{ kind: "text", data: "old task" }] }
    },
    {
      version: 1,
      kind: "AssistantMessage",
      timestamp: "2026-09-05T01:00:01.000Z",
      data: { content: [{ kind: "text", data: "old answer" }] }
    },
    { version: 1, kind: "Clear", timestamp: "2026-09-05T01:01:00.000Z", data: {} },
    {
      version: 1,
      kind: "Prompt",
      timestamp: "2026-09-05T01:02:00.000Z",
      data: { messageId: "u-new", content: [{ kind: "text", data: "new task" }] }
    },
    {
      version: 1,
      kind: "AssistantMessage",
      timestamp: "2026-09-05T01:03:00.000Z",
      data: {
        messageId: "a-new",
        content: [
          { kind: "thinking", data: "private thought" },
          { kind: "text", data: "working" },
          { kind: "toolUse", data: { toolUseId: "tool-1", name: "read", input: { path: "a.txt" } } },
          ...(unknownBlock ? [{ kind: "futureBlock", data: { value: 42 } }] : [])
        ]
      }
    },
    {
      version: 1,
      kind: "ToolResults",
      timestamp: "2026-09-05T01:04:00.000Z",
      data: {
        messageId: "tool-result-message",
        content: [
          { kind: "toolResult", data: { toolUseId: "tool-1", status: "success", content: [{ kind: "text", data: "ok" }] } }
        ]
      }
    }
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n{broken-json\n`, "utf8");
  return { root, sessions, file, metaFile, historyFile, extraDir };
}

test("Kiro portable mode follows context after the latest Clear", async () => {
  const fx = await fixture();
  const adapter = new KiroCliAdapter({ kiroHome: fx.root, runner: noCli });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].title, "Kiro fixture");
  assert.equal(sessions[0].cwd, "/work/kiro");
  assert.equal(sessions[0].model, "auto");
  assert.equal(sessions[0].clearCount, 1);

  const session = await adapter.readSession(sessionId, { mode: "portable" });
  assert.equal(session.id, sessionId);
  assert.equal(session.cwd, "/work/kiro");
  assert.equal(session.metadata.clearCount, 1);
  assert.equal(session.metadata.model, "auto");
  const serialized = JSON.stringify(session.messages);
  assert.equal(serialized.includes("old task"), false);
  assert.equal(serialized.includes("old answer"), false);
  assert.equal(serialized.includes("private thought"), false);
  assert.equal(serialized.includes("new task"), true);
  assert.equal(serialized.includes("working"), true);

  const call = session.messages.flatMap((message) => message.content).find((part) => part.type === "tool-call");
  assert.deepEqual(call, { type: "tool-call", id: "tool-1", name: "read", input: { path: "a.txt" } });
  const result = session.messages.flatMap((message) => message.content).find((part) => part.type === "tool-result");
  assert.equal(result.callId, "tool-1");
  assert.equal(result.isError, false);
});

test("Kiro lossless mode preserves pre-Clear records, thinking, malformed JSON and side metadata", async () => {
  const fx = await fixture();
  const adapter = new KiroCliAdapter({ sessionRoots: [fx.sessions], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.sourceFormat, "kiro-cli/session-jsonl-v1");
  assert.equal(session.lossless.includesProviderReasoning, true);
  assert.equal(session.lossless.preservesPreClearHistoryAsRawEvents, true);
  assert.equal(session.lossless.companionMetadata, true);
  assert.equal(session.lossless.companionPromptHistory, true);
  assert.equal(session.metadata.kiroSessionMetadata.session_id, sessionId);
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "reasoning" && part.text === "private thought")));
  assert.ok(session.events.some((event) => event.kind === "event:Clear"));
  assert.ok(session.events.some((event) => event.kind === "malformed-json"));
  assert.ok(session.events.some((event) => JSON.stringify(event.data).includes("old task")));
});

test("Kiro native export includes JSON metadata, prompt history and session companions", async () => {
  const fx = await fixture();
  const adapter = new KiroCliAdapter({ sessionRoots: [fx.sessions], runner: noCli });
  const artifact = await adapter.getNativeArtifact(sessionId);
  assert.equal(artifact.format, "kiro-cli/session-jsonl-v1");
  assert.equal(artifact.path, fx.file);
  const names = artifact.companions.map((item) => item.filename).sort();
  assert.ok(names.includes(`${sessionId}.json`));
  assert.ok(names.includes(`${sessionId}.history`));
  assert.ok(names.includes("session/worker.json"));
});

test("Kiro compatibility reports schema drift for an unknown content block while preserving it losslessly", async () => {
  const fx = await fixture({ unknownBlock: true });
  const adapter = new KiroCliAdapter({ sessionRoots: [fx.sessions], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.includesUnknownContent, true);
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "kiro-unknown")));
  const report = await checkAdapterCompatibility(adapter, { sessionRef: sessionId });
  assert.equal(report.status, "drift-detected");
  assert.ok(report.sessionProbe.unknownContentTypes.includes("kiro-unknown"));
});
