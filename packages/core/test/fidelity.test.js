import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortableFidelity } from "../src/fidelity.js";

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
