import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { analyzeSessionFeatures } from "./fidelity.js";
import { readCcbridgeArchive } from "./lossless/archive.js";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function digest(value) { return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex"); }
function dataDigest(data, encoding = "base64") {
  if (typeof data !== "string") return null;
  try { return createHash("sha256").update(Buffer.from(data, encoding === "base64" ? "base64" : "utf8")).digest("hex"); }
  catch { return digest(data); }
}
function normalizePart(part) {
  if (!part || typeof part !== "object") return part;
  if (["attachment", "file", "image", "document", "audio", "video"].includes(part.type)) {
    return {
      type: "attachment",
      name: part.name ?? part.filename ?? null,
      mimeType: part.mimeType ?? part.mime ?? null,
      sha256: part.sha256 ?? dataDigest(part.data, part.encoding),
      size: part.size ?? null,
      uri: part.data || part.sha256 ? null : part.uri ?? null,
      metadata: part.metadata ?? {}
    };
  }
  if (part.type === "tool-call") return { type: part.type, name: part.name ?? null, input: part.input ?? null };
  if (part.type === "tool-result") return { type: part.type, output: part.output ?? null, isError: Boolean(part.isError) };
  if (part.type === "reasoning") return { type: part.type, provider: part.provider ?? null, text: part.text ?? null, summary: part.summary ?? null, signature: part.signature ?? null, encrypted: part.encrypted ?? null, raw: part.raw ?? null };
  if (part.type === "text") return { type: "text", text: part.text ?? "" };
  return stable(part);
}
function semanticMessage(message) { return { role: message?.role ?? null, content: (message?.content ?? []).map(normalizePart) }; }
function semanticEvent(event) { const clone = { ...event }; delete clone.index; delete clone.ccbridgeMergeSource; return clone; }
function semanticAgent(agent) {
  return {
    parentId: agent?.parentId ?? null,
    name: agent?.name ?? null,
    kind: agent?.kind ?? null,
    messages: (agent?.messages ?? []).map(semanticMessage),
    events: (agent?.events ?? []).map(semanticEvent),
    metadata: agent?.metadata ?? {}
  };
}
function textPreview(message) {
  const text = (message?.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join(" ").replace(/\s+/g, " ").trim();
  return text.slice(0, 120) || null;
}
function itemPreview(item, kind) {
  if (kind === "message") return { id: item?.id ?? null, role: item?.role ?? null, types: (item?.content ?? []).map((part) => part?.type ?? "unknown"), text: textPreview(item) };
  if (kind === "agent") return { id: item?.id ?? null, parentId: item?.parentId ?? null, name: item?.name ?? null, kind: item?.kind ?? null, messages: item?.messages?.length ?? 0, events: item?.events?.length ?? 0 };
  if (kind === "event") return { index: item?.index ?? null, provider: item?.provider ?? null, kind: item?.kind ?? null, timestamp: item?.timestamp ?? null };
  return { value: item };
}
function compareMultiset(left, right, digestFn, kind, limit) {
  const buckets = new Map();
  for (let index = 0; index < right.length; index += 1) {
    const key = digestFn(right[index]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(index);
  }
  const matchedRight = new Set();
  const leftOnly = [];
  let equivalent = 0;
  for (const item of left) {
    const key = digestFn(item);
    const bucket = buckets.get(key);
    while (bucket?.length && matchedRight.has(bucket[0])) bucket.shift();
    if (bucket?.length) { matchedRight.add(bucket.shift()); equivalent += 1; }
    else if (leftOnly.length < limit) leftOnly.push({ digest: key, ...itemPreview(item, kind) });
  }
  const rightOnly = [];
  for (let index = 0; index < right.length; index += 1) {
    if (matchedRight.has(index)) continue;
    if (rightOnly.length < limit) rightOnly.push({ digest: digestFn(right[index]), ...itemPreview(right[index], kind) });
  }
  return { leftCount: left.length, rightCount: right.length, equivalentCount: equivalent, leftOnlyCount: left.length - equivalent, rightOnlyCount: right.length - equivalent, leftOnly, rightOnly, truncated: left.length - equivalent > leftOnly.length || right.length - equivalent > rightOnly.length };
}
function changedById(left, right, semanticFn, kind, limit) {
  const leftMap = new Map(left.filter((item) => item?.id).map((item) => [String(item.id), item]));
  const rightMap = new Map(right.filter((item) => item?.id).map((item) => [String(item.id), item]));
  const changed = [];
  let count = 0;
  for (const [id, leftItem] of leftMap) {
    const rightItem = rightMap.get(id);
    if (!rightItem) continue;
    const leftDigest = digest(semanticFn(leftItem));
    const rightDigest = digest(semanticFn(rightItem));
    if (leftDigest === rightDigest) continue;
    count += 1;
    if (changed.length < limit) changed.push({ id, leftDigest, rightDigest, left: itemPreview(leftItem, kind), right: itemPreview(rightItem, kind) });
  }
  return { count, items: changed, truncated: count > changed.length };
}
function topLevelMetadataDiff(left = {}, right = {}, limit = 50) {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const changed = [];
  let count = 0;
  for (const key of keys) {
    const a = digest(left[key]);
    const b = digest(right[key]);
    if (a === b) continue;
    count += 1;
    if (changed.length < limit) changed.push({ key, leftDigest: a, rightDigest: b, leftPresent: Object.hasOwn(left, key), rightPresent: Object.hasOwn(right, key) });
  }
  return { changedCount: count, changed, truncated: count > changed.length };
}
function featureDiff(left, right) {
  const a = analyzeSessionFeatures(left);
  const b = analyzeSessionFeatures(right);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return Object.fromEntries(keys.map((key) => [key, { left: a[key] ?? 0, right: b[key] ?? 0, delta: (b[key] ?? 0) - (a[key] ?? 0) }]));
}

export function diffPortableSessions(left, right, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 20));
  const messages = compareMultiset(left?.messages ?? [], right?.messages ?? [], (item) => digest(semanticMessage(item)), "message", limit);
  const agents = compareMultiset(left?.agents ?? [], right?.agents ?? [], (item) => digest(semanticAgent(item)), "agent", limit);
  const events = compareMultiset(left?.events ?? [], right?.events ?? [], (item) => digest(semanticEvent(item)), "event", limit);
  const exactSemanticEqual = messages.leftOnlyCount === 0 && messages.rightOnlyCount === 0 && agents.leftOnlyCount === 0 && agents.rightOnlyCount === 0 && events.leftOnlyCount === 0 && events.rightOnlyCount === 0 && digest(left?.metadata ?? {}) === digest(right?.metadata ?? {}) && digest(left?.lossless ?? null) === digest(right?.lossless ?? null);
  return {
    equal: exactSemanticEqual,
    left: { id: left?.id ?? null, source: left?.source ?? null, cwd: left?.cwd ?? null, title: left?.title ?? null },
    right: { id: right?.id ?? null, source: right?.source ?? null, cwd: right?.cwd ?? null, title: right?.title ?? null },
    messages: { ...messages, changedById: changedById(left?.messages ?? [], right?.messages ?? [], semanticMessage, "message", limit) },
    agents: { ...agents, changedById: changedById(left?.agents ?? [], right?.agents ?? [], semanticAgent, "agent", limit) },
    events,
    features: featureDiff(left, right),
    metadata: topLevelMetadataDiff(left?.metadata ?? {}, right?.metadata ?? {}, limit),
    losslessDescriptorChanged: digest(left?.lossless ?? null) !== digest(right?.lossless ?? null),
    cwdChanged: left?.cwd !== right?.cwd,
    titleChanged: left?.title !== right?.title
  };
}

function archiveEntryDiff(leftEntries = [], rightEntries = [], limit = 50) {
  const left = new Map(leftEntries.map((entry) => [entry.path, entry]));
  const right = new Map(rightEntries.map((entry) => [entry.path, entry]));
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changed = [];
  const leftOnly = [];
  const rightOnly = [];
  let same = 0;
  for (const entryPath of paths) {
    const a = left.get(entryPath);
    const b = right.get(entryPath);
    if (!a) { if (rightOnly.length < limit) rightOnly.push({ path: entryPath, sha256: b.sha256, bytes: b.bytes, mediaType: b.mediaType }); continue; }
    if (!b) { if (leftOnly.length < limit) leftOnly.push({ path: entryPath, sha256: a.sha256, bytes: a.bytes, mediaType: a.mediaType }); continue; }
    if (a.sha256 === b.sha256 && a.bytes === b.bytes && a.mediaType === b.mediaType) { same += 1; continue; }
    if (changed.length < limit) changed.push({ path: entryPath, left: { sha256: a.sha256, bytes: a.bytes, mediaType: a.mediaType }, right: { sha256: b.sha256, bytes: b.bytes, mediaType: b.mediaType } });
  }
  const leftOnlyCount = paths.filter((entryPath) => left.has(entryPath) && !right.has(entryPath)).length;
  const rightOnlyCount = paths.filter((entryPath) => right.has(entryPath) && !left.has(entryPath)).length;
  const changedCount = paths.filter((entryPath) => left.has(entryPath) && right.has(entryPath) && (left.get(entryPath).sha256 !== right.get(entryPath).sha256 || left.get(entryPath).bytes !== right.get(entryPath).bytes || left.get(entryPath).mediaType !== right.get(entryPath).mediaType)).length;
  return { leftCount: left.size, rightCount: right.size, sameCount: same, changedCount, leftOnlyCount, rightOnlyCount, changed, leftOnly, rightOnly, truncated: changedCount > changed.length || leftOnlyCount > leftOnly.length || rightOnlyCount > rightOnly.length };
}
async function fileDigest(input) {
  if (typeof input !== "string") return null;
  const bytes = await fs.readFile(input);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export async function diffCcbridgeArchives(leftInput, rightInput, options = {}) {
  const [left, right, leftFile, rightFile] = await Promise.all([readCcbridgeArchive(leftInput), readCcbridgeArchive(rightInput), fileDigest(leftInput), fileDigest(rightInput)]);
  const portable = diffPortableSessions(left.session, right.session, options);
  const entries = archiveEntryDiff(left.entries ?? [], right.entries ?? [], Math.max(1, Number(options.limit ?? 20)));
  const byteIdentical = Boolean(leftFile && rightFile && leftFile.sha256 === rightFile.sha256 && leftFile.bytes === rightFile.bytes);
  return {
    equal: byteIdentical,
    byteIdentical,
    semanticEqual: portable.equal,
    files: { left: leftFile, right: rightFile },
    archive: {
      left: { format: left.format, version: left.version, mode: left.mode, source: left.source ?? null, nativeFormat: left.nativeArtifact?.format ?? null },
      right: { format: right.format, version: right.version, mode: right.mode, source: right.source ?? null, nativeFormat: right.nativeArtifact?.format ?? null },
      entries
    },
    portable
  };
}
