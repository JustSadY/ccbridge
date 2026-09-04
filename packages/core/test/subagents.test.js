import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude.js";
import { analyzeSessionFeatures } from "../src/fidelity.js";

function rows(sessionId, text, model = "claude-sonnet") {
  return [
    { type: "user", sessionId, uuid: `${text}-u`, cwd: "/tmp/project", timestamp: "2026-09-04T09:00:00Z", message: { role: "user", content: text } },
    { type: "assistant", sessionId, uuid: `${text}-a`, parentUuid: `${text}-u`, cwd: "/tmp/project", timestamp: "2026-09-04T09:00:01Z", message: { role: "assistant", model, content: [{ type: "text", text: `${text} result` }] } }
  ];
}
async function writeJsonl(file, values) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, values.map(JSON.stringify).join("\n") + "\n"); }

test("Claude subagent transcripts are attached to the parent session agent tree", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-subagents-"));
  const project = path.join(home, "projects", "-tmp-project");
  const main = path.join(project, "main-session.jsonl");
  await writeJsonl(main, rows("s-main", "main"));

  const agentsRoot = path.join(project, "s-main", "subagents");
  const reviewer = path.join(agentsRoot, "agent-review1.jsonl");
  await writeJsonl(reviewer, rows("s-main", "review"));
  await fs.writeFile(reviewer.replace(/\.jsonl$/, ".meta.json"), JSON.stringify({ agentType: "security-reviewer" }));

  const workflow = path.join(agentsRoot, "workflows", "wf_build", "agent-builder1.jsonl");
  await writeJsonl(workflow, rows("s-main", "build"));

  const adapter = new ClaudeCodeAdapter({ home });
  const listed = await adapter.listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "s-main");

  const session = await adapter.readSession("s-main", { mode: "lossless" });
  assert.equal(session.agents.length, 2);
  const review = session.agents.find((agent) => agent.id === "review1");
  const build = session.agents.find((agent) => agent.id === "builder1");
  assert.equal(review.name, "security-reviewer");
  assert.equal(review.messages[0].content[0].text, "review");
  assert.ok(review.events.length > 0);
  assert.equal(build.kind, "workflow-subagent");
  assert.equal(build.metadata.workflowId, "wf_build");
  assert.equal(session.lossless.includesSubagents, true);
  assert.equal(analyzeSessionFeatures(session).subagent, 2);
});
