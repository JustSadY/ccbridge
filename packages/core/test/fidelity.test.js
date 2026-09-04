import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSessionFeatures, evaluatePortableFidelity } from "../src/fidelity.js";

test("reports direct target fidelity separately from lossless archive preservation", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "hi" }, { type: "tool-call", id: "c1", name: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", callId: "c1", output: "ok" }] }
    ],
    events: [{ kind: "raw" }],
    metadata: { source: true }
  };
  const target = { portableSupport: { text: true, toolCall: true, toolResult: true, reasoning: false, rawEvent: false, metadata: true } };
  const report = evaluatePortableFidelity(session, target, { losslessArchive: true });
  assert.equal(report.totalItems, 7);
  assert.equal(report.directItems, 5);
  assert.equal(report.targetPercent, 71);
  assert.equal(report.archivePercent, 100);
  assert.equal(report.features.find((item) => item.feature === "reasoning").archive, "bundle-only");
});

test("known Qwen private content is schema-valid but still requires explicit target support", () => {
  const session = {
    messages: [
      { role: "user", content: [{ type: "text", text: "run this" }] },
      {
        role: "assistant",
        content: [
          { type: "qwen-executable-code", executableCode: { language: "PYTHON", code: "print(1)" } },
          { type: "qwen-code-execution-result", codeExecutionResult: { outcome: "OUTCOME_OK", output: "1\n" } },
          { type: "text", text: "done" }
        ]
      }
    ],
    agents: [],
    events: [],
    metadata: {}
  };
  const target = { portableSupport: { text: true, unknownContent: false } };
  const features = analyzeSessionFeatures(session);
  assert.equal(features.text, 2);
  assert.equal(features.unknownContent, 2);

  const report = evaluatePortableFidelity(session, target, { losslessArchive: true });
  assert.equal(report.totalItems, 4);
  assert.equal(report.directItems, 2);
  assert.equal(report.targetPercent, 50);
  assert.equal(report.archivePercent, 100);
  const unsupported = report.features.find((item) => item.feature === "unknownContent");
  assert.equal(unsupported.count, 2);
  assert.equal(unsupported.target, "not-represented");
  assert.equal(unsupported.archive, "bundle-only");
});
