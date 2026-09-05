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
  assert.equal(matrix.adapterCount, 17);

  const claudeCodex = row(matrix, "claude-code", "codex");
  assert.equal(claudeCodex.route, "native");
  assert.ok(claudeCodex.nativeFormats.includes("claude-code/session-jsonl"));

  const aiderOpenCode = row(matrix, "aider", "opencode");
  assert.equal(aiderOpenCode.route, "portable");
  assert.equal(aiderOpenCode.portable, true);
  assert.equal(aiderOpenCode.preservation.targetClass, "portable");

  const qwenOpenCode = row(matrix, "qwen-code", "opencode");
  assert.equal(qwenOpenCode.route, "portable");
  assert.equal(qwenOpenCode.portable, true);
  assert.equal(qwenOpenCode.preservation.targetClass, "portable");
  assert.equal(qwenOpenCode.lossless.route, "portable+archive");

  const kiroOpenCode = row(matrix, "kiro-cli", "opencode");
  assert.equal(kiroOpenCode.route, "portable");
  assert.equal(kiroOpenCode.portable, true);
  assert.equal(kiroOpenCode.preservation.targetClass, "portable");
  assert.equal(kiroOpenCode.lossless.route, "portable+archive");

  const kimiOpenCode = row(matrix, "kimi-code", "opencode");
  assert.equal(kimiOpenCode.route, "portable");
  assert.equal(kimiOpenCode.portable, true);
  assert.equal(kimiOpenCode.preservation.targetClass, "portable");
  assert.equal(kimiOpenCode.lossless.route, "portable+archive");

  const kimiKilo = row(matrix, "kimi-code", "kilo-code");
  assert.equal(kimiKilo.route, "portable");
  assert.equal(kimiKilo.portable, true);

  const opencodeKimi = row(matrix, "opencode", "kimi-code");
  assert.equal(opencodeKimi.route, "none");
  assert.equal(opencodeKimi.portable, false);

  const kiroKilo = row(matrix, "kiro-cli", "kilo-code");
  assert.equal(kiroKilo.route, "portable");
  assert.equal(kiroKilo.portable, true);

  const opencodeKiro = row(matrix, "opencode", "kiro-cli");
  assert.equal(opencodeKiro.route, "none");
  assert.equal(opencodeKiro.portable, false);

  const antigravityOpenCode = row(matrix, "antigravity-cli", "opencode");
  assert.equal(antigravityOpenCode.route, "none");
  assert.equal(antigravityOpenCode.portable, false);
  assert.equal(antigravityOpenCode.preservation.targetClass, "none");
});

test("route matrix distinguishes remapped, best-effort and side-archive guarantees", () => {
  const bridge = createDefaultBridge();
  const matrix = bridge.routes();

  const gooseSelf = row(matrix, "goose", "goose");
  assert.equal(gooseSelf.route, "native");
  assert.deepEqual(gooseSelf.nativeFormats, ["goose/session-json"]);
  assert.equal(gooseSelf.nativePreservation["goose/session-json"], "remapped");
  assert.equal(gooseSelf.preservation.targetClass, "remapped");
  assert.deepEqual(gooseSelf.lossless.strictNativeFormats, []);
  assert.equal(gooseSelf.lossless.strict, "unavailable");
  assert.equal(gooseSelf.lossless.preservation.overallClass, "remapped+side-archive");

  const piGoose = row(matrix, "pi", "goose");
  assert.equal(piGoose.route, "native");
  assert.deepEqual(piGoose.nativeFormats, ["pi/session-jsonl"]);
  assert.equal(piGoose.nativePreservation["pi/session-jsonl"], "best-effort");
  assert.equal(piGoose.lossless.route, "native+archive");
  assert.equal(piGoose.lossless.preservation.overallClass, "best-effort+side-archive");
  assert.equal(piGoose.lossless.strict, "unavailable");
  assert.deepEqual(piGoose.lossless.strictNativeFormats, []);

  const opencodeSelf = row(matrix, "opencode", "opencode");
  assert.equal(opencodeSelf.route, "native");
  assert.equal(opencodeSelf.nativePreservation["opencode/session-json"], "remapped");
  assert.equal(opencodeSelf.lossless.strict, "session-dependent");
  assert.deepEqual(opencodeSelf.lossless.strictNativeFormats, []);

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

test("built-in registry makes no exact native claim without an audited guarantee", () => {
  const matrix = createDefaultBridge().routes();
  const exactClaims = matrix.rows.flatMap((route) => Object.entries(route.nativePreservation ?? {}).filter(([, value]) => value === "exact").map(([format]) => `${route.from}->${route.to}:${format}`));
  assert.deepEqual(exactClaims, []);
});

test("route matrix filters by aliases and canonicalizes adapter ids", () => {
  const bridge = createDefaultBridge();
  const matrix = bridge.routes({ from: "pi-agent", to: "goose-ai" });
  assert.equal(matrix.from, "pi");
  assert.equal(matrix.to, "goose");
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.rows[0].route, "native");

  const kiro = bridge.routes({ from: "kiro", to: "opencode" });
  assert.equal(kiro.from, "kiro-cli");
  assert.equal(kiro.rows[0].route, "portable");

  const kimi = bridge.routes({ from: "kimi-cli", to: "opencode" });
  assert.equal(kimi.from, "kimi-code");
  assert.equal(kimi.rows[0].route, "portable");
});
