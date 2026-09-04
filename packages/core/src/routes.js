function uniq(values) { return [...new Set((values ?? []).filter(Boolean).map(String))].sort(); }
function intersects(left, right) { const accepted = new Set(right); return left.filter((value) => accepted.has(value)); }
function supports(adapter, capability, method) { return adapter?.capabilities?.[capability] !== false && typeof adapter?.[method] === "function"; }

export function analyzeStaticRoute(source, target) {
  if (!source || !target) throw new Error("Source and target adapters are required");
  const sourceNativeFormats = uniq(source.nativeExports ?? source.nativeFormats ?? []);
  const targetNativeFormats = uniq(target.nativeImports ?? target.nativeFormats ?? []);
  const strictTargetNativeFormats = uniq(target.losslessNativeImports ?? []);
  const canNativeExport = supports(source, "nativeExport", "getNativeArtifact") && sourceNativeFormats.length > 0;
  const canNativeImport = supports(target, "nativeImport", "importNativeArtifact") && targetNativeFormats.length > 0;
  const nativeFormats = canNativeExport && canNativeImport ? intersects(sourceNativeFormats, targetNativeFormats) : [];
  const strictNativeFormats = nativeFormats.filter((format) => strictTargetNativeFormats.includes(format));
  const portable = source.capabilities?.portableRead !== false && supports(source, "read", "readSession") && supports(target, "write", "writePortableSession");
  const sourceLossless = Boolean(source.capabilities?.losslessRead && typeof source.readSession === "function");
  const route = nativeFormats.length ? "native" : portable ? "portable" : "none";
  const losslessRoute = !sourceLossless ? "none" : nativeFormats.length ? "native+archive" : portable ? "portable+archive" : "none";
  const strictLossless = !sourceLossless ? "unavailable" : strictNativeFormats.length ? "native-for-listed-formats" : portable ? "session-dependent" : "unavailable";
  return {
    from: source.id,
    to: target.id,
    route,
    nativeFormats,
    portable,
    lossless: {
      sourceSupported: sourceLossless,
      route: losslessRoute,
      strict: strictLossless,
      strictNativeFormats,
      sideArchive: sourceLossless && route !== "none"
    }
  };
}

export function routeMatrix(registry, options = {}) {
  const fromIds = options.from ? [registry.get(options.from).id] : null;
  const toIds = options.to ? [registry.get(options.to).id] : null;
  const includeSelf = options.includeSelf !== false;
  const adapters = registry.list();
  const rows = [];
  for (const source of adapters) {
    if (fromIds && !fromIds.includes(source.id)) continue;
    for (const target of adapters) {
      if (toIds && !toIds.includes(target.id)) continue;
      if (!includeSelf && source.id === target.id) continue;
      rows.push(analyzeStaticRoute(source, target));
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    adapterCount: adapters.length,
    from: fromIds?.[0] ?? null,
    to: toIds?.[0] ?? null,
    rows
  };
}
