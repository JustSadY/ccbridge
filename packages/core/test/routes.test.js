import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultBridge } from "../src/index.js";

function row(matrix, from, to) {
  const value = matrix.rows.find((item) => item.from === from && item.to === to);
  assert.ok(value, `missing route ${from} -> ${to}`);
  return value;
}

test("static route matrix describes native and portable priorities without reading sessions", () => {
  const bridge = createDefaultBridge();
  const matrix = bridge.routes();
  assert.equal(matrix.adapterCount, 14);

  const claudeCodex = row(matrix, "claude-code", "codex");
  assert.equal(claudeCodex.route, "native");
  assert.ok(claudeCodex.nativeFormats.includes("claude-code/session-jsonl"));

  const aiderOpenCode = row(matrix, "aider", "opencode");
  assert.equal(aiderOpenCode.route, "portable");
  assert.equal(aiderOpenCode.portable, true);
  assert.equal(aiderOpenCode.preservation.targetClass, "portable");

  const antigravityOpenCode = row(matrix, "antigravity-cli", "opencode");
  assert.equal(antigravityOpenCode.route, "none");
  assert.equal(antigravityOpenCode.portable, false);
  assert.equal(antigravityOpenCode.preservation.targetClass, "none");
});

test("route matrix distinguishes exact, remapped and side-archive guarantees", () => {
  const bridge = createDefaultBridge();
  const matrix = bridge.routes();

  const gooseSelf = row(matrix, "goose", "goose");
  assert.equal(gooseSelf.route, "native");
  assert.deepEqual(gooseSelf.nativeFormats, ["goose/session-json"]);
  assert.equal(gooseSelf.nativePreservation["goose/session-json"], "exact");
  assert.equal(gooseSelf.preservation.targetClass, "exact");
  assert.deepEqual(gooseSelf.lossless.strictNativeFormats, ["goose/session-json"]);
  assert.equal(gooseSelf.lossless.strict, "native-for-listed-formats");

  const piGoose = row(matrix, "pi", "goose");
  assert.equal(piGoose.route, "native");
  assert.deepEqual(piGoose.nativeFormats, ["pi/session-jsonl"]);
  assert.equal(piGoose.nativePreservation["pi/session-jsonl"], "best-effort");
  assert.equal(piGoose.lossless.route, "native+archive");
  assert.equal(piGoose.lossless.preservation.overallClass, "best-effort+side-archive");
  assert.equal(piGoose.lossless.strict, "unavailable");
  assert.deepEqual(piGoose.lossless.strictNativeFormats, []);

  const kiloSelf = row(matrix, "kilo-code", "kilo-code");
  assert.equal(kiloSelf.route, "native");
  assert.ok(kiloSelf.nativeFormats.includes("kilo/session-json"));
  assert.equal(kiloSelf.nativePreservation["kilo/session-json"], "remapped");
  assert.deepEqual(kiloSelf.lossless.strictNativeFormats, []);
  assert.deepEqual(kiloSelf.lossless.remappedNativeFormats, ["kilo/session-json"]);
  assert.equal(kiloSelf.lossless.strict, "session-dependent");
  assert.equal(kiloSelf.lossless.preservation.overallClass, "remapped+side-archive");

  const opencodeKilo = row(matrix, "opencode", "kilo-code");
  assert.equal(opencodeKilo.route, "native");
  assert.deepEqual(opencodeKilo.nativeFormats, ["opencode/session-json"]);
  assert.equal(opencodeKilo.nativePreservation["opencode/session-json"], "remapped");
  assert.equal(opencodeKilo.lossless.strict, "session-dependent");
});

test("route matrix filters by aliases and canonicalizes adapter ids", () => {
  const bridge = createDefaultBridge();
  const matrix = bridge.routes({ from: "pi-agent", to: "goose-ai" });
  assert.equal(matrix.from, "pi");
  assert.equal(matrix.to, "goose");
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].route, "native");
});
