import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";

test("adapter registry resolves aliases", () => {
  const registry = new AdapterRegistry();
  const adapter = { id: "example", aliases: ["ex"] };
  registry.register(adapter);
  assert.equal(registry.get("example"), adapter);
  assert.equal(registry.get("ex"), adapter);
});

test("adapter registry rejects duplicate aliases", () => {
  const registry = new AdapterRegistry();
  registry.register({ id: "a", aliases: ["same"] });
  assert.throws(() => registry.register({ id: "b", aliases: ["same"] }), /already registered/);
});
