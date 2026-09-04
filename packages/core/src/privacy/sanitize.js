import path from "node:path";
import { readCcbridgeArchive, writeCcbridgeArchive } from "../lossless/archive.js";

const REDACTED = "[REDACTED]";
const EXCLUDED_ENV = "[ENV EXCLUDED]";
const EXCLUDED_FILE = "[FILE PAYLOAD EXCLUDED]";
const SECRET_FIELDS = new Set(["apikey", "accesstoken", "authtoken", "bearer", "clientsecret", "password", "passwd", "privatekey", "refreshtoken", "sessiontoken", "secret"]);
const ENV_KEY = /^(?:env|environment|processenv|process_env|environmentvariables|environment_variables)$/i;
const FILE_PATH_KEY = /^(?:path|file_path|filepath|filename|file|uri)$/i;
const FILE_PAYLOAD_KEY = /^(?:content|contents|file_content|filecontent|data|bytes|body)$/i;
const SECRET_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}\b/gi,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g
];

function isSecretKey(key) {
  const normalized = String(key ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SECRET_FIELDS.has(normalized)) return true;
  return normalized.endsWith("password") || normalized.endsWith("passwd") || normalized.endsWith("secret") || normalized.endsWith("apikey") || normalized.endsWith("accesstoken") || normalized.endsWith("authtoken") || normalized.endsWith("refreshtoken") || normalized.endsWith("sessiontoken") || normalized.endsWith("privatekey");
}

function replaceSecrets(value, report) {
  let output = String(value);
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => { report.secretsRedacted += 1; return REDACTED; });
  }
  output = output.replace(/([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY)[A-Za-z0-9_]*)\s*=\s*([^\s\r\n]+)/gi, (_full, key) => {
    report.secretsRedacted += 1;
    return `${key}=${REDACTED}`;
  });
  output = output.replace(/:\/\/([^\s/:@]+):([^\s/@]+)@/g, (_full, user) => {
    report.secretsRedacted += 1;
    return `://${user}:${REDACTED}@`;
  });
  return output;
}

function attachmentPart(part) {
  return ["attachment", "file", "image", "document", "audio", "video"].includes(part?.type);
}

function sanitizeAttachment(part, options, report) {
  const copy = { ...part, metadata: part?.metadata && typeof part.metadata === "object" ? { ...part.metadata } : {} };
  if (options.excludeFiles) {
    if (copy.data !== null && copy.data !== undefined || copy.path || copy.archiveEntry) report.attachmentPayloadsExcluded += 1;
    copy.data = null;
    copy.encoding = null;
    copy.path = null;
    copy.archiveEntry = null;
    copy.sha256 = null;
    copy.size = null;
    copy.metadata.ccbridgeFilePayloadExcluded = true;
  }
  if (options.redactSecrets) {
    for (const key of ["name", "uri"]) if (typeof copy[key] === "string") copy[key] = replaceSecrets(copy[key], report);
    copy.metadata = sanitizeValue(copy.metadata, options, report, "metadata");
  }
  return copy;
}

function looksLikeFileContainer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.some((key) => FILE_PATH_KEY.test(key));
}

function sanitizeObject(value, options, report) {
  const output = {};
  const fileContainer = options.excludeFiles && looksLikeFileContainer(value);
  for (const [key, raw] of Object.entries(value)) {
    if (options.excludeEnv && ENV_KEY.test(key)) {
      output[key] = EXCLUDED_ENV;
      report.envValuesExcluded += 1;
      continue;
    }
    if (options.redactSecrets && isSecretKey(key) && raw !== null && raw !== undefined) {
      output[key] = REDACTED;
      report.secretsRedacted += 1;
      continue;
    }
    if (fileContainer && FILE_PAYLOAD_KEY.test(key) && raw !== null && raw !== undefined) {
      output[key] = EXCLUDED_FILE;
      report.filePayloadsExcluded += 1;
      continue;
    }
    output[key] = sanitizeValue(raw, options, report, key);
  }
  return output;
}

function sanitizeValue(value, options, report, key = null) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return options.redactSecrets ? replaceSecrets(value, report) : value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, options, report, key));
  if (typeof value === "object") return sanitizeObject(value, options, report);
  return value;
}

export function sanitizePortableSession(session, options = {}) {
  const normalized = {
    redactSecrets: options.redactSecrets === true,
    excludeEnv: options.excludeEnv === true,
    excludeFiles: options.excludeFiles === true
  };
  if (!normalized.redactSecrets && !normalized.excludeEnv && !normalized.excludeFiles) throw new Error("At least one privacy transform is required");
  if (session?.lossless?.nativeOnly || session?.metadata?.nativeOnly) throw new Error("Cannot safely sanitize a native-only session without a semantic decoder");

  const report = {
    secretsRedacted: 0,
    envValuesExcluded: 0,
    filePayloadsExcluded: 0,
    attachmentPayloadsExcluded: 0
  };
  const copy = structuredClone(session);
  copy.messages = (copy.messages ?? []).map((message) => ({
    ...message,
    content: (message.content ?? []).map((part) => attachmentPart(part) ? sanitizeAttachment(part, normalized, report) : sanitizeValue(part, normalized, report)),
    metadata: sanitizeValue(message.metadata ?? {}, normalized, report)
  }));
  copy.agents = (copy.agents ?? []).map((agent) => ({
    ...agent,
    messages: (agent.messages ?? []).map((message) => ({
      ...message,
      content: (message.content ?? []).map((part) => attachmentPart(part) ? sanitizeAttachment(part, normalized, report) : sanitizeValue(part, normalized, report)),
      metadata: sanitizeValue(message.metadata ?? {}, normalized, report)
    })),
    events: sanitizeValue(agent.events ?? [], normalized, report),
    metadata: sanitizeValue(agent.metadata ?? {}, normalized, report)
  }));
  copy.events = sanitizeValue(copy.events ?? [], normalized, report);
  copy.metadata = sanitizeValue(copy.metadata ?? {}, normalized, report);
  copy.lossless = copy.lossless ? {
    ...sanitizeValue(copy.lossless, normalized, report),
    privacyTransformed: true,
    originalNativePayloadOmitted: true
  } : null;
  copy.source = { ...copy.source, path: normalized.excludeFiles ? null : copy.source?.path ?? null };
  if (typeof copy.title === "string" && normalized.redactSecrets) copy.title = replaceSecrets(copy.title, report);
  if (typeof copy.cwd === "string" && normalized.redactSecrets) copy.cwd = replaceSecrets(copy.cwd, report);
  return { session: copy, options: normalized, report };
}

export async function sanitizeCcbridgeArchive(input, options = {}) {
  const loaded = await readCcbridgeArchive(input);
  const transformed = sanitizePortableSession(loaded.session, options);
  const sourceProvenanceEntries = (loaded.entries ?? []).filter((entry) => entry.path.startsWith("provenance/sources/")).length;
  const nativeArtifactOmitted = Boolean(loaded.nativeArtifact);
  const destination = options.destination ? path.resolve(options.destination) : null;
  if (!destination) throw new Error("sanitize requires an explicit destination so the source archive is never overwritten");
  if (loaded.archivePath && path.resolve(loaded.archivePath) === destination) throw new Error("sanitize destination must differ from the source archive");
  const written = await writeCcbridgeArchive(transformed.session, {
    destination,
    from: "ccbridge-sanitized",
    mode: transformed.session.lossless?.enabled ? "lossless" : "portable",
    nativeArtifact: null,
    metadata: {
      operation: "sanitize",
      privacy: transformed.options,
      report: transformed.report,
      nativeArtifactOmitted,
      provenanceEntriesOmitted: sourceProvenanceEntries,
      source: loaded.source ?? null
    }
  });
  return {
    ...written,
    operation: "sanitize",
    privacy: transformed.options,
    report: transformed.report,
    nativeArtifactOmitted,
    provenanceEntriesOmitted: sourceProvenanceEntries
  };
}

export const PRIVACY_REDACTION_MARKERS = { REDACTED, EXCLUDED_ENV, EXCLUDED_FILE };
