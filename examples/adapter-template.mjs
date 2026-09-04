// Minimal external ccbridge adapter template.
// Load with: ccbridge adapters --plugin ./examples/adapter-template.mjs

export function createAdapter(options = {}) {
  return {
    id: options.id ?? "example-agent",
    name: options.name ?? "Example Agent",
    aliases: options.aliases ?? ["example"],

    async detect() {
      return {
        installed: false,
        note: "Replace this with product-specific detection"
      };
    },

    async listSessions() {
      return [];
    },

    async readSession(ref) {
      throw new Error(`Implement readSession for ${ref}`);
    }
  };
}
