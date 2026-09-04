import { normalizeAdapterId, validateAdapter } from "./contract.js";

export class AdapterRegistry {
  #adapters = new Map();
  #aliases = new Map();

  register(adapter) {
    const descriptor = validateAdapter(adapter);
    const id = descriptor.id;

    if (this.#adapters.has(id)) {
      throw new Error(`Adapter already registered: ${id}`);
    }

    if (adapter.id !== id) adapter.id = id;
    adapter.aliases = descriptor.aliases;
    adapter.capabilities = descriptor.capabilities;

    this.#adapters.set(id, adapter);
    this.#aliases.set(id, id);

    for (const alias of descriptor.aliases) {
      if (this.#aliases.has(alias)) {
        throw new Error(`Adapter alias already registered: ${alias}`);
      }
      this.#aliases.set(alias, id);
    }
    return this;
  }

  has(idOrAlias) {
    const key = normalizeAdapterId(idOrAlias);
    return this.#aliases.has(key) || this.#adapters.has(key);
  }

  get(idOrAlias) {
    const key = normalizeAdapterId(idOrAlias);
    const id = this.#aliases.get(key) ?? key;
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw new Error(`Unknown adapter: ${idOrAlias}`);
    }
    return adapter;
  }

  list() {
    return [...this.#adapters.values()];
  }
}
