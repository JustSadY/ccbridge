import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GeminiCliAdapter } from "../src/adapters/gemini.js";

test("reads Gemini CLI JSONL checkpoints and rewinds into a portable session", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-gemini-"));
  const chats = path.join(home, "tmp", "project-hash", "chats");
  await fs.mkdir(chats, { recursive: true });
  const file = path.join(chats, "session-2026-09-04T09-00-abcdef12.jsonl");

  const rows = [
    {
      sessionId: "gemini-session-1",
      projectHash: "project-hash",
      startTime: "2026-09-04T09:00:00Z",
      lastUpdated: "2026-09-04T09:00:00Z",
      directories: ["/tmp/project"]
    },
    {
      id: "u1",
      type: "user",
      timestamp: "2026-09-04T09:00:01Z",
      content: [{ text: "Fix the parser" }]
    },
    {
      id: "a1",
      type: "gemini",
      timestamp: "2026-09-04T09:00:02Z",
      content: [{ text: "I will inspect it." }],
      thoughts: [{ subject: "private", description: "do not export", timestamp: "2026-09-04T09:00:02Z" }],
      toolCalls: [
        {
          id: "call-1",
          name: "read_file",
          args: { path: "src/parser.js" },
          result: [{ text: "file contents" }],
          status: "success",
          timestamp: "2026-09-04T09:00:02Z"
        }
      ]
    },
    {
      id: "u2",
      type: "user",
      timestamp: "2026-09-04T09:00:03Z",
      content: [{ text: "This message will be rewound" }]
    },
    { $rewindTo: "u2" },
    {
      $set: {
        lastUpdated: "2026-09-04T09:05:00Z",
        summary: "Parser repair"
      }
    }
  ];

  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");

  const adapter = new GeminiCliAdapter({ home, command: "__missing_gemini_for_test__" });
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "gemini-session-1");
  assert.equal(sessions[0].title, "Fix the parser");

  const session = await adapter.readSession("gemini-session-1");
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, "user");
  assert.deepEqual(session.messages[1].content.map((part) => part.type), ["text", "tool-call", "tool-result"]);
  assert.equal(session.metadata.projectHash, "project-hash");
  assert.deepEqual(session.metadata.directories, ["/tmp/project"]);
  assert.equal(JSON.stringify(session).includes("do not export"), false);
  assert.equal(JSON.stringify(session).includes("This message will be rewound"), false);
});
