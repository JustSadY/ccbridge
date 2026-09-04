import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";

test("prefers target-native artifact import when adapters support it", async () => {
  const source = {
    id: "source",
    aliases: [],
    capabilities: { read: true },
    async getNativeArtifact(ref) { return { kind: "native", path: ref, cwd: "/old" }; },
    async readSession() { throw new Error("portable route should not run"); }
  };
  const target = {
    id: "target",
    aliases: [],
    capabilities: { write: true },
    async importNativeArtifact(artifact, options) { return { artifact, options }; }
  };
  const registry = new AdapterRegistry().register(source).register(target);
  const bridge = new SessionBridge(registry);
  const result = await bridge.transfer({ from: "source", to: "target", session: "/session", cwd: "/new", dryRun: true });
  assert.equal(result.artifact.path, "/session");
  assert.equal(result.options.cwd, "/new");
  assert.equal(result.options.dryRun, true);
});
