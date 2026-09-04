import { nativeImportPreservation, transferPreservationClass } from "./fidelity.js";

function uniq(values) { return [...new Set((values ?? []).filter(Boolean).map(String))].sort(); }
function intersects(left, right) { const accepted = new Set(right); return left.filter((value) => accepted.has(value)); }
function supports(adapter, capability, method) { return adapter?.capabilities?.[capability] !== false && typeof adapter?.[method] === "function"; }

export function analyzeStaticRoute(source, target) {
  if (!source || !target) throw new Error("Source and target adapters are required");
  const sourceNativeFormats = uniq(source.nativeExports ?? source.nativeFormats ?? []);
  const targetNativeFormats = uniq(target.nativeImports ?? target.nativeFormats ?? []);
  const canNativeExport = supports(source, "nativeExport", "getNativeArtifact") && sourceNativeFormats.length > 0;
  const canNativeImport = supports(target, "nativeImport", "importNativeArtifact") && targetNativeFormats.length > 0;
  const nativeFormats = canNativeExport && canNativeImport ? intersects(sourceNativeFormats, targetNativeFormats) : [];
  const nativePreservation = Object.fromEntries(nativeFormats.map((format) => [format, nativeImportPreservation(target, format)]));
  const exactNativeFormats = nativeFormats.filter((format) => nativePreservation[format] === "exact");
  const remappedNativeFormats = nativeFormats.filter((format) => nativePreservation[format] === "remapped");
  const portable = source.capabilities?.portableRead !== false && supports(source, "read", "readSession") && supports(target, "write", "writePortableSession");
  const sourceLossless = Boolean(source.capabilities?.losslessRead && typeof source.readSession === "function");
  const route = nativeFormats.length ? "native" : portable ? "portable" : "none";
  const primaryNativeClass = nativeFormats.length === 1 ? nativePreservation[nativeFormats[0]] : nativeFormats.length ? (exactNativeFormats.length === nativeFormats.length ? "exact" : remappedNativeFormats.length === nativeFormats.length ? "remapped" : "best-effort") : null;
  const targetClass = route === "native" ? primaryNativeClass : route === "portable" ? "portable" : "none";
  const losslessRoute = !sourceLossless ? "none" : nativeFormats.length ? "native+archive" : portable ? "portable+archive" : "none";
  const strictLossless = !sourceLossless ? "unavailable" : exactNativeFormats.length ? "native-for-listed-formats" : portable ? "session-dependent" : "unavailable";
  return {
    from: source.id,
    to: target.id,
    route,
    nativeFormats,
    nativePreservation,
    portable,
    preservation: transferPreservationClass({ route, nativePreservation: primaryNativeClass, losslessArchive: false }),
    lossless: {
      sourceSupported: sourceLossless,
      route: losslessRoute,
      strict: strictLossless,
      strictNativeFormats: exactNativeFormats,
      remappedNativeFormats,
      sideArchive: sourceLossless && route !== "none",
      preservation: transferPreservationClass({ route, nativePreservation: primaryNativeClass, losslessArchive: sourceLossless && route !== "none" })
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
