import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPortableSession } from "../src/model.js";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../src/lossless/archive.js";
import { sanitizeCcbridgeArchive, sanitizePortableSession } from "../src/privacy/sanitize.js";
import { decryptCcbridgeArchive, encryptCcbridgeArchive, readEncryptedCcbridgeArchive } from "../src/privacy/encryption.js";

function fixtureSession() {
  return createPortableSession({
    id: "privacy-1",
    title: "secret sk-ant-ABCDEFGHIJKLMNOPQRST",
    cwd: "/tmp/project",
    source: { adapter: "fixture", sessionId: "privacy-1", path: "/tmp/native.jsonl" },
    messages: [
      {
        id: "u1",
        role: "user",
        content: [
          { type: "text", text: "API_KEY=super-secret-value and github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" },
          { type: "attachment", name: "secret.txt", mimeType: "text/plain", data: Buffer.from("file-secret").toString("base64"), encoding: "base64", path: "/tmp/secret.txt", metadata: { apiKey: "meta-secret" } }
        ],
        metadata: { accessToken: "token-in-metadata" }
      }
    ],
    agents: [],
    metadata: { apiKey: "top-secret", env: { DATABASE_PASSWORD: "db-secret" } },
    events: [{ index: 0, provider: "fixture", kind: "tool", data: { path: "/tmp/a.txt", content: "file-content-secret", authorization: "Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456" } }],
    lossless: { enabled: true, sourceFormat: "fixture/json", includesUnknownEvents: true }
  });
}

test("sanitizePortableSession redacts credentials, env and file payloads", () => {
  const result = sanitizePortableSession(fixtureSession(), { redactSecrets: true, excludeEnv: true, excludeFiles: true });
  const text = JSON.stringify(result.session);
  assert.equal(text.includes("super-secret-value"), false);
  assert.equal(text.includes("top-secret"), false);
  assert.equal(text.includes("token-in-metadata"), false);
  assert.equal(text.includes("db-secret"), false);
  assert.equal(text.includes("file-secret"), false);
  assert.equal(text.includes("file-content-secret"), false);
  assert.equal(text.includes("github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), false);
  assert.equal(result.session.messages[0].content[1].data, null);
  assert.equal(result.session.messages[0].content[1].path, null);
  assert.equal(result.session.source.path, null);
  assert.ok(result.report.secretsRedacted >= 4);
  assert.ok(result.report.envValuesExcluded >= 1);
  assert.ok(result.report.attachmentPayloadsExcluded >= 1);
  assert.ok(result.report.filePayloadsExcluded >= 1);
});

test("sanitize refuses native-only sessions", () => {
  const session = createPortableSession({ id: "native-only", source: { adapter: "antigravity", sessionId: "native-only" }, messages: [], agents: [], metadata: { nativeOnly: true }, events: [], lossless: { enabled: true, nativeOnly: true } });
  assert.throws(() => sanitizePortableSession(session, { redactSecrets: true }), /native-only/);
});

test("sanitize archive omits embedded native artifact and secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-privacy-"));
  const source = path.join(root, "source.ccbridge");
  const clean = path.join(root, "clean.ccbridge");
  await writeCcbridgeArchive(fixtureSession(), {
    destination: source,
    nativeArtifact: { kind: "agent-session", format: "fixture/native", filename: "native.bin", content: "native-secret sk-ant-ZYXWVUTSRQPONMLKJIHG", encoding: "utf8", sessionId: "privacy-1" }
  });
  const result = await sanitizeCcbridgeArchive(source, { destination: clean, redactSecrets: true, excludeEnv: true, excludeFiles: true });
  assert.equal(result.nativeArtifactOmitted, true);
  const raw = await fs.readFile(clean, "utf8");
  assert.equal(raw.includes("native-secret"), false);
  assert.equal(raw.includes("super-secret-value"), false);
  const loaded = await readCcbridgeArchive(clean);
  assert.equal(loaded.nativeArtifact, null);
});

test("encrypted archives hide plaintext and round-trip through AES-GCM", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-encryption-"));
  const source = path.join(root, "source.ccbridge");
  const encrypted = path.join(root, "source.ccbridge.enc");
  const decrypted = path.join(root, "recovered.ccbridge");
  const session = createPortableSession({ id: "enc-1", source: { adapter: "fixture", sessionId: "enc-1" }, messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "very-private-message" }], metadata: {} }], agents: [], metadata: {}, events: [], lossless: null });
  await writeCcbridgeArchive(session, { destination: source });
  const passphrase = "correct horse battery staple";
  await encryptCcbridgeArchive(source, { destination: encrypted, passphrase });
  const encryptedText = await fs.readFile(encrypted, "utf8");
  assert.equal(encryptedText.includes("very-private-message"), false);
  const decoded = await readEncryptedCcbridgeArchive(encrypted, { passphrase });
  assert.equal(decoded.archive.session.messages[0].content[0].text, "very-private-message");
  await assert.rejects(readEncryptedCcbridgeArchive(encrypted, { passphrase: "wrong-passphrase" }), /invalid passphrase|corrupted data/);
  await decryptCcbridgeArchive(encrypted, { destination: decrypted, passphrase });
  const restored = await readCcbridgeArchive(decrypted);
  assert.equal(restored.session.id, "enc-1");
});
