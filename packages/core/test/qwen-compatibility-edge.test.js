import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QwenCodeAdapter } from "../src/adapters/qwen.js";
import { checkAdapterCompatibility } from "../src/compatibility.js";

const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

test("Qwen compatibility does not let a known subtype hide an unknown record type", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-qwen-kind-"));
  const projects = path.join(root, "projects");
  const chats = path.join(projects, "project", "chats");
  await fs.mkdir(chats, { recursive: true });
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const file = path.join(chats, `${sessionId}.jsonl`);
  const records = [
    { uuid: "u1", parentUuid: null, sessionId, timestamp: "2026-09-04T10:00:00.000Z", type: "user", cwd: "/work/project", message: { role: "user", parts: [{ text: "hello" }] } },
    { uuid: "a1", parentUuid: "u1", sessionId, timestamp: "2026-09-04T10:00:01.000Z", type: "assistant", cwd: "/work/project", message: { role: "model", parts: [{ text: "hi" }] } },
    { uuid: "future", parentUuid: "a1", sessionId, timestamp: "2026-09-04T10:00:02.000Z", type: "future", subtype: "custom_title", cwd: "/work/project", systemPayload: { customTitle: "future record" } }
  ];
  await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const adapter = new QwenCodeAdapter({ sessionRoots: [projects], runner: noCli });
  const report = await checkAdapterCompatibility(adapter, { sessionRef: sessionId });
  assert.equal(report.status, "drift-detected");
  assert.ok(report.sessionProbe.unknownRecordKinds.includes("record:future:custom_title"));
  assert.match(report.sessionProbe.note, /Unknown raw records or content blocks/);
});
