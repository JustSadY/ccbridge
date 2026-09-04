import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";

test("reads Codex rollout JSONL into a portable session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-codex-"));
  const dir = path.join(home, "sessions", "2026", "09", "04");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-test.jsonl");
  const rows = [
    { timestamp: "2026-09-04T09:00:00Z", type: "session_meta", payload: { id: "cx1", cwd: "/tmp/project" } },
    { timestamp: "2026-09-04T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] } },
    { timestamp: "2026-09-04T09:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    { timestamp: "2026-09-04T09:00:03Z", type: "response_item", payload: { type: "reasoning", summary: ["not portable"] } }
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const adapter = new CodexAdapter({ home, command: "definitely-not-installed" });
  const session = await adapter.readSession("cx1");
  assert.equal(session.id, "cx1");
  assert.equal(session.messages.length, 2);
  assert.equal(session.title, "Fix it");
  assert.equal(JSON.stringify(session).includes("not portable"), false);
});
