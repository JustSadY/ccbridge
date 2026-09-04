import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const CCBRIDGE_ARCHIVE_FORMAT = "ccbridge/session";
export const CCBRIDGE_ARCHIVE_VERSION = 2;
export const LEGACY_CCBRIDGE_ARCHIVE_VERSION = 1;
export const LEGACY_LOSSLESS_BUNDLE_FORMAT = "ccbridge/lossless-session";
export const LOSSLESS_BUNDLE_FORMAT = CCBRIDGE_ARCHIVE_FORMAT;
export const LOSSLESS_BUNDLE_VERSION = CCBRIDGE_ARCHIVE_VERSION;
export function defaultCcbridgeHome({ env = process.env, home = os.homedir() } = {}) { return env.CCBRIDGE_HOME || path.join(home, ".ccbridge"); }
function safeName(value) { return String(value ?? "unknown").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown"; }
function assertSession(session) { if (!session || typeof session !== "object" || !session.id || !session.source?.adapter) throw new Error("A valid PortableSession is required"); }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function entryBytes(entry) {
  if (!entry || typeof entry.content !== "string") throw new Error(`Invalid ccbridge entry content: ${entry?.path ?? "unknown"}`);
  if (entry.encoding === "base64") return Buffer.from(entry.content, "base64");
  if (entry.encoding === "utf8") return Buffer.from(entry.content, "utf8");
  throw new Error(`Unsupported ccbridge entry encoding: ${entry.encoding ?? "unknown"}`);
}
function makeEntry(entryPath, bytes, { mediaType = "application/octet-stream", encoding = "base64" } = {}) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    path: entryPath,
    mediaType,
    bytes: data.length,
    sha256: sha256(data),
    encoding,
    content: encoding === "utf8" ? data.toString("utf8") : data.toString("base64")
  };
}
function verifyEntry(entry, expectedPath = null) {
  if (!entry || typeof entry !== "object") throw new Error(`Missing ccbridge entry: ${expectedPath ?? "unknown"}`);
  if (expectedPath && entry.path !== expectedPath) throw new Error(`Invalid ccbridge entry path: expected ${expectedPath}, got ${entry.path ?? "unknown"}`);
  if (!entry.path || !entry.mediaType || !Number.isInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 ?? ""))) throw new Error(`Invalid ccbridge entry metadata: ${entry.path ?? expectedPath ?? "unknown"}`);
  const bytes = entryBytes(entry);
  if (bytes.length !== entry.bytes) throw new Error(`ccbridge entry size mismatch: ${entry.path}`);
  const digest = sha256(bytes);
  if (digest !== String(entry.sha256).toLowerCase()) throw new Error(`ccbridge entry checksum mismatch: ${entry.path}`);
  return bytes;
}
function parseJsonEntry(entry, expectedPath) {
  const bytes = verifyEntry(entry, expectedPath);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`Invalid JSON in ccbridge entry: ${expectedPath}`); }
}
function findEntry(archive, entryPath) {
  const entry = archive.entries?.find((item) => item?.path === entryPath);
  if (!entry) throw new Error(`Missing ccbridge entry: ${entryPath}`);
  return entry;
}
async function bytesFor(entry) {
  if (entry?.path) return fs.readFile(entry.path);
  if (entry?.content !== undefined) return Buffer.from(String(entry.content), entry.encoding === "base64" ? "base64" : "utf8");
  return null;
}
function uniqueNativePath(filename, used) {
  const base = safeName(filename || "native.bin");
  let candidate = `native/${base}`;
  let index = 2;
  while (used.has(candidate)) {
    const extension = path.extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    candidate = `native/${stem}-${index}${extension}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

async function buildV2Entries(session, artifact) {
  const entries = [];
  const portable = structuredClone(session);
  portable.events = [];
  const events = Array.isArray(session.events) ? session.events : [];
  entries.push(makeEntry("portable/session.json", Buffer.from(`${JSON.stringify(portable, null, 2)}\n`, "utf8"), { mediaType: "application/json", encoding: "utf8" }));
  entries.push(makeEntry("raw/events.json", Buffer.from(`${JSON.stringify(events, null, 2)}\n`, "utf8"), { mediaType: "application/json", encoding: "utf8" }));

  if (!artifact) return { entries, nativeArtifact: null };
  const bytes = await bytesFor(artifact);
  if (!bytes) return { entries, nativeArtifact: null };
  const used = new Set(entries.map((entry) => entry.path));
  const filename = artifact.filename ?? (artifact.path ? path.basename(artifact.path) : `${artifact.sessionId ?? "session"}.bin`);
  const nativePath = uniqueNativePath(filename, used);
  entries.push(makeEntry(nativePath, bytes, { mediaType: artifact.mediaType ?? "application/octet-stream", encoding: "base64" }));
  const companions = [];
  for (const companion of artifact.companions ?? []) {
    const companionBytes = await bytesFor(companion);
    if (!companionBytes) continue;
    const companionFilename = companion.filename ?? (companion.path ? path.basename(companion.path) : "companion.bin");
    const companionPath = uniqueNativePath(companionFilename, used);
    entries.push(makeEntry(companionPath, companionBytes, { mediaType: companion.mediaType ?? "application/octet-stream", encoding: "base64" }));
    companions.push({ filename: companionFilename, entry: companionPath });
  }
  return {
    entries,
    nativeArtifact: {
      kind: artifact.kind ?? "agent-session",
      format: artifact.format ?? null,
      formatVersion: artifact.formatVersion ?? null,
      sourceAdapter: artifact.sourceAdapter ?? null,
      cwd: artifact.cwd ?? null,
      sessionId: artifact.sessionId ?? null,
      filename,
      entry: nativePath,
      companions
    }
  };
}

function normalizeV1Archive(archive) {
  assertSession(archive.session);
  if (archive.nativeArtifact && (archive.nativeArtifact.encoding !== "base64" || typeof archive.nativeArtifact.content !== "string")) throw new Error("Invalid embedded native artifact");
  for (const companion of archive.nativeArtifact?.companions ?? []) {
    if (companion.encoding !== "base64" || typeof companion.content !== "string") throw new Error("Invalid embedded native artifact companion");
  }
  return { ...archive, version: LEGACY_CCBRIDGE_ARCHIVE_VERSION, metadata: { ...(archive.metadata ?? {}), archiveVersion: LEGACY_CCBRIDGE_ARCHIVE_VERSION } };
}

function normalizeV2Archive(archive) {
  if (!Array.isArray(archive.entries)) throw new Error("Invalid ccbridge archive entries");
  const manifestEntries = archive.manifest?.entries;
  if (!Array.isArray(manifestEntries)) throw new Error("Invalid ccbridge archive manifest");
  if (manifestEntries.length !== archive.entries.length) throw new Error("ccbridge manifest entry count mismatch");
  const entryMap = new Map();
  for (const entry of archive.entries) {
    verifyEntry(entry);
    if (entryMap.has(entry.path)) throw new Error(`Duplicate ccbridge entry: ${entry.path}`);
    entryMap.set(entry.path, entry);
  }
  const manifestSeen = new Set();
  for (const descriptor of manifestEntries) {
    if (!descriptor?.path || manifestSeen.has(descriptor.path)) throw new Error(`Duplicate ccbridge manifest entry: ${descriptor?.path ?? "unknown"}`);
    manifestSeen.add(descriptor.path);
    const entry = entryMap.get(descriptor.path);
    if (!entry) throw new Error(`Missing ccbridge entry from manifest: ${descriptor.path}`);
    for (const key of ["mediaType", "bytes", "sha256", "encoding"]) {
      if (entry[key] !== descriptor[key]) throw new Error(`ccbridge manifest mismatch for ${entry.path}: ${key}`);
    }
  }
  if (manifestSeen.size !== entryMap.size) throw new Error("ccbridge manifest does not describe every entry");

  const portable = parseJsonEntry(findEntry(archive, "portable/session.json"), "portable/session.json");
  const events = parseJsonEntry(findEntry(archive, "raw/events.json"), "raw/events.json");
  if (!Array.isArray(events)) throw new Error("Invalid raw/events.json: expected an array");
  portable.events = events;
  assertSession(portable);

  let nativeArtifact = null;
  const native = archive.manifest?.nativeArtifact;
  if (native) {
    const mainEntry = findEntry(archive, native.entry);
    verifyEntry(mainEntry, native.entry);
    const companions = [];
    for (const companion of native.companions ?? []) {
      const companionEntry = findEntry(archive, companion.entry);
      verifyEntry(companionEntry, companion.entry);
      companions.push({ filename: companion.filename ?? path.basename(companion.entry), encoding: companionEntry.encoding, content: companionEntry.content, entry: companion.entry });
    }
    nativeArtifact = {
      kind: native.kind ?? "agent-session",
      format: native.format ?? null,
      formatVersion: native.formatVersion ?? null,
      sourceAdapter: native.sourceAdapter ?? null,
      cwd: native.cwd ?? null,
      sessionId: native.sessionId ?? null,
      filename: native.filename ?? path.basename(native.entry),
      encoding: mainEntry.encoding,
      content: mainEntry.content,
      entry: native.entry,
      companions
    };
  }

  return { ...archive, session: portable, nativeArtifact };
}

export function validateCcbridgeArchive(archive) {
  if (!archive || typeof archive !== "object") throw new Error("Invalid ccbridge archive: expected an object");
  if (archive.format === LEGACY_LOSSLESS_BUNDLE_FORMAT && archive.version === 1 && archive.session) {
    return normalizeV1Archive({
      format: CCBRIDGE_ARCHIVE_FORMAT,
      version: LEGACY_CCBRIDGE_ARCHIVE_VERSION,
      createdAt: archive.createdAt ?? null,
      source: { adapter: archive.from ?? archive.session.source?.adapter ?? null, sessionId: archive.session.id ?? null },
      intendedTarget: archive.to ?? null,
      mode: archive.session.lossless?.enabled ? "lossless" : "portable",
      session: archive.session,
      nativeArtifact: null,
      metadata: { migratedFromLegacyFormat: LEGACY_LOSSLESS_BUNDLE_FORMAT }
    });
  }
  if (archive.format !== CCBRIDGE_ARCHIVE_FORMAT) throw new Error(`Unsupported ccbridge archive format: ${archive.format ?? "unknown"}`);
  if (archive.version === LEGACY_CCBRIDGE_ARCHIVE_VERSION) return normalizeV1Archive(archive);
  if (archive.version === CCBRIDGE_ARCHIVE_VERSION) return normalizeV2Archive(archive);
  throw new Error(`Unsupported ccbridge archive version: ${archive.version ?? "unknown"}`);
}

export async function writeCcbridgeArchive(session, options = {}) {
  assertSession(session);
  const home = options.home ?? defaultCcbridgeHome(options);
  const destination = options.destination ? path.resolve(options.destination) : path.join(home, "archives", `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(options.from ?? session.source?.adapter)}-${safeName(session.id)}.ccbridge`);
  const built = await buildV2Entries(session, options.nativeArtifact ?? null);
  const manifestEntries = built.entries.map(({ content: _content, ...descriptor }) => descriptor);
  const archive = {
    format: CCBRIDGE_ARCHIVE_FORMAT,
    version: CCBRIDGE_ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    source: { adapter: options.from ?? session.source?.adapter ?? null, sessionId: session.id },
    intendedTarget: options.to ?? null,
    mode: session.lossless?.enabled ? "lossless" : options.mode ?? "portable",
    manifest: { version: 1, entries: manifestEntries, nativeArtifact: built.nativeArtifact },
    entries: built.entries,
    metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {}
  };
  validateCcbridgeArchive(archive);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
  try { await fs.chmod(destination, 0o600); } catch {}
  const nativeEntries = built.nativeArtifact ? [built.nativeArtifact.entry, ...(built.nativeArtifact.companions ?? []).map((item) => item.entry)] : [];
  const embeddedNativeBytes = built.entries.filter((entry) => nativeEntries.includes(entry.path)).reduce((sum, entry) => sum + entry.bytes, 0);
  return { path: destination, format: CCBRIDGE_ARCHIVE_FORMAT, version: CCBRIDGE_ARCHIVE_VERSION, mode: archive.mode, embeddedNativeFormat: built.nativeArtifact?.format ?? null, embeddedNativeBytes, embeddedCompanionCount: built.nativeArtifact?.companions?.length ?? 0, entryCount: built.entries.length, eventCount: session.events?.length ?? 0, messageCount: session.messages?.length ?? 0 };
}

export async function readCcbridgeArchive(input) {
  if (input && typeof input === "object" && !Buffer.isBuffer(input)) return validateCcbridgeArchive(input);
  const archivePath = path.resolve(String(input));
  const parsed = JSON.parse(await fs.readFile(archivePath, "utf8"));
  const archive = validateCcbridgeArchive(parsed);
  return { ...archive, archivePath };
}

export async function materializeCcbridgeNative(archiveInput, options = {}) {
  const archive = await readCcbridgeArchive(archiveInput);
  const embedded = archive.nativeArtifact;
  if (!embedded) return null;
  const root = options.directory ? path.resolve(options.directory) : await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-native-"));
  if (options.directory) await fs.mkdir(root, { recursive: true });
  const nativePath = path.join(root, safeName(embedded.filename || `${archive.source?.sessionId ?? "session"}.bin`));
  await fs.writeFile(nativePath, entryBytes(embedded), { mode: 0o600 });
  const companionPaths = [];
  for (const companion of embedded.companions ?? []) {
    const companionPath = path.join(root, safeName(companion.filename));
    await fs.writeFile(companionPath, entryBytes(companion), { mode: 0o600 });
    companionPaths.push(companionPath);
  }
  let cleaned = false;
  return {
    artifact: {
      kind: embedded.kind ?? "agent-session",
      format: embedded.format,
      formatVersion: embedded.formatVersion ?? null,
      sourceAdapter: embedded.sourceAdapter ?? archive.source?.adapter ?? null,
      path: nativePath,
      companions: companionPaths.map((companionPath) => ({ path: companionPath, filename: path.basename(companionPath) })),
      cwd: embedded.cwd ?? archive.session?.cwd ?? null,
      sessionId: embedded.sessionId ?? archive.source?.sessionId ?? archive.session?.id ?? null
    },
    async cleanup() { if (cleaned) return; cleaned = true; if (!options.directory) await fs.rm(root, { recursive: true, force: true }); }
  };
}

export async function writeLosslessBundle(session, options = {}) {
  if (!session?.lossless?.enabled) throw new Error("Lossless bundle requires a session read in lossless mode");
  return writeCcbridgeArchive(session, { ...options, mode: "lossless" });
}
