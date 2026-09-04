import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";

test("prefers a compatible target-native artifact route", async () => {
  const source = {
    id: "source",
    name: "Source",
    aliases: [],
    async getNativeArtifact(ref) {
      return { kind: "agent-session", format: "vendor/session-v1", path: ref, cwd: "/old" };
    },
    async readSession() {
      throw new Error("portable route should not run");
    }
  };
  const target = {
    id: "target",
    name: "Target",
    aliases: [],
    nativeImports: ["vendor/session-v1"],
    async importNativeArtifact(artifact, options) {
      return { artifact, options };
    }
  };
  const registry = new AdapterRegistry().register(source).register(target);
  const bridge = new SessionBridge(registry);
  const result = await bridge.transfer({ from: "source", to: "target", session: "/session", cwd: "/new", dryRun: true });

  assert.equal(result.route, "native");
  assert.equal(result.format, "vendor/session-v1");
  assert.equal(result.artifact.path, "/session");
  assert.equal(result.cwd, "/new");
});

test("falls back to portable sessions when native formats are incompatible", async () => {
  const portable = {
    schemaVersion: 1,
    id: "session-1",
    title: null,
    cwd: "/work",
    startedAt: null,
    updatedAt: null,
    source: { adapter: "source", sessionId: "session-1", path: null },
    messages: [],
    metadata: {}
  };
  const source = {
    id: "source",
    name: "Source",
    async getNativeArtifact() {
      return { kind: "agent-session", format: "source/private", path: "/session" };
    },
    async readSession() { return portable; }
  };
  const target = {
    id: "target",
    name: "Target",
    nativeImports: ["other/private"],
    async importNativeArtifact() {
      throw new Error("incompatible native import should not run");
    },
    async writePortableSession(session, options) {
      return { session, options };
    }
  };

  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const plan = await bridge.planTransfer({ from: "source", to: "target", session: "session-1" });
  assert.equal(plan.route, "portable");
  assert.equal(plan.sessionId, "session-1");
}
