import { adapterAcceptsNativeArtifact, nativeArtifactFormat } from "./adapters/contract.js";

export class SessionBridge {
  constructor(registry) {
    this.registry = registry;
  }

  listAdapters() {
    return this.registry.list().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      aliases: adapter.aliases ?? [],
      capabilities: adapter.capabilities ?? {},
      nativeImports: adapter.nativeImports ?? adapter.nativeFormats ?? []
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

  async planTransfer({ from, to, session, cwd }) {
    const source = this.registry.get(from);
    const target = this.registry.get(to);

    if (typeof source.getNativeArtifact === "function" && typeof target.importNativeArtifact === "function") {
      const artifact = await source.getNativeArtifact(session);
      if (await adapterAcceptsNativeArtifact(target, artifact)) {
        return {
          route: "native",
          from: source.id,
          to: target.id,
          session,
          cwd: cwd ?? artifact.cwd ?? null,
          artifact,
          format: nativeArtifactFormat(artifact)
        };
      }
    }

    if (typeof source.readSession === "function" && typeof target.writePortableSession === "function") {
      const portable = await source.readSession(session);
      return {
        route: "portable",
        from: source.id,
        to: target.id,
        session,
        cwd: cwd ?? portable.cwd ?? null,
        portable,
        sessionId: portable.id,
        messageCount: portable.messages.length
      };
    }

    throw new Error(`No compatible transfer route from ${source.id} to ${target.id}`);
  }

  async transfer({ from, to, session, cwd, dryRun = false }) {
    const target = this.registry.get(to);
    const plan = await this.planTransfer({ from, to, session, cwd });

    if (dryRun) {
      if (plan.route === "native") {
        return {
          dryRun: true,
          route: plan.route,
          from: plan.from,
          to: plan.to,
          session: plan.session,
          cwd: plan.cwd,
          format: plan.format,
          artifact: plan.artifact
        };
      }
      return {
        dryRun: true,
        route: plan.route,
        from: plan.from,
        to: plan.to,
        sessionId: plan.sessionId,
        messageCount: plan.messageCount,
        cwd: plan.cwd
      };
    }

    if (plan.route === "native") {
      return target.importNativeArtifact(plan.artifact, { cwd: plan.cwd });
    }
    return target.writePortableSession(plan.portable, { cwd: plan.cwd });
  }
}
