import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AiderAdapter } from "../src/adapters/aider.js";

function runner(_command, args) {
  if (args[0] === "--version") return { status: 0, stdout: "aider 0.86.2\n", stderr: "" };
  return { status: 1, stdout: "", stderr: "unexpected" };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-aider-"));
  const project = path.join(root, "project");
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, ".aider.chat.history.md");
  const markdown = `# aider chat started at 2026-06-07 17:54:44

> Aider v0.86.2
> Model: test-model

#### review code

I reviewed the code.

> Tokens: 100 sent, 20 received.

# aider chat started at 2026-06-07 18:04:48

> Aider v0.86.2

#### fix the parser

I can fix the parser.

\`\`\`js
console.log("fixed");
\`\`\`

> Applied edit to parser.js

#### run tests

Tests look good.
`;
  await fs.writeFile(file, markdown, "utf8");
  return { root, project, file, markdown };
}

test("discovers each Aider chat-start section as a separate session", async () => {
  const { root, project } = await fixture();
  const adapter = new AiderAdapter({ roots: [root], runner });
  const detection = await adapter.detect();
  assert.equal(detection.installed, true);
  assert.equal(detection.version, "aider 0.86.2");
  assert.equal(detection.historyFiles.length, 1);
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].cwd, project);
  assert.equal(sessions.some((item) => item.title === "review code"), true);
  assert.equal(sessions.some((item) => item.title === "fix the parser"), true);
  assert.notEqual(sessions[0].id, sessions[1].id);
});

test("portable Aider parse keeps user/assistant text but not blockquoted tool status", async () => {
  const { root } = await fixture();
  const adapter = new AiderAdapter({ roots: [root], runner });
  const session = (await adapter.listSessions()).find((item) => item.title === "fix the parser");
  const parsed = await adapter.readSession(session.id);
  assert.deepEqual(parsed.messages.map((item) => item.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(JSON.stringify(parsed.messages).includes("Applied edit to parser.js"), false);
  assert.equal(parsed.lossless, null);
});

test("lossless Aider parse preserves the complete raw Markdown section and blockquoted status", async () => {
  const { root } = await fixture();
  const adapter = new AiderAdapter({ roots: [root], runner });
  const session = (await adapter.listSessions()).find((item) => item.title === "fix the parser");
  const parsed = await adapter.readSession(session.id, { mode: "lossless" });
  assert.equal(parsed.lossless.enabled, true);
  assert.equal(parsed.lossless.sourceFormat, "aider/chat-history-markdown-v1");
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].kind, "markdown-section");
  assert.match(parsed.events[0].data.markdown, /# aider chat started at 2026-06-07 18:04:48/);
  assert.match(parsed.events[0].data.markdown, /> Applied edit to parser\.js/);
  assert.equal(parsed.messages.some((item) => item.role === "system" && item.content[0].text.includes("Applied edit")), true);

  const artifact = await adapter.getNativeArtifact(session.id);
  assert.equal(artifact.format, "aider/chat-history-markdown-v1");
  assert.match(artifact.content, /#### fix the parser/);
  assert.equal(artifact.content.includes("#### review code"), false);
});

test("AIDER_CHAT_HISTORY_FILE selects one exact history file", async () => {
  const { file } = await fixture();
  const adapter = new AiderAdapter({ env: { AIDER_CHAT_HISTORY_FILE: file }, runner });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.every((session) => session.path === file), true);
});
