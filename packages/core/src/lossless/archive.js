import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  CCBRIDGE_ARCHIVE_FORMAT,
  CCBRIDGE_ARCHIVE_VERSION,
  LEGACY_CCBRIDGE_ARCHIVE_VERSION,
  LEGACY_LOSSLESS_BUNDLE_FORMAT,
  LOSSLESS_BUNDLE_FORMAT,
  LOSSLESS_BUNDLE_VERSION,
  defaultCcbridgeHome,
  materializeCcbridgeNative,
  readCcbridgeArchive as readBaseArchive,
  validateCcbridgeArchive as validateBaseArchive,
  writeCcbridgeArchive as writeBaseArchive
} from "./archive-base.js";

export {
  CCBRIDGE_ARCHIVE_FORMAT,
  CCBRIDGE_ARCHIVE_VERSION,
  LEGACY_CCBRIDGE_ARCHIVE_VERSION,
  LEGACY_LOSSLESS_BUNDLE_FORMAT,
  LOSSLESS_BUNDLE_FORMAT,
  LOSSLESS_BUNDLE_VERSION,
  defaultCcbridgeHome,
  materializeCcbridgeNative
};

function safeName(value) { return String(value ?? "attachment").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment"; }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function isAttachmentPart(part) { return ["attachment", "file", "image", "document", "audio", "video"].includes(part?.type); }
function entryBytes(entry) {
  if (entry?.encoding === "base64") return Buffer.from(String(entry.content ?? ""), "base64");
  if (entry?.encoding === "utf8") return Buffer.from(String(entry.content ?? ""), "utf8");
  throw new Error(`Unsupported ccbridge entry encoding: ${entry?.encoding ?? "unknown"}`);
}
function descriptor(entry) { const { content: _content, ...metadata } = entry; return metadata; }
function attachmentName(part, messageIndex, partIndex) {
  if (part?.name) return safeName(part.name);
  if (part?.filename) return safeName(part.filename);
  if (part?.path) return safeName(path.basename(part.path));
  return `attachment-${messageIndex + 1}-${partIndex + 1}.bin`;
}
function dataUrlBytes(uri) {
  const match = typeof uri === "string" ? uri.match(/^data:([^;,]*)(;base64)?,(.*)$/s) : null;
  if (!match) return null;
  try { return match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8"); }
  catch { return null; }
}
async function bytesForAttachment(part) {
  if (part?.path) return fs.readFile(path.resolve(part.path));
  if (typeof part?.data === "string") return Buffer.from(part.data, part.encoding === "base64" ? "base64" : "utf8");
  return dataUrlBytes(part?.uri);
}
function uniqueEntryPath(entries, filename, messageIndex, partIndex) {
  const used = new Set(entries.map((entry) => entry.path));
  const base = `${String(messageIndex + 1).padStart(4, "0")}-${String(partIndex + 1).padStart(3, "0")}-${filename}`;
  let candidate = `attachments/${base}`;
  let suffix = 2;
  while (used.has(candidate)) {
    const extension = path.extname(base);
    const stem = extension ? base.slice(0, -extension.length) : base;
    candidate = `attachments/${stem}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}
function makeAttachmentEntry(entryPath, bytes, mimeType) {
  return { path: entryPath, mediaType: mimeType || "application/octet-stream", bytes: bytes.length, sha256: sha256(bytes), encoding: "base64", content: bytes.toString("base64") };
}
function portableEntry(archive) {
  const entry = archive.entries?.find((item) => item?.path === "portable/session.json");
  if (!entry) throw new Error("Missing ccbridge entry: portable/session.json");
  return entry;
}
function updatePortableEntry(entry, session) {
  const bytes = Buffer.from(`${JSON.stringify(session, null, 2)}\n`, "utf8");
  entry.mediaType = "application/json";
  entry.bytes = bytes.length;
  entry.sha256 = sha256(bytes);
  entry.encoding = "utf8";
  entry.content = bytes.toString("utf8");
}
async function embedAttachments(archive) {
  if (archive.version !== CCBRIDGE_ARCHIVE_VERSION || !Array.isArray(archive.entries)) return { embedded: 0, warnings: [] };
  const pEntry = portableEntry(archive);
  const portable = JSON.parse(entryBytes(pEntry).toString("utf8"));
  const additions = [];
  const warnings = [];
  let embedded = 0;
  for (let messageIndex = 0; messageIndex < (portable.messages ?? []).length; messageIndex += 1) {
    const message = portable.messages[messageIndex];
    for (let partIndex = 0; partIndex < (message.content ?? []).length; partIndex += 1) {
      const part = message.content[partIndex];
      if (!isAttachmentPart(part) || part.archiveEntry) continue;
      let bytes;
      try { bytes = await bytesForAttachment(part); }
      catch (error) {
        warnings.push({ messageIndex, partIndex, name: part?.name ?? part?.filename ?? null, path: part?.path ?? null, error: error?.code ?? error?.message ?? "unreadable" });
        continue;
      }
      if (!bytes) {
        warnings.push({ messageIndex, partIndex, name: part?.name ?? part?.filename ?? null, path: part?.path ?? null, error: "no-local-bytes" });
        continue;
      }
      const filename = attachmentName(part, messageIndex, partIndex);
      const entryPath = uniqueEntryPath([...archive.entries, ...additions], filename, messageIndex, partIndex);
      const entry = makeAttachmentEntry(entryPath, bytes, part?.mimeType ?? part?.mime);
      additions.push(entry);
      part.archiveEntry = entryPath;
      part.size = entry.bytes;
      part.sha256 = entry.sha256;
      delete part.data;
      delete part.encoding;
      embedded += 1;
    }
  }
  updatePortableEntry(pEntry, portable);
  archive.entries.push(...additions);
  archive.manifest.entries = archive.entries.map(descriptor);
  archive.manifest.attachments = { embedded, skipped: warnings.length, warnings };
  validateBaseArchive(archive);
  return { embedded, warnings };
}
function rehydrateAttachments(archive) {
  const entryMap = new Map((archive.entries ?? []).map((entry) => [entry.path, entry]));
  for (const message of archive.session?.messages ?? []) {
    for (const part of message.content ?? []) {
      if (!isAttachmentPart(part) || !part.archiveEntry) continue;
      const entry = entryMap.get(part.archiveEntry);
      if (!entry) throw new Error(`Missing attachment entry: ${part.archiveEntry}`);
      const bytes = entryBytes(entry);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`ccbridge attachment integrity mismatch: ${part.archiveEntry}`);
      part.size = entry.bytes;
      part.sha256 = entry.sha256;
      part.data = entry.content;
      part.encoding = entry.encoding;
    }
  }
  return archive;
}

export function validateCcbridgeArchive(archive) { return rehydrateAttachments(validateBaseArchive(archive)); }
export async function readCcbridgeArchive(input) { return rehydrateAttachments(await readBaseArchive(input)); }
export async function writeCcbridgeArchive(session, options = {}) {
  const written = await writeBaseArchive(session, options);
  const archivePath = written.path;
  const raw = JSON.parse(await fs.readFile(archivePath, "utf8"));
  const attachments = await embedAttachments(raw);
  const temporary = `${archivePath}.${process.pid}.${Date.now()}.attachments.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, archivePath);
  try { await fs.chmod(archivePath, 0o600); } catch {}
  return { ...written, entryCount: raw.entries?.length ?? written.entryCount, embeddedAttachmentCount: attachments.embedded, skippedAttachmentCount: attachments.warnings.length };
}
export async function materializeCcbridgeAttachments(archiveInput, options = {}) {
  const archive = await readCcbridgeArchive(archiveInput);
  const session = structuredClone(archive.session);
  let root = options.directory ? path.resolve(options.directory) : null;
  let count = 0;
  const used = new Set();
  for (let messageIndex = 0; messageIndex < (session.messages ?? []).length; messageIndex += 1) {
    const message = session.messages[messageIndex];
    for (let partIndex = 0; partIndex < (message.content ?? []).length; partIndex += 1) {
      const part = message.content[partIndex];
      if (!isAttachmentPart(part) || !part.archiveEntry || typeof part.data !== "string") continue;
      if (!root) root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-attachments-"));
      else if (count === 0 && options.directory) await fs.mkdir(root, { recursive: true });
      const base = attachmentName(part, messageIndex, partIndex);
      let filename = base;
      let suffix = 2;
      while (used.has(filename)) {
        const extension = path.extname(base);
        const stem = extension ? base.slice(0, -extension.length) : base;
        filename = `${stem}-${suffix}${extension}`;
        suffix += 1;
      }
      used.add(filename);
      const filePath = path.join(root, filename);
      const bytes = Buffer.from(part.data, part.encoding === "base64" ? "base64" : "utf8");
      await fs.writeFile(filePath, bytes, { mode: 0o600 });
      part.path = filePath;
      count += 1;
    }
  }
  let cleaned = false;
  return {
    session,
    directory: root,
    count,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      if (root && !options.directory) await fs.rm(root, { recursive: true, force: true });
    }
  };
}
export async function writeLosslessBundle(session, options = {}) {
  if (!session?.lossless?.enabled) throw new Error("Lossless bundle requires a session read in lossless mode");
  return writeCcbridgeArchive(session, { ...options, mode: "lossless" });
}
