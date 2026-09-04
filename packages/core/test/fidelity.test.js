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

test("subagent message content participates in strict portable fidelity", () => {
  const session = {
    messages: [{ role: "user", content: [{ type: "text", text: "root" }] }],
    agents: [{
      id: "agent-1",
      messages: [{ role: "assistant", content: [{ type: "reasoning", text: "private agent thought" }, { type: "text", text: "agent answer" }] }],
      events: [{ kind: "agent-raw" }]
    }],
    events: [],
    metadata: {}
  };
  const target = { portableSupport: { text: true, subagent: true, reasoning: false, rawEvent: false } };
  const features = analyzeSessionFeatures(session);
  assert.equal(features.text, 2);
  assert.equal(features.reasoning, 1);
  assert.equal(features.subagent, 1);
  assert.equal(features.rawEvent, 1);

  const report = evaluatePortableFidelity(session, target, { losslessArchive: true });
  assert.equal(report.totalItems, 5);
  assert.equal(report.directItems, 3);
  assert.equal(report.targetPercent, 60);
  assert.equal(report.archivePercent, 100);
  assert.equal(report.features.find((item) => item.feature === "reasoning").target, "not-represented");
  assert.equal(report.features.find((item) => item.feature === "rawEvent").target, "not-represented");
});

test("nested session, message and agent metadata participates in portable fidelity", () => {
  const session = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "root" }],
      metadata: { qwenRecord: { forkedFrom: { sessionId: "parent", messageUuid: "m1" } } }
    }],
    agents: [{
      id: "agent-1",
      metadata: { qwenForkBootstrap: { enabled: true } },
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "agent answer" }],
        metadata: { qwenRecord: { agentRunId: "run-1", agentRound: 2 } }
      }],
      events: []
    }],
    events: [],
    metadata: { cliVersion: "0.9.0" }
  };
  const target = { portableSupport: { text: true, subagent: true, metadata: false } };
  const features = analyzeSessionFeatures(session);
  assert.equal(features.text, 2);
  assert.equal(features.subagent, 1);
  assert.equal(features.metadata, 4);

  const report = evaluatePortableFidelity(session, target, { losslessArchive: true });
  assert.equal(report.totalItems, 7);
  assert.equal(report.directItems, 3);
  assert.equal(report.targetPercent, 43);
  assert.equal(report.archivePercent, 100);
  const metadata = report.features.find((item) => item.feature === "metadata");
  assert.equal(metadata.count, 4);
  assert.equal(metadata.target, "not-represented");
  assert.equal(metadata.archive, "bundle-only");
});
