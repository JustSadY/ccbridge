import test from "node:test";
import assert from "node:assert/strict";
import { nativeImportPreservation, transferPreservationClass, nativeFidelityReport } from "../src/fidelity.js";

const session = {
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "done" }] }
  ],
  agents: [],
  events: [{ kind: "raw" }],
  metadata: { provider: "fixture" }
};

test("native preservation remains backward compatible with losslessNativeImports", () => {
  const exact = { losslessNativeImports: ["vendor/exact"] };
  assert.equal(nativeImportPreservation(exact, "vendor/exact"), "exact");
  assert.equal(nativeImportPreservation(exact, "vendor/other"), "best-effort");
});

test("explicit native preservation overrides classify remapped imports", () => {
  const target = { nativeImportPreservation: { "vendor/session": "remapped" }, losslessNativeImports: ["vendor/session"] };
  assert.equal(nativeImportPreservation(target, "vendor/session"), "remapped");
});

test("side archive is independent from target representation class", () => {
  assert.deepEqual(transferPreservationClass({ route: "native", nativePreservation: "exact", losslessArchive: true }), { targetClass: "exact", sideArchive: true, overallClass: "exact" });
  assert.deepEqual(transferPreservationClass({ route: "native", nativePreservation: "remapped", losslessArchive: true }), { targetClass: "remapped", sideArchive: true, overallClass: "remapped+side-archive" });
  assert.deepEqual(transferPreservationClass({ route: "native", nativePreservation: "best-effort", losslessArchive: true }), { targetClass: "best-effort", sideArchive: true, overallClass: "best-effort+side-archive" });
  assert.deepEqual(transferPreservationClass({ route: "portable", losslessArchive: true }), { targetClass: "portable", sideArchive: true, overallClass: "portable+side-archive" });
});

test("native fidelity only claims 100 percent for exact imports", () => {
  const exact = nativeFidelityReport(session, { format: "vendor/session" }, { nativePreservation: "exact", losslessArchive: true });
  assert.equal(exact.targetPercent, 100);
  assert.equal(exact.preservation.targetClass, "exact");
  const remapped = nativeFidelityReport(session, { format: "vendor/session" }, { nativePreservation: "remapped", losslessArchive: true });
  assert.equal(remapped.targetPercent, null);
  assert.equal(remapped.preservation.overallClass, "remapped+side-archive");
  assert.match(remapped.note, /project, cwd, path/);
});
