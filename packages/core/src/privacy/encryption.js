import fs from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from "node:crypto";
import { promisify } from "node:util";
import { readCcbridgeArchive } from "../lossless/archive.js";

const scrypt = promisify(scryptCallback);
export const CCBRIDGE_ENCRYPTED_FORMAT = "ccbridge/encrypted";
export const CCBRIDGE_ENCRYPTED_VERSION = 1;
const CIPHER = "aes-256-gcm";
const AAD = Buffer.from(`${CCBRIDGE_ENCRYPTED_FORMAT}:v${CCBRIDGE_ENCRYPTED_VERSION}`, "utf8");
const DEFAULT_KDF = { name: "scrypt", N: 16384, r: 8, p: 1, keyLength: 32 };

function assertPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("ccbridge encryption passphrase must be at least 8 characters");
  return passphrase;
}

async function deriveKey(passphrase, salt, kdf = DEFAULT_KDF) {
  if (kdf?.name !== "scrypt") throw new Error(`Unsupported ccbridge KDF: ${kdf?.name ?? "unknown"}`);
  const keyLength = Number(kdf.keyLength ?? 32);
  return scrypt(assertPassphrase(passphrase), salt, keyLength, {
    N: Number(kdf.N ?? DEFAULT_KDF.N),
    r: Number(kdf.r ?? DEFAULT_KDF.r),
    p: Number(kdf.p ?? DEFAULT_KDF.p),
    maxmem: 64 * 1024 * 1024
  });
}

export async function encryptCcbridgeBytes(bytes, passphrase, options = {}) {
  const plaintext = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kdf = { ...DEFAULT_KDF, ...(options.kdf ?? {}) };
  const key = await deriveKey(passphrase, salt, kdf);
  const cipher = createCipheriv(CIPHER, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: CCBRIDGE_ENCRYPTED_FORMAT,
    version: CCBRIDGE_ENCRYPTED_VERSION,
    createdAt: new Date().toISOString(),
    cipher: CIPHER,
    kdf,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

export async function decryptCcbridgeEnvelope(envelope, passphrase) {
  if (!envelope || typeof envelope !== "object") throw new Error("Invalid encrypted ccbridge envelope");
  if (envelope.format !== CCBRIDGE_ENCRYPTED_FORMAT || envelope.version !== CCBRIDGE_ENCRYPTED_VERSION) throw new Error(`Unsupported encrypted ccbridge format/version: ${envelope.format ?? "unknown"} v${envelope.version ?? "unknown"}`);
  if (envelope.cipher !== CIPHER) throw new Error(`Unsupported ccbridge cipher: ${envelope.cipher ?? "unknown"}`);
  try {
    const salt = Buffer.from(String(envelope.salt ?? ""), "base64");
    const iv = Buffer.from(String(envelope.iv ?? ""), "base64");
    const tag = Buffer.from(String(envelope.tag ?? ""), "base64");
    const ciphertext = Buffer.from(String(envelope.ciphertext ?? ""), "base64");
    if (salt.length < 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid encrypted fields");
    const key = await deriveKey(passphrase, salt, envelope.kdf);
    const decipher = createDecipheriv(CIPHER, key, iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    if (/Unsupported|passphrase must/.test(error.message)) throw error;
    throw new Error("Unable to decrypt ccbridge archive: invalid passphrase or corrupted data");
  }
}

async function validatedPlaintextBytes(input) {
  if (typeof input === "string") {
    const archivePath = path.resolve(input);
    await readCcbridgeArchive(archivePath);
    return { bytes: await fs.readFile(archivePath), sourcePath: archivePath };
  }
  const archive = await readCcbridgeArchive(input);
  return { bytes: Buffer.from(`${JSON.stringify(archive, null, 2)}\n`, "utf8"), sourcePath: null };
}

export async function encryptCcbridgeArchive(input, options = {}) {
  const destination = options.destination ? path.resolve(options.destination) : null;
  if (!destination) throw new Error("encrypt requires an explicit destination");
  const plain = await validatedPlaintextBytes(input);
  if (plain.sourcePath && plain.sourcePath === destination) throw new Error("encrypt destination must differ from the source archive");
  const envelope = await encryptCcbridgeBytes(plain.bytes, options.passphrase, options);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
  try { await fs.chmod(destination, 0o600); } catch {}
  return { path: destination, format: envelope.format, version: envelope.version, cipher: envelope.cipher, plaintextBytes: plain.bytes.length, ciphertextBytes: Buffer.from(envelope.ciphertext, "base64").length };
}

export async function readEncryptedCcbridgeArchive(input, options = {}) {
  const envelope = typeof input === "string" ? JSON.parse(await fs.readFile(path.resolve(input), "utf8")) : input;
  const plaintext = await decryptCcbridgeEnvelope(envelope, options.passphrase);
  let parsed;
  try { parsed = JSON.parse(plaintext.toString("utf8")); }
  catch { throw new Error("Decrypted payload is not a valid ccbridge JSON archive"); }
  const archive = await readCcbridgeArchive(parsed);
  return { archive, plaintext };
}

export async function decryptCcbridgeArchive(input, options = {}) {
  const destination = options.destination ? path.resolve(options.destination) : null;
  if (!destination) throw new Error("decrypt requires an explicit destination");
  if (typeof input === "string" && path.resolve(input) === destination) throw new Error("decrypt destination must differ from the encrypted source");
  const decoded = await readEncryptedCcbridgeArchive(input, options);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, decoded.plaintext, { mode: 0o600 });
  await fs.rename(temporary, destination);
  try { await fs.chmod(destination, 0o600); } catch {}
  return { path: destination, format: decoded.archive.format, version: decoded.archive.version, bytes: decoded.plaintext.length, sessionId: decoded.archive.session?.id ?? null };
}
