const BUILTIN_CONTRACTS = {
  "claude-code": { contractVersion: 1, sourceFormats: ["claude-code/session-jsonl"], recordKinds: ["user", "assistant", "system", "progress", "queue-operation", "file-history-snapshot"], recordKindPrefixes: [], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, testedVersions: [] },
  codex: { contractVersion: 1, sourceFormats: ["codex/rollout-jsonl"], recordKinds: ["session_meta", "response_item", "event_msg", "compacted"], recordKindPrefixes: [], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, testedVersions: [] },
  "gemini-cli": { contractVersion: 1, sourceFormats: ["gemini-cli/session-jsonl", "gemini-cli/session-json"], recordKinds: ["user", "gemini", "model", "tool", "metadata", "rewind", "metadata-update"], recordKindPrefixes: [], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, testedVersions: [] },
  opencode: { contractVersion: 1, sourceFormats: ["opencode/session-json"], recordKinds: ["session-info", "message-info"], recordKindPrefixes: ["part:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, testedVersions: [] },
  "antigravity-cli": { contractVersion: 1, sourceFormats: ["antigravity-cli/conversation-sqlite-v1"], recordKinds: ["sqlite-container"], recordKindPrefixes: [], contentTypes: [], preserveUnknownRecords: true, opaque: true, testedVersions: [] },
  aider: { contractVersion: 1, sourceFormats: ["aider/chat-history-markdown-v1"], recordKinds: ["markdown-section"], recordKindPrefixes: [], contentTypes: ["text"], preserveUnknownRecords: true, presentationOriented: true, testedVersions: [] },
  cline: { contractVersion: 1, sourceFormats: ["cline/messages-json-v1"], recordKinds: [], recordKindPrefixes: ["message:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning"], preserveUnknownRecords: true, testedVersions: [] },
  "roo-code": { contractVersion: 1, sourceFormats: ["roo-code/api-conversation-history-v1"], recordKinds: [], recordKindPrefixes: ["api-message:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, archivedUpstream: true, testedVersions: [] },
  continue: { contractVersion: 1, sourceFormats: ["continue/session-transcript-markdown-v1"], recordKinds: [], recordKindPrefixes: ["markdown:"], contentTypes: ["text"], preserveUnknownRecords: true, presentationOriented: true, exportOnly: true, testedVersions: [] },
  cursor: { contractVersion: 1, sourceFormats: ["cursor/agent-transcript-jsonl-v1"], recordKinds: [], recordKindPrefixes: ["message:", "record:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning"], preserveUnknownRecords: true, transcriptMayBeIncomplete: true, testedVersions: [] },
  "vscode-chat": { contractVersion: 1, sourceFormats: ["vscode-chat/session-v1", "vscode-chat/session-v2", "vscode-chat/session-v3"], recordKinds: ["session-state", "request"], recordKindPrefixes: ["response-part:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning"], preserveUnknownRecords: true, openSourceStorageContract: true, testedVersions: [] },
  goose: { contractVersion: 1, sourceFormats: ["goose/session-json"], recordKinds: [], recordKindPrefixes: ["message:"], contentTypes: ["text", "tool-call", "tool-result", "reasoning", "attachment"], preserveUnknownRecords: true, officialImportExport: true, testedVersions: [] }
};

function unique(values) { return [...new Set(values.filter((value) => value !== null && value !== undefined).map(String))].sort(); }
function cloneContract(contract) { return contract ? { ...contract, sourceFormats: [...(contract.sourceFormats ?? [])], recordKinds: [...(contract.recordKinds ?? [])], recordKindPrefixes: [...(contract.recordKindPrefixes ?? [])], contentTypes: [...(contract.contentTypes ?? [])], testedVersions: [...(contract.testedVersions ?? [])] } : null; }
export function adapterCompatibilityContract(adapter) { return cloneContract(adapter?.compatibility ?? BUILTIN_CONTRACTS[adapter?.id] ?? null); }
function knownRecordKind(kind, contract) { if (!contract) return null; if ((contract.recordKinds ?? []).includes(kind)) return true; if ((contract.recordKindPrefixes ?? []).some((prefix) => String(kind).startsWith(prefix))) return true; return false; }
function collectContentTypes(session) { const types = []; const groups = [session?.messages ?? [], ...(session?.agents ?? []).map((agent) => agent.messages ?? [])]; for (const messages of groups) for (const message of messages) for (const part of message.content ?? []) types.push(part?.type ?? "unknown"); return unique(types); }
function collectRecordKinds(session) { const kinds = []; for (const event of session?.events ?? []) kinds.push(event?.kind ?? "unknown"); for (const agent of session?.agents ?? []) for (const event of agent.events ?? []) kinds.push(event?.kind ?? "unknown"); return unique(kinds); }
function versionEvidence(version, contract) { if (!version) return { status: "unknown", version: null, testedVersions: contract?.testedVersions ?? [] }; const tested = contract?.testedVersions ?? []; return { status: tested.includes(version) ? "tested" : "unverified", version, testedVersions: tested }; }
async function safeDetect(adapter) { if (typeof adapter?.detect !== "function") return { detection: { installed: null, version: null }, error: null }; try { return { detection: await adapter.detect(), error: null }; } catch (error) { return { detection: { installed: false, version: null }, error: { message: error.message, code: error.code ?? null } }; } }

export async function checkAdapterCompatibility(adapter, options = {}) {
  const contract = adapterCompatibilityContract(adapter);
  const detected = await safeDetect(adapter);
  const report = { id: adapter.id, name: adapter.name, contract, installed: detected.detection?.installed ?? null, detectedVersion: detected.detection?.version ?? null, versionEvidence: versionEvidence(detected.detection?.version ?? null, contract), detectionError: detected.error, sessionProbe: null };
  if (!options.sessionRef) { report.status = contract ? "contract-available" : "no-contract"; return report; }
  if (typeof adapter.readSession !== "function") { report.status = "unprobeable"; report.sessionProbe = { error: "adapter does not support session reading" }; return report; }
  const mode = adapter.capabilities?.losslessRead ? "lossless" : "portable";
  let session;
  try { session = await adapter.readSession(options.sessionRef, { mode }); } catch (error) { report.status = "probe-error"; report.sessionProbe = { error: error.message, mode }; return report; }
  const sourceFormat = session?.lossless?.sourceFormat ?? null;
  const recordKinds = collectRecordKinds(session);
  const contentTypes = collectContentTypes(session);
  const unknownRecordKinds = contract ? recordKinds.filter((kind) => knownRecordKind(kind, contract) === false) : recordKinds;
  const unknownContentTypes = contract ? contentTypes.filter((type) => !(contract.contentTypes ?? []).includes(type)) : contentTypes;
  const sourceFormatKnown = contract ? Boolean(sourceFormat && (contract.sourceFormats ?? []).includes(sourceFormat)) : null;
  const driftDetected = Boolean(contract && !contract.opaque && ((sourceFormat && !sourceFormatKnown) || unknownRecordKinds.length || unknownContentTypes.length));
  report.status = contract?.opaque ? "opaque-native" : !contract ? "no-contract" : driftDetected ? "drift-detected" : "schema-known";
  report.sessionProbe = {
    sessionId: session.id, mode, sourceFormat, sourceFormatKnown, recordKinds, unknownRecordKinds, contentTypes, unknownContentTypes,
    preserveUnknownRecords: contract?.preserveUnknownRecords ?? null,
    rawEventCount: (session.events?.length ?? 0) + (session.agents ?? []).reduce((sum, agent) => sum + (agent.events?.length ?? 0), 0),
    messageCount: (session.messages?.length ?? 0) + (session.agents ?? []).reduce((sum, agent) => sum + (agent.messages?.length ?? 0), 0),
    agentCount: session.agents?.length ?? 0, driftDetected,
    note: unknownRecordKinds.length && contract?.preserveUnknownRecords ? "Unknown raw records are preserved losslessly, but semantic parsing coverage should be reviewed." : contract?.transcriptMayBeIncomplete ? "The provider transcript is supported as written, but some provider versions omit tool results, usage, timestamps, or reasoning from this artifact." : contract?.presentationOriented ? "Source history is presentation-oriented; semantic role classification is best-effort while the raw section is preserved." : contract?.archivedUpstream ? "Upstream project is archived; compatibility is pinned to the last documented storage contract." : contract?.exportOnly ? "Adapter reads the provider's explicit export artifact; private live-session storage is intentionally not assumed." : contract?.openSourceStorageContract ? "Adapter follows the open-source on-disk chat storage contract and preserves unfamiliar response parts as raw events." : contract?.officialImportExport ? "Adapter uses the provider's official session list/export/import CLI instead of mutating its private database." : null
  };
  return report;
}

export async function compatibilityReport(registry, options = {}) {
  const ids = Array.isArray(options.adapterIds) ? options.adapterIds.filter(Boolean) : [];
  const adapters = ids.length ? ids.map((id) => registry.get(id)) : registry.list();
  const reports = [];
  for (const adapter of adapters) reports.push(await checkAdapterCompatibility(adapter, { sessionRef: options.sessionRefs?.[adapter.id] ?? (adapters.length === 1 ? options.sessionRef : null) }));
  return { generatedAt: new Date().toISOString(), adapterCount: reports.length, driftDetected: reports.some((item) => item.status === "drift-detected"), unverifiedVersions: reports.filter((item) => item.versionEvidence.status === "unverified").map((item) => ({ id: item.id, version: item.detectedVersion })), adapters: reports };
}

export const BUILTIN_COMPATIBILITY_CONTRACTS = BUILTIN_CONTRACTS;
