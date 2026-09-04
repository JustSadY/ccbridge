import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen.js";
import { checkAdapterCompatibility } from "../src/compatibility.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

function record(overrides = {}) {
  return {
    uuid: overrides.uuid ?? "u1",
    parentUuid: Object.hasOwn(overrides, "parentUuid") ? overrides.parentUuid : null,
    sessionId,
    timestamp: overrides.timestamp ?? "2026-09-04T10:00:00.000Z",
    type: overrides.type ?? "user",
    cwd: "/work/qwen-project",
    version: "0.9.0",
    gitBranch: "main",
    ...overrides
  };
}

async function fixture({ includeUnknown = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-qwen-"));
  const projects = path.join(root, "projects");
  const projectDir = path.join(projects, "project-key");
  const chats = path.join(projectDir, "chats");
  await fs.mkdir(chats, { recursive: true });
  const file = path.join(chats, `${sessionId}.jsonl`);
  const futureParts = includeUnknown ? [{ futureField: { payload: "future-part" } }] : [];
  const records = [
    record({ uuid: "u1", parentUuid: null, type: "user", message: { role: "user", parts: [{ text: "old question" }] } }),
    record({ uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-09-04T10:00:01.000Z", model: "qwen3-coder", message: { role: "model", parts: [{ text: "old private thought", thought: true, thoughtSignature: "sig" }, { text: "old answer" }, { functionCall: { id: "call-old", name: "read_file", args: { file_path: "a.js" } } }] } }),
    record({ uuid: "t1", parentUuid: "a1", type: "tool_result", timestamp: "2026-09-04T10:00:02.000Z", message: { role: "user", parts: [{ functionResponse: { id: "call-old", name: "read_file", response: { output: "contents" } } }] } }),
    record({ uuid: "c1", parentUuid: "t1", type: "system", subtype: "chat_compression", timestamp: "2026-09-04T10:00:03.000Z", systemPayload: { info: { originalTokenCount: 10000 }, compressedHistory: [{ role: "user", parts: [{ text: "compressed prompt" }] }, { role: "model", parts: [{ text: "compressed hidden thought", thought: true }, { text: "compressed answer" }] }] } }),
    record({ uuid: "u2", parentUuid: "c1", type: "user", timestamp: "2026-09-04T10:00:04.000Z", systemPayload: { displayText: "visible next prompt", hookContext: "injected context" }, message: { role: "user", parts: [{ text: "model-facing prompt" }, { text: "<qwen:user-prompt-submit-context>\ninjected context\n</qwen:user-prompt-submit-context>" }] } }),
    record({ uuid: "branch", parentUuid: "u1", type: "user", timestamp: "2026-09-04T10:00:04.500Z", message: { role: "user", parts: [{ text: "inactive branch" }] } }),
    record({ uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-09-04T10:00:05.000Z", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }, message: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "aW1hZ2U=" }, videoMetadata: { fps: 24 } }, { executableCode: { language: "PYTHON", code: "print(1)" } }, { codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } }, ...futureParts, { text: "done" }] } }),
    record({ uuid: "title", parentUuid: "a2", type: "system", subtype: "custom_title", timestamp: "2026-09-04T10:00:06.000Z", systemPayload: { customTitle: "Qwen migration task", titleSource: "manual" } }),
    record({ uuid: "artifact", parentUuid: "title", type: "system", subtype: "session_artifact_event", timestamp: "2026-09-04T10:00:07.000Z", systemPayload: { artifact: "ignored-for-leaf" } })
  ];
  await fs.writeFile(file, `${records.map((item) => JSON.stringify(item)).join("\n")}\n{malformed\n`, "utf8");

  const subagents = path.join(projectDir, "subagents", sessionId);
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, "agent-agent-x.meta.json"), JSON.stringify({ agentId: "agent-x", agentType: "explore", description: "Inspect project", parentSessionId: sessionId, parentAgentId: null, createdAt: "2026-09-04T10:01:00.000Z", lastUpdatedAt: "2026-09-04T10:01:02.000Z", status: "completed", depth: 1, model: "qwen3-coder" }), "utf8");
  const agentRecords = [
    record({ uuid: "su1", parentUuid: null, type: "user", timestamp: "2026-09-04T10:01:00.000Z", agentId: "agent-x", agentName: "explore", isSidechain: true, message: { role: "user", parts: [{ text: "inspect" }] } }),
    record({ uuid: "sa1", parentUuid: "su1", type: "assistant", timestamp: "2026-09-04T10:01:01.000Z", agentId: "agent-x", agentName: "explore", isSidechain: true, message: { role: "model", parts: [{ text: "agent private", thought: true }, { text: "agent result" }] } })
  ];
  await fs.writeFile(path.join(subagents, "agent-agent-x.jsonl"), `${agentRecords.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  return { root, projects, projectDir, file };
}

test("Qwen Code lists project chat JSONL without treating subagent files as sessions", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const detected = await adapter.detect();
  assert.equal(detected.installed, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, sessionId);
  assert.equal(sessions[0].title, "Qwen migration task");
  assert.equal(sessions[0].activeLeafUuid, "title");
  assert.equal(sessions[0].subagentCount, 1);
});

test("Qwen portable mode follows active branch and current compression context", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "portable" });
  const serialized = JSON.stringify(session);
  assert.equal(session.title, "Qwen migration task");
  assert.equal(session.metadata.activeLeafUuid, "title");
  assert.equal(session.metadata.latestCompression.uuid, "c1");
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages[0].content[0].text, "compressed prompt");
  assert.equal(session.messages[1].content[0].text, "compressed answer");
  assert.equal(session.messages[2].content[0].text, "visible next prompt");
  assert.equal(serialized.includes("model-facing prompt"), false);
  assert.equal(serialized.includes("old question"), false);
  assert.equal(serialized.includes("inactive branch"), false);
  assert.equal(serialized.includes("compressed hidden thought"), false);
  assert.equal(serialized.includes("future-part"), false);
  assert.equal(serialized.includes("print(1)"), false);
  const attachment = session.messages[3].content.find((part) => part.type === "attachment" && part.mimeType === "image/png");
  assert.ok(attachment);
  assert.deepEqual(attachment.metadata.videoMetadata, { fps: 24 });
  assert.equal(session.agents.length, 1);
  assert.equal(session.agents[0].id, "agent-x");
  assert.equal(JSON.stringify(session.agents[0]).includes("agent private"), false);
});

test("Qwen lossless mode preserves known private parts, unknown parts, branches and subagents", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.enabled, true);
  assert.equal(session.lossless.sourceFormat, "qwen-code/session-jsonl");
  assert.equal(session.lossless.includesProviderReasoning, true);
  assert.equal(session.lossless.includesUnknownContent, true);
  assert.equal(session.lossless.includesSubagents, true);
  assert.equal(session.lossless.preservesInactiveBranchesAsRawEvents, true);
  assert.equal(session.metadata.malformedLineCount, 1);
  assert.ok(session.events.some((event) => event.kind === "malformed-json"));
  assert.ok(session.events.some((event) => JSON.stringify(event.data).includes("inactive branch")));
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "reasoning" && part.text === "compressed hidden thought")));
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "qwen-executable-code" && part.executableCode?.code === "print(1)")));
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "qwen-code-execution-result" && part.codeExecutionResult?.output === "1\n")));
  assert.ok(session.messages.some((message) => message.content.some((part) => part.type === "qwen-unknown" && part.raw?.futureField?.payload === "future-part")));
  assert.ok(session.agents[0].messages.some((message) => message.content.some((part) => part.type === "reasoning" && part.text === "agent private")));
});

test("Qwen compatibility accepts current GenAI code parts without schema drift", async () => {
  const fx = await fixture({ includeUnknown: false });
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  assert.equal(session.lossless.includesUnknownContent, false);
  const report = await checkAdapterCompatibility(adapter, { sessionRef: sessionId });
  assert.equal(report.status, "schema-known");
  assert.equal(report.sessionProbe.driftDetected, false);
  assert.deepEqual(report.sessionProbe.unknownContentTypes, []);
  assert.ok(report.sessionProbe.contentTypes.includes("qwen-executable-code"));
  assert.ok(report.sessionProbe.contentTypes.includes("qwen-code-execution-result"));
});

test("Qwen compatibility reports genuinely unknown GenAI parts as schema drift", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const report = await checkAdapterCompatibility(adapter, { sessionRef: sessionId });
  assert.equal(report.status, "drift-detected");
  assert.equal(report.sessionProbe.driftDetected, true);
  assert.ok(report.sessionProbe.unknownContentTypes.includes("qwen-unknown"));
});

test("Qwen native export exposes root JSONL and byte-level subagent companions", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const artifact = await adapter.getNativeArtifact(sessionId);
  assert.equal(artifact.format, "qwen-code/session-jsonl");
  assert.equal(artifact.path, fx.file);
  assert.equal(artifact.sessionId, sessionId);
  assert.deepEqual(artifact.companions.map((item) => item.filename).sort(), ["subagents/agent-agent-x.jsonl", "subagents/agent-agent-x.meta.json"]);
  assert.deepEqual(artifact.companions.map((item) => item.mediaType).sort(), ["application/json", "application/x-ndjson"]);
  assert.equal(adapter.capabilities.nativeImport, false);
});
