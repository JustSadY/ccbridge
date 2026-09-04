const FEATURE_LABELS = {
  text: "visible text",
  toolCall: "tool calls",
  toolResult: "tool results",
  reasoning: "provider reasoning/thinking",
  system: "system messages",
  attachment: "attachments/files",
  subagent: "subagent / agent-tree history",
  unknownContent: "unknown content blocks",
  rawEvent: "raw provider events",
  metadata: "session metadata"
};

export const NATIVE_PRESERVATION_CLASSES = Object.freeze(["exact", "remapped", "best-effort"]);

export function nativeImportPreservation(target, format) {
  if (!target || !format) return "best-effort";
  const explicit = target.nativeImportPreservation?.[format];
  if (NATIVE_PRESERVATION_CLASSES.includes(explicit)) return explicit;
  if ((target.losslessNativeImports ?? []).includes(format)) return "exact";
  return "best-effort";
}

export function transferPreservationClass({ route, nativePreservation = null, losslessArchive = false } = {}) {
  const targetClass = route === "native" ? (nativePreservation ?? "best-effort") : route === "portable" ? "portable" : "none";
  return {
    targetClass,
    sideArchive: Boolean(losslessArchive && route !== "none"),
    overallClass: losslessArchive && route !== "none" && targetClass !== "exact" ? `${targetClass}+side-archive` : targetClass
  };
}

function countMessages(messages, counts) {
  for (const message of messages ?? []) {
    if (message?.role === "system") counts.system += 1;
    for (const part of message?.content ?? []) {
      if (part?.type === "text") counts.text += 1;
      else if (part?.type === "tool-call") counts.toolCall += 1;
      else if (part?.type === "tool-result") counts.toolResult += 1;
      else if (part?.type === "reasoning") counts.reasoning += 1;
      else if (["attachment", "file", "image", "document", "audio", "video"].includes(part?.type)) counts.attachment += 1;
      else counts.unknownContent += 1;
    }
  }
}

export function analyzeSessionFeatures(session) {
  const counts = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, 0]));
  countMessages(session?.messages, counts);
  const agents = session?.agents ?? [];
  for (const agent of agents) countMessages(agent?.messages, counts);
  counts.subagent = agents.length;
  counts.rawEvent = (session?.events?.length ?? 0) + agents.reduce((sum, agent) => sum + (agent?.events?.length ?? 0), 0);
  counts.metadata = session?.metadata && Object.keys(session.metadata).length ? 1 : 0;
  return counts;
}

export function evaluatePortableFidelity(session, target, options = {}) {
  const counts = analyzeSessionFeatures(session);
  const support = target?.portableSupport ?? {};
  const losslessArchive = options.losslessArchive === true;
  const features = [];
  let total = 0;
  let direct = 0;

  for (const [feature, count] of Object.entries(counts)) {
    if (!count) continue;
    total += count;
    const supported = support[feature] === true;
    if (supported) direct += count;
    features.push({ feature, label: FEATURE_LABELS[feature] ?? feature, count, target: supported ? "preserved" : "not-represented", archive: supported ? "also-preserved" : losslessArchive ? "bundle-only" : "not-preserved" });
  }

  return {
    directItems: direct,
    totalItems: total,
    targetPercent: total ? Math.round((direct / total) * 100) : 100,
    archivePercent: losslessArchive ? 100 : null,
    features,
    targetSupport: support,
    preservation: transferPreservationClass({ route: "portable", losslessArchive })
  };
}

export function nativeFidelityReport(session, artifact, options = {}) {
  const nativePreservation = options.nativePreservation ?? "best-effort";
  const preservation = transferPreservationClass({ route: "native", nativePreservation, losslessArchive: options.losslessArchive === true });
  const targetPercent = nativePreservation === "exact" ? 100 : null;
  const note = nativePreservation === "exact"
    ? "Target explicitly guarantees exact native preservation for this format."
    : nativePreservation === "remapped"
      ? "Native payload content is retained, but target-owned context such as project, cwd, path, identity, or indexing may be remapped."
      : "Native importer selected; ccbridge does not claim exact target fidelity without an explicit target guarantee.";
  return {
    directItems: null,
    totalItems: Object.values(analyzeSessionFeatures(session)).reduce((sum, value) => sum + value, 0),
    targetPercent,
    archivePercent: options.losslessArchive ? 100 : null,
    nativeFormat: artifact?.format ?? null,
    nativePreservation,
    preservation,
    note,
    features: Object.entries(analyzeSessionFeatures(session)).filter(([, count]) => count).map(([feature, count]) => ({ feature, label: FEATURE_LABELS[feature] ?? feature, count, target: nativePreservation === "exact" ? "preserved" : nativePreservation === "remapped" ? "native-remapped" : "native-importer-managed", archive: options.losslessArchive ? "preserved" : "not-measured" }))
  };
}
