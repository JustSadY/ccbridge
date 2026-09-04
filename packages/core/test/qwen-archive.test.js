import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen.js";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";

const sessionId = "22222222-2222-4222-8222-222222222222";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

test("Qwen lossless archive embeds root transcript plus subagent JSONL and metadata companions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-qwen-archive-"));
  const projects = path.join(root, "projects");
  const projectDir = path.join(projects, "project-key");
  const chats = path.join(projectDir, "chats");
  const subagents = path.join(projectDir, "subagents", sessionId);
  await fs.mkdir(chats, { recursive: true });
  await fs.mkdir(subagents, { recursive: true });

  const rootFile = path.join(chats, `${sessionId}.jsonl`);
  await fs.writeFile(rootFile, `${JSON.stringify({ uuid: "u1", parentUuid: null, sessionId, timestamp: "2026-09-04T12:00:00.000Z", type: "user", cwd: "/work/qwen", version: "0.9.0", message: { role: "user", parts: [{ text: "hello" }] } })}\n`, "utf8");
  await fs.writeFile(path.join(subagents, "agent-a.jsonl"), `${JSON.stringify({ uuid: "su1", parentUuid: null, sessionId, timestamp: "2026-09-04T12:00:01.000Z", type: "user", cwd: "/work/qwen", version: "0.9.0", agentId: "a", isSidechain: true, message: { role: "user", parts: [{ text: "subagent" }] } })}\n`, "utf8");
  await fs.writeFile(path.join(subagents, "agent-a.meta.json"), JSON.stringify({ agentId: "a", parentSessionId: sessionId, agentType: "explore" }), "utf8");

  const adapter = new QwenCodeAdapter({ sessionRoots: [projects], runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  const artifact = await adapter.getNativeArtifact(sessionId);
  const archivePath = path.join(root, "qwen.ccbridge");
  const written = await writeCcbridgeArchive(session, { from: "qwen-code", destination: archivePath, mode: "lossless", nativeArtifact: artifact });
  assert.equal(written.embeddedNativeFormat, "qwen-code/session-jsonl");
  assert.equal(written.embeddedCompanionCount, 2);
  assert.ok(written.embeddedNativeBytes > 0);

  const archive = await readCcbridgeArchive(archivePath);
  assert.equal(archive.nativeArtifact.format, "qwen-code/session-jsonl");
  assert.deepEqual(archive.nativeArtifact.companions.map((item) => item.filename).sort(), ["subagents/agent-a.jsonl", "subagents/agent-a.meta.json"]);
  assert.ok(archive.nativeArtifact.companions.every((item) => typeof item.content === "string" && item.content.length > 0));
});
