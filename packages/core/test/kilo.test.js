import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { KiloCodeAdapter } from "../src/adapters/kilo.js";

const noLegacyHome = path.join(os.tmpdir(), "ccbridge-kilo-no-legacy-fixture");
let importedPayload = null;
function currentExport(id = "kilo-current") {
  return {
    info: { id, title: "Current Kilo", projectID: "p1", directory: "/work/current", time: { created: 1788516000000, updated: 1788516060000 } },
    messages: [
      { info: { id: "u1", sessionID: id, role: "user", time: { created: 1788516001000 }, agent: "code", model: { providerID: "anthropic", modelID: "claude" } }, parts: [{ id: "p1", sessionID: id, messageID: "u1", type: "text", text: "current request" }] },
      { info: { id: "a1", sessionID: id, role: "assistant", parentID: "u1", time: { created: 1788516002000 } }, parts: [
        { id: "r1", sessionID: id, messageID: "a1", type: "reasoning", text: "current private reasoning" },
        { id: "f1", sessionID: id, messageID: "a1", type: "file", mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,aGVsbG8=" },
        { id: "t1", sessionID: id, messageID: "a1", type: "tool", callID: "call-1", tool: "read", state: { status: "completed", input: { path: "a.txt" }, output: "contents", title: "read", metadata: {}, time: { start: 1, end: 2 } } }
      ] }
    ]
  };
}

function mockRunner(_command, args, options = {}) {
  if (args[0] === "--version") return { status: 0, stdout: "kilo 7.4.0\n", stderr: "" };
  if (args[0] === "session" && args[1] === "list") return { status: 0, stdout: JSON.stringify([{ id: "kilo-current", title: "Current Kilo", updated: 1788516060000, created: 1788516000000, projectId: "p1", directory: "/work/current" }]), stderr: "" };
  if (args[0] === "export") return { status: 0, stdout: JSON.stringify(currentExport(args[1])), stderr: "" };
  if (args[0] === "import") {
    importedPayload = JSON.parse(fsSync.readFileSync(args[1], "utf8"));
    return { status: 0, stdout: `Imported session: ${importedPayload.info.id}\n`, stderr: "", cwd: options.cwd };
  }
  return { status: 1, stdout: "", stderr: `unexpected args: ${args.join(" ")}` };
}

async function legacyFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-kilo-legacy-"));
  const dir = path.join(home, "tasks", "legacy-1");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "api_conversation_history.json"), JSON.stringify([
    { role: "user", ts: "2026-09-04T10:00:00Z", content: [{ type: "text", text: "legacy request" }] },
    { role: "assistant", ts: "2026-09-04T10:00:01Z", reasoning_content: "legacy private reasoning", content: [{ type: "text", text: "legacy answer" }, { type: "tool_use", id: "legacy-call", name: "read_file", input: { path: "b.txt" } }] },
    { role: "user", ts: "2026-09-04T10:00:02Z", content: [{ type: "tool_result", tool_use_id: "legacy-call", content: "legacy contents" }] }
  ], null, 2));
  await fs.writeFile(path.join(dir, "ui_messages.json"), JSON.stringify([{ type: "say", say: "api_req_started", text: "{}" }]));
  await fs.writeFile(path.join(dir, "task_metadata.json"), JSON.stringify({ cwd: "/work/legacy", mode: "code" }));
  return home;
}

test("Kilo adapter discovers current CLI and legacy extension sessions", async () => {
  const legacyHome = await legacyFixture();
  const adapter = new KiloCodeAdapter({ runner: mockRunner, legacyHomes: [legacyHome] });
  const detected = await adapter.detect();
  assert.equal(detected.installed, true);
  assert.equal(detected.current.installed, true);
  assert.equal(detected.legacy.installed, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions.length, 2);
  assert.ok(sessions.some((session) => session.id === "kilo-current" && session.ref === "current:kilo-current"));
  assert.ok(sessions.some((session) => session.id === "legacy-1" && session.ref === "legacy:legacy-1"));
});

test("Kilo current CLI backend uses official export data and preserves lossless reasoning", async () => {
  const adapter = new KiloCodeAdapter({ runner: mockRunner, legacyHomes: [noLegacyHome] });
  const portable = await adapter.readSession("current:kilo-current", { mode: "portable" });
  assert.equal(portable.source.adapter, "kilo-code");
  assert.equal(portable.metadata.kiloBackend, "cli");
  assert.equal(portable.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning"), false);
  assert.ok(portable.messages.flatMap((message) => message.content).some((part) => part.type === "attachment" && part.name === "note.txt"));

  const lossless = await adapter.readSession("current:kilo-current", { mode: "lossless" });
  assert.equal(lossless.lossless.sourceFormat, "kilo/session-json");
  assert.ok(lossless.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning" && part.text === "current private reasoning"));
});

test("Kilo legacy backend reuses Roo-compatible task files without mislabeling provenance", async () => {
  const legacyHome = await legacyFixture();
  const adapter = new KiloCodeAdapter({ runner: () => ({ status: 1, stdout: "", stderr: "missing" }), legacyHomes: [legacyHome] });
  const session = await adapter.readSession("legacy:legacy-1", { mode: "lossless" });
  assert.equal(session.source.adapter, "kilo-code");
  assert.equal(session.metadata.kiloBackend, "legacy-extension");
  assert.equal(session.cwd, "/work/legacy");
  assert.equal(session.lossless.sourceFormat, "kilo/legacy-task-files-v1");
  assert.ok(session.events.every((event) => event.provider === "kilo-code"));
  assert.ok(session.messages.flatMap((message) => message.content).some((part) => part.type === "reasoning" && part.provider === "kilo-code" && part.text === "legacy private reasoning"));
  const artifact = await adapter.getNativeArtifact("legacy:legacy-1");
  assert.equal(artifact.format, "kilo/legacy-task-files-v1");
  assert.deepEqual(artifact.companions.map((item) => item.filename).sort(), ["task_metadata.json", "ui_messages.json"]);
});

test("Kilo current native route is remapped because target project/path identity changes", async () => {
  importedPayload = null;
  const adapter = new KiloCodeAdapter({ runner: mockRunner, legacyHomes: [noLegacyHome] });
  const artifact = await adapter.getNativeArtifact("current:kilo-current");
  assert.equal(artifact.format, "kilo/session-json");
  assert.equal(artifact.sourceAdapter, "kilo-code");
  assert.equal(await adapter.acceptsNativeArtifact({ format: "opencode/session-json", content: artifact.content }), true);
  assert.deepEqual(adapter.losslessNativeImports, []);
  assert.equal(adapter.nativeImportPreservation["kilo/session-json"], "remapped");
  assert.equal(adapter.nativeImportPreservation["opencode/session-json"], "remapped");
  const result = await adapter.importNativeArtifact(artifact, { cwd: "/work/current" });
  assert.equal(result.target, "kilo-code");
  assert.equal(result.sourceFormat, "kilo/session-json");
  assert.equal(result.preservation, "remapped");
  assert.equal(result.sessionId, "kilo-current");
});
