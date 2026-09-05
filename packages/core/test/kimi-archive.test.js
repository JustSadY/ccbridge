import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KimiCodeAdapter } from "../src/adapters/kimi.js";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";

const sessionId = "55555555-5555-4555-8555-555555555555";
const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

test("Kimi lossless archive embeds state, main/subagent wires and arbitrary session companions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-kimi-archive-"));
  const sessionDir = path.join(home, "sessions", "wd_demo_123456789abc", sessionId);
  const main = path.join(sessionDir, "agents", "main");
  const sub = path.join(sessionDir, "agents", "agent-0");
  await fs.mkdir(path.join(main, "blobs"), { recursive: true });
  await fs.mkdir(sub, { recursive: true });
  await fs.mkdir(path.join(sessionDir, "tasks", "task-1"), { recursive: true });

  await fs.writeFile(path.join(sessionDir, "state.json"), JSON.stringify({ id: sessionId, version: 2, cwd: "/work/kimi", createdAt: 1788570000000, updatedAt: 1788570100000, archived: false, agents: { main: { type: "main" }, "agent-0": { type: "sub", parentAgentId: "main" } } }), "utf8");
  await fs.writeFile(path.join(main, "wire.jsonl"), `${JSON.stringify({ type: "context.append_message", time: 1788570001000, message: { role: "user", content: [{ type: "text", text: "hello" }], toolCalls: [] } })}\n`, "utf8");
  await fs.writeFile(path.join(sub, "wire.jsonl"), `${JSON.stringify({ type: "context.append_message", time: 1788570002000, message: { role: "assistant", content: [{ type: "text", text: "sub" }], toolCalls: [] } })}\n`, "utf8");
  await fs.writeFile(path.join(main, "blobs", "blob-a"), "bytes", "utf8");
  await fs.writeFile(path.join(sessionDir, "upcoming-goals.json"), JSON.stringify([{ objective: "later" }]), "utf8");
  await fs.writeFile(path.join(sessionDir, "tasks", "task-1", "output.log"), "output\n", "utf8");

  const adapter = new KimiCodeAdapter({ kimiHome: home, runner: noCli });
  const session = await adapter.readSession(sessionId, { mode: "lossless" });
  const artifact = await adapter.getNativeArtifact(sessionId);
  const archivePath = path.join(home, "kimi.ccbridge");
  const written = await writeCcbridgeArchive(session, { from: "kimi-code", destination: archivePath, mode: "lossless", nativeArtifact: artifact });
  assert.equal(written.embeddedNativeFormat, "kimi-code/session-dir-v1");
  assert.ok(written.embeddedCompanionCount >= 5);
  assert.ok(written.embeddedNativeBytes > 0);

  const archive = await readCcbridgeArchive(archivePath);
  assert.equal(archive.nativeArtifact.format, "kimi-code/session-dir-v1");
  assert.equal(path.basename(archive.nativeArtifact.filename), "state.json");
  const names = archive.nativeArtifact.companions.map((item) => item.filename);
  assert.ok(names.includes("agents/main/wire.jsonl"));
  assert.ok(names.includes("agents/agent-0/wire.jsonl"));
  assert.ok(names.includes("agents/main/blobs/blob-a"));
  assert.ok(names.includes("upcoming-goals.json"));
  assert.ok(names.includes("tasks/task-1/output.log"));
  assert.ok(archive.nativeArtifact.companions.every((item) => typeof item.content === "string" && item.content.length > 0));
});
