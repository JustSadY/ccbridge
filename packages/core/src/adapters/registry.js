export class AdapterRegistry {
  #adapters = new Map();
  #aliases = new Map();

  register(adapter) {
    if (!adapter?.id) {
      throw new Error("Adapter must have an id");
    }
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }

    this.#adapters.set(adapter.id, adapter);
    this.#aliases.set(adapter.id, adapter.id);

    for (const alias of adapter.aliases ?? []) {
      const normalized = String(alias).toLowerCase();
      if (this.#aliases.has(normalized)) {
        throw new Error(`Adapter alias already registered: ${alias}`);
      }
      this.#aliases.set(normalized, adapter.id);
    }
    return this;
  }

  get(idOrAlias) {
    const key = String(idOrAlias ?? "").toLowerCase();
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
