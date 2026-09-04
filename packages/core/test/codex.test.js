import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-codex-"));
  const dir = path.join(home, "sessions", "2026", "09", "04");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "rollout-test.jsonl");
  const rows = [
    { timestamp: "2026-09-04T09:00:00Z", type: "session_meta", payload: { id: "cx1", cwd: "/tmp/project" } },
    { timestamp: "2026-09-04T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] } },
    { timestamp: "2026-09-04T09:00:02Z", type: "response_item", payload: { type: "reasoning", summary: ["private summary"], encrypted_content: "opaque-reasoning" } },
    { timestamp: "2026-09-04T09:00:03Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
    { timestamp: "2026-09-04T09:00:04Z", type: "event_msg", payload: { type: "token_count", input_tokens: 100 } }
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { home, rows };
}

test("reads Codex rollout JSONL into a portable session", async () => {
  const { home } = await fixture();
  const adapter = new CodexAdapter({ home, command: "definitely-not-installed" });
  const session = await adapter.readSession("cx1");
  assert.equal(session.id, "cx1");
  assert.equal(session.messages.length, 2);
  assert.equal(session.title, "Fix it");
  assert.equal(session.events.length, 0);
  assert.equal(JSON.stringify(session).includes("private summary"), false);
});

test("lossless Codex reads preserve reasoning and non-message events", async () => {
  const { home, rows } = await fixture();
  const adapter = new CodexAdapter({ home, command: "definitely-not-installed" });
  const session = await adapter.readSession("cx1", { mode: "lossless" });

  assert.equal(session.lossless.enabled, true);
  assert.equal(session.events.length, rows.length);
  assert.equal(session.events.at(-1).kind, "event_msg");
  const reasoningMessage = session.messages.find((message) => message.content.some((part) => part.type === "reasoning"));
  const reasoning = reasoningMessage.content.find((part) => part.type === "reasoning");
  assert.deepEqual(reasoning.summary, ["private summary"]);
  assert.equal(reasoning.encrypted, "opaque-reasoning");
});
