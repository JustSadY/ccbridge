import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { loadAdapterModule, registerAdapterModule } from "../src/adapters/loader.js";

test("loads an adapter from a module factory", async () => {
  const source = `export function createAdapter(options) {
    return { id: options.id, name: "Dynamic Adapter", aliases: ["dyn"] };
  }`;
  const specifier = `data:text/javascript,${encodeURIComponent(source)}`;
  const adapters = await loadAdapterModule(specifier, { id: "dynamic" });

  assert.equal(adapters.length, 1);
  assert.equal(adapters[0].id, "dynamic");
  assert.equal(adapters[0].name, "Dynamic Adapter");
});

test("registers dynamically loaded adapters into a registry", async () => {
  const source = `export default { id: "plugin", name: "Plugin Adapter", aliases: ["plug"] };`;
  const specifier = `data:text/javascript,${encodeURIComponent(source)}`;
  const registry = new AdapterRegistry();

  await registerAdapterModule(registry, specifier);
  assert.equal(registry.get("plug").id, "plugin");
});
