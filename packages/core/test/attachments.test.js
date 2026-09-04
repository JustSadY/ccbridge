import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeCodeAdapter } from "../src/adapters/claude.js";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";

let importedPayload = null;
function mockRunner(_command, args) {
  if (args[0] === "export") return { status: 0, stdout: JSON.stringify({ info: { id: "ses_file", title: "Files", projectID: "p1", directory: "/tmp/project", time: { created: 1, updated: 2 } }, messages: [{ info: { id: "msg_u", sessionID: "ses_file", role: "user", time: { created: 1 }, agent: "build", model: { providerID: "x", modelID: "y" } }, parts: [{ id: "prt_t", sessionID: "ses_file", messageID: "msg_u", type: "text", text: "see image" }, { id: "prt_f", sessionID: "ses_file", messageID: "msg_u", type: "file", mime: "image/png", filename: "screen.png", url: "data:image/png;base64,aW1hZ2U=" }] }] }), stderr: "" };
  if (args[0] === "import") { importedPayload = JSON.parse(fsSync.readFileSync(args[1], "utf8")); return { status: 0, stdout: `Imported session: ${importedPayload.info.id}\n`, stderr: "" }; }
  if (args[0] === "--version") return { status: 0, stdout: "1.0.0\n", stderr: "" };
  if (args[0] === "session") return { status: 0, stdout: "[]", stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

test("Claude inline images become portable attachments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-claude-attachment-"));
  const dir = path.join(home, "projects", "-tmp-project");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "session.jsonl"), JSON.stringify({ type: "user", sessionId: "s1", uuid: "u1", cwd: "/tmp/project", timestamp: "2026-09-04T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }] } }) + "\n");
  const session = await new ClaudeCodeAdapter({ home }).readSession("s1");
  assert.deepEqual(session.messages[0].content.map((part) => part.type), ["text", "attachment"]);
  assert.equal(session.messages[0].content[1].mimeType, "image/png");
  assert.equal(Buffer.from(session.messages[0].content[1].data, "base64").toString(), "image");
});

test("OpenCode file parts round-trip through portable attachments", async () => {
  const adapter = new OpenCodeAdapter({ runner: mockRunner });
  const read = await adapter.readSession("ses_file");
  assert.deepEqual(read.messages[0].content.map((part) => part.type), ["text", "attachment"]);
  assert.equal(Buffer.from(read.messages[0].content[1].data, "base64").toString(), "image");
  importedPayload = null;
  const session = { schemaVersion: 1, id: "source", title: "Files", cwd: "/tmp/project", startedAt: null, updatedAt: null, source: { adapter: "claude-code", sessionId: "source", path: null }, messages: [{ id: "u1", role: "user", createdAt: null, content: [{ type: "text", text: "see image" }, { type: "attachment", name: "screen.png", mimeType: "image/png", data: "aW1hZ2U=", encoding: "base64" }], metadata: {} }], metadata: {}, events: [], lossless: null };
  await adapter.writePortableSession(session, { cwd: "/tmp/project" });
  const parts = importedPayload.messages[0].parts;
  assert.deepEqual(parts.map((part) => part.type), ["text", "file"]);
  assert.equal(parts[1].filename, "screen.png");
  assert.equal(parts[1].url, "data:image/png;base64,aW1hZ2U=");
  assert.equal(adapter.portableSupport.attachment, true);
});
