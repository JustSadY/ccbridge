import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";
import { scanRegistry } from "../src/scan.js";

function adapter(id, options = {}) {
  return {
    id,
    name: options.name ?? id,
    aliases: options.aliases ?? [],
    capabilities: { discover: true },
    async detect() {
      if (options.detectError) throw new Error(options.detectError);
      return { installed: options.installed ?? true, sessionStore: options.sessionStore ?? `/tmp/${id}` };
    },
    async listSessions() {
      if (options.discoveryError) throw new Error(options.discoveryError);
      return options.sessions ?? [];
    }
  };
}

test("scanRegistry summarizes all registered adapters and session counts", async () => {
  const registry = new AdapterRegistry()
    .register(adapter("alpha", { sessions: [
      { id: "a1", title: "A1", updatedAt: "2026-09-04T09:00:00Z" },
      { id: "a2", title: "A2", updatedAt: "2026-09-04T10:00:00Z" }
    ] }))
    .register(adapter("beta", { sessions: [] }));

  const result = await scanRegistry(registry, { includeSessions: true, limit: 1 });
  assert.equal(result.adapterCount, 2);
  assert.equal(result.totalSessions, 2);
  assert.equal(result.discoveredAdapters, 1);
  assert.equal(result.adapters[0].status, "ready");
  assert.equal(result.adapters[0].sessionCount, 2);
  assert.equal(result.adapters[0].newestSessionAt, "2026-09-04T10:00:00Z");
  assert.equal(result.adapters[0].sessions.length, 1);
  assert.equal(result.adapters[0].sessionsTruncated, true);
  assert.equal(result.adapters[1].status, "ready-empty");
});

test("scan distinguishes store-only adapters and isolates discovery failures", async () => {
  const registry = new AdapterRegistry()
    .register(adapter("store", { installed: false, sessions: [{ id: "s1" }] }))
    .register(adapter("broken", { discoveryError: "cannot read sessions" }))
    .register(adapter("healthy", { sessions: [{ id: "h1" }] }));

  const result = await scanRegistry(registry);
  assert.equal(result.adapters.find((item) => item.id === "store").status, "store-only");
  const broken = result.adapters.find((item) => item.id === "broken");
  assert.equal(broken.status, "discovery-error");
  assert.match(broken.errors.discovery.message, /cannot read sessions/);
  assert.equal(result.adapters.find((item) => item.id === "healthy").sessionCount, 1);
  assert.equal(result.erroredAdapters, 1);
});

test("SessionBridge scan can target selected adapters by alias", async () => {
  const registry = new AdapterRegistry()
    .register(adapter("alpha", { aliases: ["a"], sessions: [{ id: "a1" }] }))
    .register(adapter("beta", { sessions: [{ id: "b1" }] }));
  const bridge = new SessionBridge(registry);
  const result = await bridge.scan({ adapterIds: ["a"] });
  assert.equal(result.adapterCount, 1);
  assert.equal(result.adapters[0].id, "alpha");
});
