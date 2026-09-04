import { createHash } from "node:crypto";
import { readCcbridgeArchive } from "./lossless/archive.js";
import { validatePortableSession } from "./model.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) {
  const serialized = JSON.stringify(stable(value));
  return createHash("sha256").update(serialized === undefined ? "__ccbridge_undefined__" : serialized).digest("hex");
}
function bytesDigest(part) {
  if (part?.sha256) return part.sha256;
  if (typeof part?.data !== "string") return null;
  try { return createHash("sha256").update(Buffer.from(part.data, part.encoding === "base64" ? "base64" : "utf8")).digest("hex"); }
  catch { return digest(part.data); }
}
function agentScope(agent) { return `agent:${agent?.name ?? ""}:${agent?.kind ?? "subagent"}`; }
function partAtom(part, role, scope) {
  if (!part || typeof part !== "object") return { feature: "unknownContent", value: { role, scope, part } };
  if (part.type === "text") return { feature: role === "system" ? "system" : "text", value: { role, scope, text: part.text ?? "" } };
  if (part.type === "tool-call") return { feature: "toolCall", value: { scope, name: part.name ?? null, input: part.input ?? null } };
  if (part.type === "tool-result") return { feature: "toolResult", value: { scope, output: part.output ?? null, isError: Boolean(part.isError) } };
  if (part.type === "reasoning") return { feature: "reasoning", value: { scope, provider: part.provider ?? null, text: part.text ?? null, summary: part.summary ?? null, signature: part.signature ?? null, encrypted: part.encrypted ?? null, raw: part.raw ?? null } };
  if (["attachment", "file", "image", "document", "audio", "video"].includes(part.type)) return { feature: "attachment", value: { scope, name: part.name ?? part.filename ?? null, mimeType: part.mimeType ?? part.mime ?? null, sha256: bytesDigest(part), uri: part.data || part.sha256 ? null : part.uri ?? null, size: part.size ?? null } };
  return { feature: "unknownContent", value: { role, scope, part: stable(part) } };
}
function atomsFromMessages(messages, scope) {
  const atoms = [];
  for (const message of messages ?? []) for (const part of message.content ?? []) atoms.push(partAtom(part, message.role ?? null, scope));
  return atoms;
}
function collectAtoms(session, options = {}) {
  const atoms = atomsFromMessages(session?.messages, "root");
  for (const agent of session?.agents ?? []) {
    const scope = agentScope(agent);
    atoms.push({ feature: "subagent", value: { name: agent.name ?? null, kind: agent.kind ?? null, parentPresent: Boolean(agent.parentId) } });
    atoms.push(...atomsFromMessages(agent.messages, scope));
  }
  if (options.includeRaw) {
    for (const event of session?.events ?? []) atoms.push({ feature: "rawEvent", value: { provider: event.provider ?? null, kind: event.kind ?? null, timestamp: event.timestamp ?? null, data: event.data ?? null } });
    for (const agent of session?.agents ?? []) for (const event of agent.events ?? []) atoms.push({ feature: "rawEvent", value: { scope: agentScope(agent), provider: event.provider ?? null, kind: event.kind ?? null, timestamp: event.timestamp ?? null, data: event.data ?? null } });
  }
  return atoms;
}
function atomBuckets(atoms) {
  const byFeature = new Map();
  for (const atom of atoms) {
    if (!byFeature.has(atom.feature)) byFeature.set(atom.feature, []);
    byFeature.get(atom.feature).push({ ...atom, digest: digest(atom.value) });
  }
  return byFeature;
}
function compareFeature(source = [], target = [], limit = 20) {
  const targetBuckets = new Map();
  for (let i = 0; i < target.length; i += 1) {
    const key = target[i].digest;
    if (!targetBuckets.has(key)) targetBuckets.set(key, []);
    targetBuckets.get(key).push(i);
  }
  const used = new Set();
  const missing = [];
  let preserved = 0;
  for (const atom of source) {
    const bucket = targetBuckets.get(atom.digest);
    while (bucket?.length && used.has(bucket[0])) bucket.shift();
    if (bucket?.length) { used.add(bucket.shift()); preserved += 1; }
    else if (missing.length < limit) missing.push({ digest: atom.digest, value: atom.value });
  }
  const extra = [];
  for (let i = 0; i < target.length; i += 1) {
    if (used.has(i)) continue;
    if (extra.length < limit) extra.push({ digest: target[i].digest, value: target[i].value });
  }
  return { sourceCount: source.length, targetCount: target.length, preservedCount: preserved, missingCount: source.length - preserved, extraCount: target.length - preserved, preservationPercent: source.length ? Math.round((preserved / source.length) * 100) : 100, missing, extra, truncated: source.length - preserved > missing.length || target.length - preserved > extra.length };
}

export function verifyPortableTransfer(source, target, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 20));
  const sourceBuckets = atomBuckets(collectAtoms(source, options));
  const targetBuckets = atomBuckets(collectAtoms(target, options));
  const featureNames = [...new Set([...sourceBuckets.keys(), ...targetBuckets.keys()])].sort();
  const features = {};
  let required = 0;
  let preserved = 0;
  for (const feature of featureNames) {
    const result = compareFeature(sourceBuckets.get(feature) ?? [], targetBuckets.get(feature) ?? [], limit);
    features[feature] = result;
    required += result.sourceCount;
    preserved += result.preservedCount;
  }
  return {
    complete: required === preserved,
    preservationPercent: required ? Math.round((preserved / required) * 100) : 100,
    requiredAtoms: required,
    preservedAtoms: preserved,
    missingAtoms: required - preserved,
    includeRaw: Boolean(options.includeRaw),
    source: { id: source?.id ?? null, adapter: source?.source?.adapter ?? null, messages: source?.messages?.length ?? 0, agents: source?.agents?.length ?? 0 },
    target: { id: target?.id ?? null, adapter: target?.source?.adapter ?? null, messages: target?.messages?.length ?? 0, agents: target?.agents?.length ?? 0 },
    features,
    context: { cwdChanged: source?.cwd !== target?.cwd, sourceCwd: source?.cwd ?? null, targetCwd: target?.cwd ?? null }
  };
}

function validateToolHistory(messages, scope, warnings) {
  const calls = new Map();
  const results = [];
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) warnings.push(`${scope}: message ${message.id ?? "<unknown>"} has no content array`);
    for (const part of message.content ?? []) {
      if (part?.type === "tool-call" && part.id) {
        if (calls.has(String(part.id))) warnings.push(`${scope}: duplicate tool call id ${part.id}`);
        calls.set(String(part.id), part);
      } else if (part?.type === "tool-result" && part.callId) results.push(part);
    }
  }
  const matched = new Set();
  for (const result of results) {
    if (!calls.has(String(result.callId))) warnings.push(`${scope}: tool result has no matching call ${result.callId}`);
    else matched.add(String(result.callId));
  }
  for (const callId of calls.keys()) if (!matched.has(callId)) warnings.push(`${scope}: tool call has no recorded result ${callId}`);
  return { calls: calls.size, results: results.length, matched: matched.size };
}
function validateAgentParents(agents, warnings) {
  const ids = new Set((agents ?? []).map((agent) => String(agent.id)));
  for (const agent of agents ?? []) if (agent.parentId && !ids.has(String(agent.parentId))) warnings.push(`agent ${agent.id}: parent ${agent.parentId} is not present in this PortableSession`);
}
function attachmentStats(session, warnings) {
  let count = 0;
  let byteBacked = 0;
  let referenceOnly = 0;
  const scopes = [{ label: "root", messages: session?.messages ?? [] }, ...(session?.agents ?? []).map((agent) => ({ label: `agent:${agent.id}`, messages: agent.messages ?? [] }))];
  for (const scope of scopes) {
    for (const message of scope.messages) for (const part of message.content ?? []) {
      if (!["attachment", "file", "image", "document", "audio", "video"].includes(part?.type)) continue;
      count += 1;
      if (typeof part.data === "string" || part.path) byteBacked += 1;
      else if (part.uri) { referenceOnly += 1; warnings.push(`${scope.label}: attachment ${part.name ?? part.uri} is reference-only`); }
      else warnings.push(`${scope.label}: attachment ${part.name ?? "<unnamed>"} has no bytes, path, or URI`);
    }
  }
  return { count, byteBacked, referenceOnly };
}
async function verifyNestedProvenance(archive, errors) {
  let checked = 0;
  for (const entry of archive.entries ?? []) {
    if (!entry.path.startsWith("provenance/sources/")) continue;
    checked += 1;
    try {
      const bytes = Buffer.from(entry.content, entry.encoding === "base64" ? "base64" : "utf8");
      const parsed = JSON.parse(bytes.toString("utf8"));
      await readCcbridgeArchive(parsed);
    } catch (error) {
      errors.push(`invalid provenance archive ${entry.path}: ${error.message}`);
    }
  }
  return checked;
}

export async function verifyCcbridgeArchive(input, options = {}) {
  const errors = [];
  const warnings = [];
  let archive;
  try { archive = await readCcbridgeArchive(input); }
  catch (error) { return { valid: false, errors: [error.message], warnings: [], manifestValid: false, portableValid: false }; }

  let portableValid = true;
  try { validatePortableSession({ ...archive.session, agents: archive.session?.agents ?? [], events: archive.session?.events ?? [] }); }
  catch (error) { portableValid = false; errors.push(error.message); }

  const rootTools = validateToolHistory(archive.session?.messages ?? [], "root", warnings);
  const agentTools = {};
  for (const agent of archive.session?.agents ?? []) agentTools[agent.id] = validateToolHistory(agent.messages ?? [], `agent:${agent.id}`, warnings);
  validateAgentParents(archive.session?.agents ?? [], warnings);
  const attachments = attachmentStats(archive.session, warnings);
  const provenanceEntries = (archive.entries ?? []).filter((entry) => entry.path.startsWith("provenance/sources/")).length;
  const deepProvenanceChecked = options.deep ? await verifyNestedProvenance(archive, errors) : 0;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifestValid: true,
    portableValid,
    format: archive.format,
    version: archive.version,
    mode: archive.mode,
    session: { id: archive.session?.id ?? null, messages: archive.session?.messages?.length ?? 0, agents: archive.session?.agents?.length ?? 0, events: archive.session?.events?.length ?? 0 },
    entries: archive.entries?.length ?? 0,
    nativeFormat: archive.nativeArtifact?.format ?? null,
    attachments,
    tools: { root: rootTools, agents: agentTools },
    provenance: { entries: provenanceEntries, deepChecked: deepProvenanceChecked },
    deep: Boolean(options.deep)
  };
}
