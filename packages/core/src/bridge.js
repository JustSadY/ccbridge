export class SessionBridge {
  constructor(registry) {
    this.registry = registry;
  }

  listAdapters() {
    return this.registry.list().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      aliases: adapter.aliases ?? [],
      capabilities: adapter.capabilities ?? {}
    }));
  }

  async doctor() {
    const results = [];
    for (const adapter of this.registry.list()) {
      let detection;
      try {
        detection = typeof adapter.detect === "function" ? await adapter.detect() : { installed: null };
      } catch (error) {
        detection = { installed: false, error: error.message };
      }
      results.push({ id: adapter.id, name: adapter.name, detection });
    }
    return results;
  }

  async listSessions(adapterId) {
    const adapter = this.registry.get(adapterId);
    if (!adapter.capabilities?.discover || typeof adapter.listSessions !== "function") {
      throw new Error(`${adapter.id} does not support session discovery`);
    }
    return adapter.listSessions();
  }

  async inspect(adapterId, sessionRef) {
    const adapter = this.registry.get(adapterId);
    if (!adapter.capabilities?.read || typeof adapter.readSession !== "function") {
      throw new Error(`${adapter.id} does not support session reading`);
    }
    return adapter.readSession(sessionRef);
  }

  async transfer({ from, to, session, cwd, dryRun = false }) {
    const source = this.registry.get(from);
    const target = this.registry.get(to);

    if (typeof source.getNativeArtifact === "function" && typeof target.importNativeArtifact === "function") {
      const artifact = await source.getNativeArtifact(session);
      return target.importNativeArtifact(artifact, { cwd, dryRun });
    }

    if (typeof source.readSession !== "function") {
      throw new Error(`${source.id} cannot read portable sessions`);
    }
    if (typeof target.writePortableSession !== "function") {
      throw new Error(`${target.id} cannot write portable sessions and no native route exists from ${source.id}`);
    }

    const portable = await source.readSession(session);
    if (dryRun) {
      return {
        dryRun: true,
        route: "portable",
        from: source.id,
        to: target.id,
        sessionId: portable.id,
        messageCount: portable.messages.length,
        cwd: cwd ?? portable.cwd
      };
    }
    return target.writePortableSession(portable, { cwd });
  }
}
