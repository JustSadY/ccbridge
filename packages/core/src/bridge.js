import { adapterAcceptsNativeArtifact, nativeArtifactFormat } from "./adapters/contract.js";
import { normalizeTransferMode } from "./model.js";
import { writeLosslessBundle } from "./lossless/archive.js";

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

  async inspect(adapterId, sessionRef, options = {}) {
    const adapter = this.registry.get(adapterId);
    if (!adapter.capabilities?.read || typeof adapter.readSession !== "function") {
      throw new Error(`${adapter.id} does not support session reading`);
    }
    const mode = normalizeTransferMode(options.mode ?? "portable");
    return adapter.readSession(sessionRef, { ...options, mode });
  }

  async planTransfer({ from, to, session, cwd, mode = "portable", bundle = null }) {
    const source = this.registry.get(from);
    const target = this.registry.get(to);
    const transferMode = normalizeTransferMode(mode);

    let portable = null;
    if (transferMode === "lossless") {
      if (typeof source.readSession !== "function") {
        throw new Error(`${source.id} cannot produce a lossless session representation`);
      }
      portable = await source.readSession(session, { mode: transferMode });
      if (!portable?.lossless?.enabled) {
        throw new Error(`${source.id} did not return lossless session data`);
      }
    }

    if (typeof source.getNativeArtifact === "function" && typeof target.importNativeArtifact === "function") {
      const artifact = await source.getNativeArtifact(session);
      if (await adapterAcceptsNativeArtifact(target, artifact)) {
        return {
          route: "native",
          mode: transferMode,
          from: source.id,
          to: target.id,
          session,
          cwd: cwd ?? artifact.cwd ?? portable?.cwd ?? null,
          artifact,
          format: nativeArtifactFormat(artifact),
          portable,
          bundle,
          preservation: transferMode === "lossless" ? "native+lossless-bundle" : "native"
        };
      }
    }

    if (!portable && typeof source.readSession === "function") {
      portable = await source.readSession(session, { mode: transferMode });
    }

    if (portable && typeof target.writePortableSession === "function") {
      return {
        route: "portable",
        mode: transferMode,
        from: source.id,
        to: target.id,
        session,
        cwd: cwd ?? portable.cwd ?? null,
        portable,
        bundle,
        sessionId: portable.id,
        messageCount: portable.messages.length,
        eventCount: portable.events?.length ?? 0,
        preservation: transferMode === "lossless" ? "portable+lossless-bundle" : "portable"
      };
    }

    throw new Error(`No compatible transfer route from ${source.id} to ${target.id}`);
  }

  async transfer({ from, to, session, cwd, mode = "portable", bundle = null, dryRun = false }) {
    const target = this.registry.get(to);
    const plan = await this.planTransfer({ from, to, session, cwd, mode, bundle });

    if (dryRun) {
      return {
        dryRun: true,
        route: plan.route,
        mode: plan.mode,
        from: plan.from,
        to: plan.to,
        session: plan.session,
        sessionId: plan.portable?.id ?? null,
        cwd: plan.cwd,
        format: plan.format ?? null,
        artifact: plan.artifact ?? null,
        messageCount: plan.portable?.messages?.length ?? null,
        eventCount: plan.portable?.events?.length ?? null,
        preservation: plan.preservation,
        losslessBundle: plan.mode === "lossless"
          ? { planned: true, destination: plan.bundle ?? "<CCBRIDGE_HOME>/lossless/..." }
          : null
      };
    }

    let result;
    if (plan.route === "native") {
      result = await target.importNativeArtifact(plan.artifact, { cwd: plan.cwd, mode: plan.mode });
    } else {
      result = await target.writePortableSession(plan.portable, { cwd: plan.cwd, mode: plan.mode });
    }

    if (plan.mode !== "lossless") {
      return result;
    }

    const losslessBundle = await writeLosslessBundle(plan.portable, {
      from: plan.from,
      to: plan.to,
      destination: plan.bundle
    });

    return {
      route: plan.route,
      mode: plan.mode,
      preservation: plan.preservation,
      result,
      losslessBundle
    };
  }
}
