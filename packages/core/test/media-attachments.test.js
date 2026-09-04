import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexAdapter } from "../src/adapters/codex.js";
import { GeminiCliAdapter } from "../src/adapters/gemini.js";

test("Codex input image/audio content becomes portable attachments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-codex-media-"));
  const file = path.join(dir, "rollout.jsonl");
  const rows = [
    { timestamp: "2026-09-04T09:00:00Z", type: "session_meta", payload: { id: "c1", cwd: "/tmp/project" } },
    { timestamp: "2026-09-04T09:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" }, { type: "input_audio", audio_url: "data:audio/wav;base64,YXVkaW8=" }] } }
  ];
  await fs.writeFile(file, rows.map(JSON.stringify).join("\n") + "\n");
  const session = await new CodexAdapter().readSession(file);
  assert.deepEqual(session.messages[0].content.map((part) => part.type), ["text", "attachment", "attachment"]);
  assert.equal(session.messages[0].content[1].mimeType, "image/png");
  assert.equal(Buffer.from(session.messages[0].content[1].data, "base64").toString(), "image");
  assert.equal(session.messages[0].content[2].mimeType, "audio/wav");
});

test("Gemini inlineData/fileData becomes portable attachments", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-gemini-media-"));
  const file = path.join(dir, "session.json");
  await fs.writeFile(file, JSON.stringify({ sessionId: "g1", projectHash: "p1", messages: [{ id: "m1", type: "user", content: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" } }, { fileData: { mimeType: "application/pdf", fileUri: "https://example.test/a.pdf", displayName: "a.pdf" } }] }] }));
  const session = await new GeminiCliAdapter().readSession(file);
  assert.deepEqual(session.messages[0].content.map((part) => part.type), ["text", "attachment", "attachment"]);
  assert.equal(Buffer.from(session.messages[0].content[1].data, "base64").toString(), "image");
  assert.equal(session.messages[0].content[2].uri, "https://example.test/a.pdf");
  assert.equal(session.messages[0].content[2].data, null);
});
