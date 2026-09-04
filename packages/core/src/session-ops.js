import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPortableSession } from "./model.js";
import { materializeCcbridgeNative, readCcbridgeArchive, writeCcbridgeArchive } from "./lossless/archive.js";

function safe(value) { return String(value ?? "session").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session"; }
function generatedId(prefix, base = "session") { return `${prefix}-${safe(base)}-${randomUUID().replaceAll("-", "").slice(0, 10)}`; }
function sourceDescriptor(session) { return { adapter: session?.source?.adapter ?? null, sessionId: session?.source?.sessionId ?? session?.id ?? null, id: session?.id ?? null, title: session?.title ?? null, cwd: session?.cwd ?? null }; }
function operations(metadata) { return Array.isArray(metadata?.ccbridgeOperations) ? structuredClone(metadata.ccbridgeOperations) : []; }
function timestamp(value) { const parsed = value ? new Date(value).getTime() : NaN; return Number.isFinite(parsed) ? parsed : null; }
function earliest(...values) { const valid = values.map(timestamp).filter((value) => value !== null); return valid.length ? new Date(Math.min(...valid)).toISOString() : null; }
function latest(...values) { const valid = values.map(timestamp).filter((value) => value !== null); return valid.length ? new Date(Math.max(...valid)).toISOString() : null; }
function chronological(items) {
  return items.map((item, order) => ({ item, order, time: timestamp(item.createdAt ?? item.timestamp) }))
    .sort((a, b) => a.time === null && b.time === null ? a.order - b.order : a.time === null ? 1 : b.time === null ? -1 : a.time - b.time || a.order - b.order)
    .map(({ item }) => item);
}
function tagMessages(messages, side, source) {
  return (messages ?? []).map((message) => ({ ...structuredClone(message), metadata: { ...(message.metadata ?? {}), ccbridgeMergeSource: { side, adapter: source.adapter, sessionId: source.sessionId } } }));
}
function tagEvents(events, side, source) {
  return (events ?? []).map((event) => ({ ...structuredClone(event), ccbridgeMergeSource: { side, adapter: source.adapter, sessionId: source.sessionId } }));
}
function namespaceAgents(agents, side, source) {
  const idMap = new Map((agents ?? []).map((agent) => [String(agent.id), `${side}:${agent.id}`]));
  return (agents ?? []).map((agent) => ({
    ...structuredClone(agent),
    id: idMap.get(String(agent.id)),
    parentId: agent.parentId ? idMap.get(String(agent.parentId)) ?? agent.parentId : null,
    metadata: {
      ...(agent.metadata ?? {}),
      ccbridgeMergeSource: { side, adapter: source.adapter, sessionId: source.sessionId, originalAgentId: agent.id, originalParentId: agent.parentId ?? null }
    }
  }));
}
function sourceArchiveExtra(input, side) {
  const filename = typeof input === "string" ? path.basename(input) : `${side}.ccbridge`;
  const entryPath = `provenance/sources/${side}-${safe(filename)}`;
  if (typeof input === "string") return { entryPath, sourcePath: path.resolve(input), mediaType: "application/vnd.ccbridge+json" };
  return { entryPath, content: `${JSON.stringify(input, null, 2)}\n`, encoding: "utf8", mediaType: "application/vnd.ccbridge+json" };
}

export function forkPortableSession(session, options = {}) {
  if (!session || typeof session !== "object") throw new Error("A PortableSession is required for fork");
  const clone = structuredClone(session);
  const id = String(options.id ?? generatedId("fork", session.id));
  const op = { type: "fork", createdAt: new Date().toISOString(), parent: sourceDescriptor(session), parentPortableId: session.id };
  return createPortableSession({
    ...clone,
    id,
    title: options.title ?? (session.title ? `Fork of ${session.title}` : `Fork of ${session.id}`),
    source: { adapter: "ccbridge", sessionId: id, path: null },
    metadata: { ...(clone.metadata ?? {}), ccbridgeOperations: [...operations(clone.metadata), op] },
    agents: clone.agents ?? []
  });
}

export function mergePortableSessions(left, right, options = {}) {
  if (!left || !right) throw new Error("Two PortableSessions are required for merge");
  const leftSource = sourceDescriptor(left);
  const rightSource = sourceDescriptor(right);
  const id = String(options.id ?? generatedId("merge", `${left.id}-${right.id}`));
  const cwd = options.cwd ?? (left.cwd === right.cwd ? left.cwd : left.cwd ?? right.cwd ?? null);
  const messages = chronological([...tagMessages(left.messages, "left", leftSource), ...tagMessages(right.messages, "right", rightSource)]);
  const events = chronological([...tagEvents(left.events, "left", leftSource), ...tagEvents(right.events, "right", rightSource)]);
  const agents = [...namespaceAgents(left.agents, "left", leftSource), ...namespaceAgents(right.agents, "right", rightSource)];
  const mergeOp = {
    type: "merge",
    createdAt: new Date().toISOString(),
    strategy: "timeline-no-dedupe",
    sources: { left: leftSource, right: rightSource },
    cwdConflict: left.cwd && right.cwd && left.cwd !== right.cwd ? { left: left.cwd, right: right.cwd, selected: cwd } : null
  };
  const eitherLossless = Boolean(left.lossless?.enabled || right.lossless?.enabled);
  const rawRecordCount = (left.events?.length ?? 0) + (right.events?.length ?? 0) + agents.reduce((sum, agent) => sum + (agent.events?.length ?? 0), 0);
  return createPortableSession({
    schemaVersion: 1,
    id,
    title: options.title ?? `Merged: ${left.title ?? left.id} + ${right.title ?? right.id}`,
    cwd,
    startedAt: earliest(left.startedAt, right.startedAt),
    updatedAt: latest(left.updatedAt, right.updatedAt),
    source: { adapter: "ccbridge", sessionId: id, path: null },
    messages,
    agents,
    metadata: {
      ccbridgeOperations: [...operations(left.metadata), ...operations(right.metadata), mergeOp],
      ccbridgeMerge: mergeOp,
      ccbridgeMergeSources: {
        left: { descriptor: leftSource, metadata: structuredClone(left.metadata ?? {}), lossless: structuredClone(left.lossless ?? null) },
        right: { descriptor: rightSource, metadata: structuredClone(right.metadata ?? {}), lossless: structuredClone(right.lossless ?? null) }
      }
    },
    events,
    lossless: eitherLossless ? {
      enabled: true,
      sourceFormat: "ccbridge/merged-session",
      rawRecordCount,
      includesProviderReasoning: Boolean(left.lossless?.includesProviderReasoning || right.lossless?.includesProviderReasoning),
      includesUnknownEvents: Boolean(left.lossless?.includesUnknownEvents || right.lossless?.includesUnknownEvents),
      includesSubagents: agents.length > 0,
      provenanceArchivesEmbedded: true
    } : null
  });
}

export async function forkCcbridgeArchive(input, options = {}) {
  const loaded = await readCcbridgeArchive(input);
  const forked = forkPortableSession(loaded.session, options);
  const materialized = await materializeCcbridgeNative(loaded);
  try {
    const written = await writeCcbridgeArchive(forked, {
      destination: options.destination,
      from: "ccbridge",
      mode: loaded.mode ?? "portable",
      nativeArtifact: materialized?.artifact ?? null,
      metadata: { operation: "fork", sourceArchiveVersion: loaded.version, source: loaded.source ?? null },
      extraEntries: [sourceArchiveExtra(input, "parent")]
    });
    return { ...written, operation: "fork", sessionId: forked.id, parentSessionId: loaded.session.id, provenanceEntries: 1 };
  } finally {
    if (materialized) await materialized.cleanup();
  }
}

export async function mergeCcbridgeArchives(leftInput, rightInput, options = {}) {
  const [left, right] = await Promise.all([readCcbridgeArchive(leftInput), readCcbridgeArchive(rightInput)]);
  const merged = mergePortableSessions(left.session, right.session, options);
  const mode = left.mode === "lossless" || right.mode === "lossless" ? "lossless" : "portable";
  const written = await writeCcbridgeArchive(merged, {
    destination: options.destination,
    from: "ccbridge",
    mode,
    metadata: { operation: "merge", sources: [left.source ?? sourceDescriptor(left.session), right.source ?? sourceDescriptor(right.session)] },
    extraEntries: [sourceArchiveExtra(leftInput, "left"), sourceArchiveExtra(rightInput, "right")]
  });
  return {
    ...written,
    operation: "merge",
    sessionId: merged.id,
    sourceSessionIds: [left.session.id, right.session.id],
    messageCount: merged.messages.length,
    agentCount: merged.agents.length,
    provenanceEntries: 2,
    strategy: "timeline-no-dedupe"
  };
}

export async function extractProvenanceArchive(archiveInput, entryPath, destination) {
  const archive = await readCcbridgeArchive(archiveInput);
  const entry = archive.entries?.find((item) => item.path === entryPath);
  if (!entry || !entryPath.startsWith("provenance/sources/")) throw new Error(`Provenance source entry not found: ${entryPath}`);
  const bytes = Buffer.from(entry.content, entry.encoding === "base64" ? "base64" : "utf8");
  const output = path.resolve(destination ?? path.basename(entryPath));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, bytes, { mode: 0o600 });
  return { path: output, bytes: bytes.length, entry: entryPath };
}
