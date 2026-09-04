import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";

test("adapter registry resolves aliases", () => {
  const registry = new AdapterRegistry();
  const adapter = { id: "example", name: "Example", aliases: ["ex"] };
  registry.register(adapter);
  assert.equal(registry.get("example"), adapter);
  assert.equal(registry.get("ex"), adapter);
});

test("adapter registry rejects duplicate aliases", () => {
  const registry = new AdapterRegistry();
  registry.register({ id: "a", name: "A", aliases: ["same"] });
  assert.throws(() => registry.register({ id: "b", name: "B", aliases: ["same"] }), /already registered/);
});

test("adapter registry derives capabilities from implemented methods", () => {
  const registry = new AdapterRegistry();
  const adapter = {
    id: "reader",
    name: "Reader",
    async readSession() {}
  };
  registry.register(adapter);
  assert.equal(adapter.capabilities.read, true);
  assert.equal(adapter.capabilities.write, false);
});
