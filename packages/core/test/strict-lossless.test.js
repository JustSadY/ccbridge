import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";

function sessionWithReasoning() {
  return { schemaVersion: 1, id: "s1", title: null, cwd: "/work", startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "s1", path: null }, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "hello" }] }], metadata: {}, events: [], lossless: { enabled: true } };
}

test("strict lossless blocks before a portable target write when reasoning would be lost", async () => {
  let writes = 0;
  const source = { id: "source", name: "Source", capabilities: { losslessRead: true }, async readSession() { return sessionWithReasoning(); } };
  const target = { id: "target", name: "Target", portableSupport: { text: true, reasoning: false }, async writePortableSession() { writes += 1; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  await assert.rejects(() => bridge.transfer({ from: "source", to: "target", session: "s1", strictLossless: true }), /target cannot represent provider reasoning\/thinking/);
  assert.equal(writes, 0);
});

test("strict lossless accepts a native route only with an explicit exact guarantee", async () => {
  let imports = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-strict-"));
  const source = { id: "source", name: "Source", capabilities: { losslessRead: true }, async readSession() { return sessionWithReasoning(); }, async getNativeArtifact() { return { format: "vendor/native", content: "native-bytes", encoding: "utf8", filename: "native.dat" }; } };
  const target = { id: "target", name: "Target", nativeImports: ["vendor/native"], losslessNativeImports: ["vendor/native"], async importNativeArtifact() { imports += 1; return { ok: true }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const result = await bridge.transfer({ from: "source", to: "target", session: "s1", strictLossless: true, bundle: path.join(dir, "strict.ccbridge") });
  assert.equal(imports, 1);
  assert.equal(result.strictLossless, true);
  assert.equal(result.nativePreservation, "exact");
});

test("strict lossless blocks remapped native imports before target mutation", async () => {
  let imports = 0;
  const source = { id: "source", name: "Source", capabilities: { losslessRead: true }, nativeExports: ["vendor/native"], async readSession() { return sessionWithReasoning(); }, async getNativeArtifact() { return { format: "vendor/native", content: "native-bytes", encoding: "utf8", filename: "native.dat" }; } };
  const target = { id: "target", name: "Target", nativeImports: ["vendor/native"], nativeImportPreservation: { "vendor/native": "remapped" }, async importNativeArtifact() { imports += 1; return { ok: true }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  await assert.rejects(() => bridge.transfer({ from: "source", to: "target", session: "s1", strictLossless: true }), /is remapped, not exact/);
  assert.equal(imports, 0);
});
