import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAdapter } from "./contract.js";

function moduleSpecifier(specifier) {
  const value = String(specifier ?? "").trim();
  if (!value) throw new Error("Adapter module specifier is required");
  if (value.startsWith("file:") || value.startsWith("data:") || value.startsWith("node:")) return value;
  if (path.isAbsolute(value) || value.startsWith("./") || value.startsWith("../")) {
    return pathToFileURL(path.resolve(value)).href;
  }
  return value;
}

async function materializeModuleAdapters(module, options) {
  let candidates = [];

  if (typeof module.createAdapter === "function") {
    candidates.push(await module.createAdapter(options));
  }
  if (module.adapter) candidates.push(module.adapter);
  if (Array.isArray(module.adapters)) candidates.push(...module.adapters);

  if (module.default) {
    if (typeof module.default === "function") {
      candidates.push(await module.default(options));
    } else {
      candidates.push(module.default);
    }
  }

  candidates = candidates.flat().filter(Boolean);
  if (!candidates.length) {
    throw new Error("Adapter module must export default, adapter, adapters, or createAdapter");
  }

  for (const adapter of candidates) validateAdapter(adapter);
  return candidates;
}

export async function loadAdapterModule(specifier, options = {}) {
  const module = await import(moduleSpecifier(specifier));
  return materializeModuleAdapters(module, options);
}

export async function registerAdapterModule(registry, specifier, options = {}) {
  const adapters = await loadAdapterModule(specifier, options);
  for (const adapter of adapters) registry.register(adapter);
  return adapters;
}

export async function registerAdapterModules(registry, specifiers = [], options = {}) {
  const loaded = [];
  for (const specifier of specifiers) {
    loaded.push(...await registerAdapterModule(registry, specifier, options[specifier] ?? {}));
  }
  return loaded;
}
