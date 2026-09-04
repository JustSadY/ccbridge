const FEATURE_LABELS = {
  text: "visible text",
  toolCall: "tool calls",
  toolResult: "tool results",
  reasoning: "provider reasoning/thinking",
  system: "system messages",
  attachment: "attachments/files",
  unknownContent: "unknown content blocks",
  rawEvent: "raw provider events",
  metadata: "session metadata"
};

export function analyzeSessionFeatures(session) {
  const counts = Object.fromEntries(Object.keys(FEATURE_LABELS).map((key) => [key, 0]));
  for (const message of session?.messages ?? []) {
    if (message.role === "system") counts.system += 1;
    for (const part of message.content ?? []) {
      if (part?.type === "text") counts.text += 1;
      else if (part?.type === "tool-call") counts.toolCall += 1;
      else if (part?.type === "tool-result") counts.toolResult += 1;
      else if (part?.type === "reasoning") counts.reasoning += 1;
      else if (["attachment", "file", "image", "document", "audio", "video"].includes(part?.type)) counts.attachment += 1;
      else counts.unknownContent += 1;
    }
  }
  counts.rawEvent = session?.events?.length ?? 0;
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
    features.push({
      feature,
      label: FEATURE_LABELS[feature] ?? feature,
      count,
      target: supported ? "preserved" : "not-represented",
      archive: supported ? "also-preserved" : losslessArchive ? "bundle-only" : "not-preserved"
    });
  }

  return {
    directItems: direct,
    totalItems: total,
    targetPercent: total ? Math.round((direct / total) * 100) : 100,
    archivePercent: losslessArchive ? 100 : null,
    features,
    targetSupport: support
  };
}

export function nativeFidelityReport(session, artifact, options = {}) {
  return {
    directItems: null,
    totalItems: Object.values(analyzeSessionFeatures(session)).reduce((sum, value) => sum + value, 0),
    targetPercent: null,
    archivePercent: options.losslessArchive ? 100 : null,
    nativeFormat: artifact?.format ?? null,
    note: "Native importer selected; ccbridge does not claim a numeric target fidelity without an explicit target guarantee.",
    features: Object.entries(analyzeSessionFeatures(session)).filter(([, count]) => count).map(([feature, count]) => ({ feature, label: FEATURE_LABELS[feature] ?? feature, count, target: "native-importer-managed", archive: options.losslessArchive ? "preserved" : "not-measured" }))
  };
}
