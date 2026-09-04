import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContinueAdapter, parseContinueTranscript } from "../src/adapters/continue.js";

const transcript = `### [Continue](https://continue.dev) session transcript
 Exported: 9/4/2026, 2:30:00 PM

#### _User_

> Please inspect this file.
> \`\`\`js
> console.log("x")
> \`\`\`

#### _Assistant_

> I inspected it.
> The output is x.
`;

test("Continue parser preserves user/assistant Markdown text", () => {
  const sections = parseContinueTranscript(transcript);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].role, "user");
  assert.match(sections[0].text, /console\.log/);
  assert.equal(sections[1].role, "assistant");
});

test("Continue adapter discovers official *_session.md exports", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-continue-"));
  const file = path.join(home, "20260904T143000_session.md");
  await fs.writeFile(file, transcript);
  await fs.writeFile(path.join(home, "random.md"), "not a transcript");
  const adapter = new ContinueAdapter({ home });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "20260904T143000_session");
  assert.match(sessions[0].title, /Please inspect/);
});

test("Continue lossless read keeps raw exported sections", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-continue-"));
  const file = path.join(home, "20260904T143000_session.md");
  await fs.writeFile(file, transcript);
  const adapter = new ContinueAdapter({ home });
  const session = await adapter.readSession(file, { mode: "lossless" });
  assert.equal(session.messages.length, 2);
  assert.equal(session.events.length, 2);
  assert.equal(session.lossless.sourceFormat, "continue/session-transcript-markdown-v1");
  assert.equal(session.metadata.presentationOriented, true);
  const artifact = await adapter.getNativeArtifact(file);
  assert.equal(artifact.format, "continue/session-transcript-markdown-v1");
});
