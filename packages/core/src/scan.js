function cloneDetection(value) {
  if (!value || typeof value !== "object") return { installed: null };
  return { ...value };
}

function normalizeError(error) {
  if (!error) return null;
  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    code: error.code ?? null
  };
}

function sessionSummary(session) {
  return {
    id: session?.id ?? null,
    title: session?.title ?? null,
    cwd: session?.cwd ?? null,
    path: session?.path ?? null,
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
    size: Number.isFinite(session?.size) ? session.size : null,
    kind: session?.kind ?? null
  };
}

function statusFor({ detection, discoverySupported, sessionCount, detectionError, discoveryError }) {
  if (discoveryError) return "discovery-error";
  if (detectionError && sessionCount === null) return "detection-error";
  if (sessionCount > 0) return detection?.installed === false ? "store-only" : "ready";
  if (detection?.installed === true) return discoverySupported ? "ready-empty" : "installed";
  if (detection?.installed === false) return "not-installed";
  return discoverySupported ? "unknown" : "unsupported";
}

export async function scanAdapter(adapter, options = {}) {
  const includeSessions = options.includeSessions === true;
  const limit = Math.max(1, Number(options.limit ?? 20));
  let detection = { installed: null };
  let detectionError = null;
  try {
    if (typeof adapter.detect === "function") detection = cloneDetection(await adapter.detect());
  } catch (error) {
    detectionError = normalizeError(error);
    detection = { installed: false, error: detectionError.message };
  }

  const discoverySupported = Boolean(adapter.capabilities?.discover && typeof adapter.listSessions === "function");
  let sessions = null;
  let discoveryError = null;
  if (discoverySupported) {
    try {
      const result = await adapter.listSessions();
      sessions = Array.isArray(result) ? result : [];
    } catch (error) {
      discoveryError = normalizeError(error);
    }
  }

  const sessionCount = sessions ? sessions.length : discoverySupported && !discoveryError ? 0 : null;
  const newest = sessions?.reduce((latest, session) => {
    const value = session?.updatedAt ?? session?.createdAt ?? null;
    if (!value) return latest;
    return !latest || String(value) > String(latest) ? value : latest;
  }, null) ?? null;

  return {
    id: adapter.id,
    name: adapter.name,
    aliases: adapter.aliases ?? [],
    status: statusFor({ detection, discoverySupported, sessionCount, detectionError, discoveryError }),
    installed: detection?.installed ?? null,
    detection,
    capabilities: adapter.capabilities ?? {},
    discoverySupported,
    sessionCount,
    newestSessionAt: newest,
    sessions: includeSessions && sessions ? sessions.slice(0, limit).map(sessionSummary) : undefined,
    sessionsTruncated: Boolean(includeSessions && sessions && sessions.length > limit),
    errors: {
      detection: detectionError,
      discovery: discoveryError
    }
  };
}

export async function scanRegistry(registry, options = {}) {
  const requested = Array.isArray(options.adapterIds) ? options.adapterIds.filter(Boolean) : [];
  const adapters = requested.length
    ? requested.map((id) => registry.get(id))
    : registry.list();

  const results = [];
  for (const adapter of adapters) {
    results.push(await scanAdapter(adapter, options));
  }

  const totalSessions = results.reduce((sum, item) => sum + (item.sessionCount ?? 0), 0);
  const discoveredAdapters = results.filter((item) => (item.sessionCount ?? 0) > 0).length;
  const readyAdapters = results.filter((item) => ["ready", "ready-empty", "store-only", "installed"].includes(item.status)).length;
  const erroredAdapters = results.filter((item) => item.errors.detection || item.errors.discovery).length;

  return {
    scannedAt: new Date().toISOString(),
    adapterCount: results.length,
    readyAdapters,
    discoveredAdapters,
    erroredAdapters,
    totalSessions,
    adapters: results
  };
}
