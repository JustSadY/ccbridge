import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";
import { adapterCompatibilityContract, checkAdapterCompatibility } from "../src/compatibility.js";
import { createPortableSession, rawEvent, textContent } from "../src/model.js";

function mockAdapter(options = {}) {
  return {
    id: options.id ?? "example",
    name: options.name ?? "Example",
    aliases: options.aliases ?? [],
    capabilities: { discover: false, read: true, losslessRead: true },
    compatibility: {
      contractVersion: 1,
      sourceFormats: ["example/session-v1"],
      recordKinds: ["message"],
      recordKindPrefixes: [],
      contentTypes: ["text"],
      preserveUnknownRecords: true,
      testedVersions: ["1.2.3"]
    },
    async detect() { return { installed: true, version: options.version ?? "1.2.3" }; },
    async readSession() {
      return createPortableSession({
        id: "session-1",
        source: { adapter: "example", sessionId: "session-1" },
        messages: [{ id: "m1", role: "user", content: options.content ?? [textContent("hello")], metadata: {} }],
        agents: [],
        metadata: {},
        events: [rawEvent({ index: 0, provider: "example", kind: options.kind ?? "message", data: {} })],
        lossless: { enabled: true, sourceFormat: options.sourceFormat ?? "example/session-v1" }
      });
    }
  };
}

test("known schema and tested version report schema-known", async () => {
  const result = await checkAdapterCompatibility(mockAdapter(), { sessionRef: "session-1" });
  assert.equal(result.status, "schema-known");
  assert.equal(result.versionEvidence.status, "tested");
  assert.equal(result.sessionProbe.driftDetected, false);
  assert.deepEqual(result.sessionProbe.unknownRecordKinds, []);
  assert.deepEqual(result.sessionProbe.unknownContentTypes, []);
});

test("unknown source format, record kind or content type triggers drift", async () => {
  const adapter = mockAdapter({
    sourceFormat: "example/session-v2",
    kind: "future-event",
    content: [{ type: "future-content", payload: 1 }]
  });
  const result = await checkAdapterCompatibility(adapter, { sessionRef: "session-1" });
  assert.equal(result.status, "drift-detected");
  assert.equal(result.sessionProbe.driftDetected, true);
  assert.equal(result.sessionProbe.sourceFormatKnown, false);
  assert.deepEqual(result.sessionProbe.unknownRecordKinds, ["future-event"]);
  assert.deepEqual(result.sessionProbe.unknownContentTypes, ["future-content"]);
  assert.match(result.sessionProbe.note, /preserved losslessly/);
});

test("unverified installed version is informational and not schema drift by itself", async () => {
  const adapter = mockAdapter({ version: "9.9.9" });
  const registry = new AdapterRegistry().register(adapter);
  const bridge = new SessionBridge(registry);
  const result = await bridge.compatibility({ adapterIds: ["example"], sessionRef: "session-1" });
  assert.equal(result.driftDetected, false);
  assert.deepEqual(result.unverifiedVersions, [{ id: "example", version: "9.9.9" }]);
  assert.equal(result.adapters[0].status, "schema-known");
  assert.equal(result.adapters[0].versionEvidence.status, "unverified");
});

test("built-in Claude contract is available without claiming tested versions", () => {
  const contract = adapterCompatibilityContract({ id: "claude-code" });
  assert.ok(contract.sourceFormats.includes("claude-code/session-jsonl"));
  assert.equal(contract.preserveUnknownRecords, true);
  assert.deepEqual(contract.testedVersions, []);
});

test("built-in Qwen contract declares tree, compression and subagent preservation", () => {
  const contract = adapterCompatibilityContract({ id: "qwen-code" });
  assert.deepEqual(contract.sourceFormats, ["qwen-code/session-jsonl"]);
  assert.equal(contract.treeStructured, true);
  assert.equal(contract.compressionAware, true);
  assert.equal(contract.subagentTranscripts, true);
  assert.equal(contract.preserveUnknownRecords, true);
  assert.ok(contract.recordKindPrefixes.includes("record:system:"));
});
