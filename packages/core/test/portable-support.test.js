import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { KiloCodeAdapter } from "../src/adapters/kilo.js";

const noCli = () => ({ status: 1, stdout: "", stderr: "not installed" });

test("OpenCode portable support does not overclaim system or arbitrary metadata fidelity", () => {
  const adapter = new OpenCodeAdapter({ runner: noCli });
  assert.equal(adapter.portableSupport.text, true);
  assert.equal(adapter.portableSupport.toolCall, true);
  assert.equal(adapter.portableSupport.toolResult, true);
  assert.equal(adapter.portableSupport.attachment, true);
  assert.equal(adapter.portableSupport.system, false);
  assert.equal(adapter.portableSupport.metadata, false);
  assert.equal(adapter.portableSupport.reasoning, false);
  assert.equal(adapter.portableSupport.rawEvent, false);
  assert.equal(adapter.portableSupport.unknownContent, false);
});

test("Kilo portable support follows the same conservative writer contract", () => {
  const adapter = new KiloCodeAdapter({ runner: noCli, legacyHomes: [] });
  assert.equal(adapter.portableSupport.text, true);
  assert.equal(adapter.portableSupport.toolCall, true);
  assert.equal(adapter.portableSupport.toolResult, true);
  assert.equal(adapter.portableSupport.attachment, true);
  assert.equal(adapter.portableSupport.system, false);
  assert.equal(adapter.portableSupport.metadata, false);
  assert.equal(adapter.portableSupport.reasoning, false);
  assert.equal(adapter.portableSupport.rawEvent, false);
  assert.equal(adapter.portableSupport.unknownContent, false);
});
