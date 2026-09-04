import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";

test("prefers a compatible target-native artifact route", async () => {
  const source = { id: "source", name: "Source", aliases: [], async getNativeArtifact(ref) { return { kind: "agent-session", format: "vendor/session-v1", path: ref, cwd: "/old" }; }, async readSession() { throw new Error("portable route should not run"); } };
  const target = { id: "target", name: "Target", aliases: [], nativeImports: ["vendor/session-v1"], async importNativeArtifact(artifact, options) { return { artifact, options }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const result = await bridge.transfer({ from: "source", to: "target", session: "/session", cwd: "/new", dryRun: true });
  assert.equal(result.route, "native"); assert.equal(result.format, "vendor/session-v1"); assert.equal(result.artifact.path, "/session"); assert.equal(result.cwd, "/new");
});

test("falls back to portable sessions when native formats are incompatible", async () => {
  const portable = { schemaVersion: 1, id: "session-1", title: null, cwd: "/work", startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "session-1", path: null }, messages: [], metadata: {}, events: [], lossless: null };
  const source = { id: "source", name: "Source", async getNativeArtifact() { return { kind: "agent-session", format: "source/private", path: "/session" }; }, async readSession() { return portable; } };
  const target = { id: "target", name: "Target", nativeImports: ["other/private"], async importNativeArtifact() { throw new Error("incompatible native import should not run"); }, async writePortableSession(session, options) { return { session, options }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const plan = await bridge.planTransfer({ from: "source", to: "target", session: "session-1" });
  assert.equal(plan.route, "portable"); assert.equal(plan.sessionId, "session-1");
});

test("native-only sessions never fall through to an empty portable import", async () => {
  const source = { id: "source", name: "Source", async getNativeArtifact() { return { format: "private/sqlite", path: "/tmp/session.db" }; }, async readSession() { return { schemaVersion: 1, id: "native-1", title: null, cwd: null, startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "native-1", path: null }, messages: [], metadata: { nativeOnly: true }, events: [], lossless: { enabled: true, nativeOnly: true } }; } };
  const target = { id: "target", name: "Target", async writePortableSession() { throw new Error("must not run"); } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  await assert.rejects(() => bridge.planTransfer({ from: "source", to: "target", session: "native-1", mode: "lossless" }), /No compatible transfer route/);
});

test("lossless transfers persist a universal ccbridge archive with raw events", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-lossless-")); const bundlePath = path.join(dir, "session.ccbridge");
  const lossless = { schemaVersion: 1, id: "lossless-1", title: null, cwd: "/work", startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "lossless-1", path: "/source.jsonl" }, messages: [{ id: "a1", role: "assistant", content: [{ type: "reasoning", text: "private", provider: "source" }] }], metadata: {}, events: [{ index: 0, provider: "source", kind: "raw", timestamp: null, data: { secretReasoning: "private" } }], lossless: { enabled: true, rawRecordCount: 1 } };
  const source = { id: "source", name: "Source", async readSession(_ref, options) { assert.equal(options.mode, "lossless"); return lossless; } };
  const target = { id: "target", name: "Target", async writePortableSession(session, options) { assert.equal(options.mode, "lossless"); return { written: session.id }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const result = await bridge.transfer({ from: "source", to: "target", session: "lossless-1", mode: "lossless", bundle: bundlePath });
  assert.equal(result.mode, "lossless"); assert.equal(result.losslessBundle.path, bundlePath);
  const bundle = JSON.parse(await fs.readFile(bundlePath, "utf8"));
  assert.equal(bundle.format, "ccbridge/session"); assert.equal(bundle.session.events[0].data.secretReasoning, "private");
});
