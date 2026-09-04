import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen-resume.js";

const sessionId = "22222222-2222-4222-8222-222222222222";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

function record(overrides = {}) {
  return {
    uuid: overrides.uuid ?? "r1",
    parentUuid: Object.hasOwn(overrides, "parentUuid") ? overrides.parentUuid : null,
    sessionId,
    timestamp: overrides.timestamp ?? "2026-09-04T12:00:00.000Z",
    type: overrides.type ?? "user",
    cwd: "/work/qwen-fork",
    version: "0.9.0",
    gitBranch: "main",
    agentId: overrides.agentId,
    agentName: overrides.agentName,
    isSidechain: overrides.isSidechain,
    ...overrides
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-qwen-fork-"));
  const projects = path.join(root, "projects");
  const projectDir = path.join(projects, "project-key");
  const chats = path.join(projectDir, "chats");
  await fs.mkdir(chats, { recursive: true });
  await fs.writeFile(path.join(chats, `${sessionId}.jsonl`), [
    record({ uuid: "root-u", parentUuid: null, type: "user", provenance: "real_user", forkedFrom: { sessionId: "parent-session", messageUuid: "root-u" }, message: { role: "user", parts: [{ text: "parent task" }] } }),
    record({ uuid: "root-a", parentUuid: "root-u", type: "assistant", provenance: "assistant_output", contextWindowSize: 131072, message: { role: "model", parts: [{ text: "parent answer" }] } })
  ].map(JSON.stringify).join("\n") + "\n", "utf8");

  const subagents = path.join(projectDir, "subagents", sessionId);
  await fs.mkdir(subagents, { recursive: true });
  await fs.writeFile(path.join(subagents, "agent-fork-1.meta.json"), JSON.stringify({
    agentId: "fork-1",
    agentType: "fork",
    description: "Forked implementation task",
    parentSessionId: sessionId,
    parentAgentId: null,
    createdAt: "2026-09-04T12:01:00.000Z",
    lastUpdatedAt: "2026-09-04T12:01:03.000Z",
    status: "completed",
    depth: 1,
    model: "qwen3-coder"
  }), "utf8");

  const agentRecords = [
    record({
      uuid: "bootstrap",
      parentUuid: null,
      type: "system",
      subtype: "agent_bootstrap",
      timestamp: "2026-09-04T12:01:00.000Z",
      agentId: "fork-1",
      agentName: "fork",
      isSidechain: true,
      systemPayload: {
        kind: "fork",
        history: [
          { role: "user", parts: [{ text: "bootstrap user" }] },
          { role: "model", parts: [{ text: "bootstrap private", thought: true }, { text: "bootstrap answer" }] }
        ]
      }
    }),
    record({
      uuid: "launch-seed",
      parentUuid: "bootstrap",
      type: "user",
      timestamp: "2026-09-04T12:01:01.000Z",
      agentId: "fork-1",
      agentName: "fork",
      isSidechain: true,
      message: { role: "user", parts: [{ text: "visible launch seed" }] }
    }),
    record({
      uuid: "launch-prompt",
      parentUuid: "launch-seed",
      type: "system",
      subtype: "agent_launch_prompt",
      timestamp: "2026-09-04T12:01:02.000Z",
      agentId: "fork-1",
      agentName: "fork",
      isSidechain: true,
      systemPayload: { displayText: "Begin fork task." }
    }),
    record({
      uuid: "runtime-a",
      parentUuid: "launch-prompt",
      type: "assistant",
      timestamp: "2026-09-04T12:01:03.000Z",
      agentId: "fork-1",
      agentName: "fork",
      agentColor: "blue",
      agentRunId: "run-7",
      agentRound: 2,
      provenance: "assistant_output",
      goalContext: { goalId: "goal-1", revision: 3, turnId: "turn-2" },
      isSidechain: true,
      message: { role: "model", parts: [{ text: "runtime answer" }] }
    })
  ];
  await fs.writeFile(path.join(subagents, "agent-fork-1.jsonl"), agentRecords.map(JSON.stringify).join("\n") + "\n", "utf8");
  return { projects };
}

test("Qwen fork subagent portable history matches resume bootstrap semantics", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "portable" });
  assert.equal(session.metadata.qwenForkBootstrapAgentCount, 1);
  assert.equal(session.agents.length, 1);
  assert.deepEqual(session.messages[0].metadata.qwenRecord.forkedFrom, { sessionId: "parent-session", messageUuid: "root-u" });
  assert.equal(session.messages[1].metadata.qwenRecord.contextWindowSize, 131072);
  const agent = session.agents[0];
  assert.equal(agent.metadata.qwenForkBootstrap.enabled, true);
  assert.equal(agent.metadata.qwenForkBootstrap.inheritedMessageCount, 2);
  assert.equal(agent.metadata.qwenForkBootstrap.removedLaunchSeedUuid, "launch-seed");
  const text = agent.messages.map((message) => message.content.filter((part) => part.type === "text").map((part) => part.text).join(" "));
  assert.deepEqual(text, ["bootstrap user", "bootstrap answer", "Begin fork task.", "runtime answer"]);
  assert.equal(JSON.stringify(agent.messages).includes("visible launch seed"), false);
  assert.equal(JSON.stringify(agent.messages).includes("bootstrap private"), false);
  assert.equal(agent.messages[0].parentId, null);
  for (let index = 1; index < agent.messages.length; index += 1) assert.equal(agent.messages[index].parentId, agent.messages[index - 1].id);
  const runtime = agent.messages.at(-1);
  assert.equal(runtime.metadata.qwenOriginalParentId, "launch-prompt");
  assert.equal(runtime.metadata.qwenRecord.agentRunId, "run-7");
  assert.equal(runtime.metadata.qwenRecord.agentRound, 2);
  assert.equal(runtime.metadata.qwenRecord.agentColor, "blue");
  assert.deepEqual(runtime.metadata.qwenRecord.goalContext, { goalId: "goal-1", revision: 3, turnId: "turn-2" });
});

test("Qwen fork subagent lossless history keeps bootstrap thinking and recomputes flags", async () => {
  const fx = await fixture();
  const adapter = new QwenCodeAdapter({ sessionRoots: [fx.projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  const agent = session.agents[0];
  assert.equal(session.lossless.includesProviderReasoning, true);
  assert.ok(agent.messages.some((message) => message.content.some((part) => part.type === "reasoning" && part.text === "bootstrap private")));
  assert.equal(JSON.stringify(agent.messages).includes("visible launch seed"), false);
  assert.ok(agent.events.some((event) => event.kind === "record:system:agent_bootstrap"));
  assert.ok(agent.events.some((event) => event.kind === "record:system:agent_launch_prompt"));
});
