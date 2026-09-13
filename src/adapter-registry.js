export class AdapterRegistry {
  #adapters = new Map();

  register(adapter) {
    if (!adapter?.id || this.#adapters.has(adapter.id)) throw new Error(`Invalid or duplicate adapter: ${adapter?.id}`);
    this.#adapters.set(adapter.id, adapter);
  }

  get(id) {
    return this.#adapters.get(id);
  }

  async describe() {
    return Promise.all([...this.#adapters.values()].map(async (adapter) => ({
      id: adapter.id,
      label: adapter.label,
      capabilities: adapter.capabilities,
      availability: await adapter.detect(),
    })));
  }
}

