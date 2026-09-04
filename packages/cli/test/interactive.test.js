import test from "node:test";
import assert from "node:assert/strict";
import { interactiveCandidates, runInteractive } from "../src/interactive.js";

test("interactiveCandidates only exposes sources with sessions and writable/importable targets", () => {
  const scan = {
    adapters: [
      { id: "claude-code", name: "Claude", sessionCount: 3, discoverySupported: true },
      { id: "empty", name: "Empty", sessionCount: 0, discoverySupported: true },
      { id: "nodiscovery", name: "No discovery", sessionCount: 2, discoverySupported: false }
    ]
  };
  const descriptors = [
    { id: "codex", capabilities: { nativeImport: true } },
    { id: "opencode", capabilities: { write: true } },
    { id: "reader", capabilities: { read: true } }
  ];
  const result = interactiveCandidates(scan, descriptors);
  assert.deepEqual(result.source.map((item) => item.id), ["claude-code"]);
  assert.deepEqual(result.target.map((item) => item.id), ["codex", "opencode"]);
});

test("interactive mode refuses non-TTY input by default", async () => {
  const bridge = {};
  await assert.rejects(
    runInteractive(bridge, { input: { isTTY: false }, output: { isTTY: false } }),
    /requires a TTY/
  );
});
