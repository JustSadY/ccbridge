import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CCBRIDGE_ARCHIVE_FORMAT = "ccbridge/session";
export const CCBRIDGE_ARCHIVE_VERSION = 1;
export const LEGACY_LOSSLESS_BUNDLE_FORMAT = "ccbridge/lossless-session";
export const LOSSLESS_BUNDLE_FORMAT = CCBRIDGE_ARCHIVE_FORMAT;
export const LOSSLESS_BUNDLE_VERSION = CCBRIDGE_ARCHIVE_VERSION;

export function defaultCcbridgeHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CCBRIDGE_HOME || path.join(home, ".ccbridge");
}

function safeName(value) {
  return String(value ?? "unknown")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
}

function assertSession(session) {
  if (!session || typeof session !== "object" || !session.id || !session.source?.adapter) {
    throw new Error("A valid PortableSession is required");
  }
}

async function embedNativeArtifact(artifact) {
  if (!artifact?.path) return null;
  const bytes = await fs.readFile(artifact.path);
  return {
    kind: artifact.kind ?? "agent-session",
    format: artifact.format ?? null,
    formatVersion: artifact.formatVersion ?? null,
    sourceAdapter: artifact.sourceAdapter ?? null,
    cwd: artifact.cwd ?? null,
    sessionId: artifact.sessionId ?? null,
    filename: path.basename(artifact.path),
    encoding: "base64",
    content: bytes.toString("base64")
  };
}

export function validateCcbridgeArchive(archive) {
  if (!archive || typeof archive !== "object") throw new Error("Invalid ccbridge archive: expected an object");
  if (archive.format === LEGACY_LOSSLESS_BUNDLE_FORMAT && archive.version === 1 && archive.session) {
    return {
      format: CCBRIDGE_ARCHIVE_FORMAT,
      version: CCBRIDGE_ARCHIVE_VERSION,
      createdAt: archive.createdAt ?? null,
      source: { adapter: archive.from ?? archive.session.source?.adapter ?? null, sessionId: archive.session.id ?? null },
      intendedTarget: archive.to ?? null,
      mode: archive.session.lossless?.enabled ? "lossless" : "portable",
      session: archive.session,
      nativeArtifact: null,
      metadata: { migratedFromLegacyFormat: LEGACY_LOSSLESS_BUNDLE_FORMAT }
    };
  }
  if (archive.format !== CCBRIDGE_ARCHIVE_FORMAT) throw new Error(`Unsupported ccbridge archive format: ${archive.format ?? "unknown"}`);
  if (archive.version !== CCBRIDGE_ARCHIVE_VERSION) throw new Error(`Unsupported ccbridge archive version: ${archive.version ?? "unknown"}`);
  assertSession(archive.session);
  if (archive.nativeArtifact && (archive.nativeArtifact.encoding !== "base64" || typeof archive.nativeArtifact.content !== "string")) {
    throw new Error("Invalid embedded native artifact");
  }
  return archive;
}

export async function writeCcbridgeArchive(session, options = {}) {
  assertSession(session);
  const home = options.home ?? defaultCcbridgeHome(options);
  const destination = options.destination
    ? path.resolve(options.destination)
    : path.join(home, "archives", `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeName(options.from ?? session.source?.adapter)}-${safeName(session.id)}.ccbridge`);
  const nativeArtifact = await embedNativeArtifact(options.nativeArtifact ?? null);
  const archive = {
    format: CCBRIDGE_ARCHIVE_FORMAT,
    version: CCBRIDGE_ARCHIVE_VERSION,
    createdAt: new Date().toISOString(),
    source: { adapter: options.from ?? session.source?.adapter ?? null, sessionId: session.id },
    intendedTarget: options.to ?? null,
    mode: session.lossless?.enabled ? "lossless" : options.mode ?? "portable",
    session,
    nativeArtifact,
    metadata: options.metadata && typeof options.metadata === "object" ? options.metadata : {}
  };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
  try { await fs.chmod(destination, 0o600); } catch {}
  return {
    path: destination,
    format: CCBRIDGE_ARCHIVE_FORMAT,
    version: CCBRIDGE_ARCHIVE_VERSION,
    mode: archive.mode,
    embeddedNativeFormat: nativeArtifact?.format ?? null,
    embeddedNativeBytes: nativeArtifact ? Buffer.from(nativeArtifact.content, "base64").length : 0,
    eventCount: session.events?.length ?? 0,
    messageCount: session.messages?.length ?? 0
  };
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
  const filename = safeName(embedded.filename || `${archive.source?.sessionId ?? "session"}.bin`);
  const nativePath = path.join(root, filename);
  await fs.writeFile(nativePath, Buffer.from(embedded.content, "base64"), { mode: 0o600 });
  let cleaned = false;
  return {
    artifact: {
      kind: embedded.kind ?? "agent-session",
      format: embedded.format,
      formatVersion: embedded.formatVersion ?? null,
      sourceAdapter: embedded.sourceAdapter ?? archive.source?.adapter ?? null,
      path: nativePath,
      cwd: embedded.cwd ?? archive.session?.cwd ?? null,
      sessionId: embedded.sessionId ?? archive.source?.sessionId ?? archive.session?.id ?? null
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (!options.directory) await fs.rm(root, { recursive: true, force: true });
    }
  };
}

export async function writeLosslessBundle(session, options = {}) {
  if (!session?.lossless?.enabled) throw new Error("Lossless bundle requires a session read in lossless mode");
  return writeCcbridgeArchive(session, { ...options, mode: "lossless" });
}
