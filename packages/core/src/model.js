export const PORTABLE_SESSION_VERSION = 1;
export const TRANSFER_MODES = ["portable", "lossless"];

export function normalizeTransferMode(mode = "portable") {
  const normalized = String(mode ?? "portable").toLowerCase();
  if (!TRANSFER_MODES.includes(normalized)) {
    throw new Error(`Unsupported transfer mode: ${mode}. Expected one of: ${TRANSFER_MODES.join(", ")}`);
  }
  return normalized;
}

export function createPortableSession(input) {
  const session = {
    schemaVersion: PORTABLE_SESSION_VERSION,
    id: String(input.id ?? ""),
    title: input.title ?? null,
    cwd: input.cwd ?? null,
    startedAt: input.startedAt ?? null,
    updatedAt: input.updatedAt ?? null,
    source: {
      adapter: String(input.source?.adapter ?? "unknown"),
      sessionId: String(input.source?.sessionId ?? input.id ?? ""),
      path: input.source?.path ?? null
    },
    messages: Array.isArray(input.messages) ? input.messages : [],
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
    events: Array.isArray(input.events) ? input.events : [],
    lossless: input.lossless && typeof input.lossless === "object" ? input.lossless : null
  };

  validatePortableSession(session);
  return session;
}

export function validatePortableSession(session) {
  if (!session || typeof session !== "object") {
    throw new TypeError("Portable session must be an object");
  }
  if (session.schemaVersion !== PORTABLE_SESSION_VERSION) {
    throw new Error(`Unsupported portable session schema: ${session.schemaVersion}`);
  }
  if (!session.id) {
    throw new Error("Portable session id is required");
  }
  if (!session.source?.adapter) {
    throw new Error("Portable session source.adapter is required");
  }
  if (!Array.isArray(session.messages)) {
    throw new Error("Portable session messages must be an array");
  }
  if (!Array.isArray(session.events)) {
    throw new Error("Portable session events must be an array");
  }
  return session;
}

export function textContent(text) {
  return { type: "text", text: String(text) };
}

export function attachmentContent({ name = null, mimeType = "application/octet-stream", path = null, uri = null, data = null, encoding = null, size = null, sha256 = null, archiveEntry = null, metadata = null } = {}) {
  return {
    type: "attachment",
    name: name ?? null,
    mimeType: mimeType ?? "application/octet-stream",
    path: path ?? null,
    uri: uri ?? null,
    data: typeof data === "string" ? data : null,
    encoding: typeof data === "string" ? (encoding ?? "base64") : null,
    size: Number.isFinite(size) ? size : null,
    sha256: sha256 ?? null,
    archiveEntry: archiveEntry ?? null,
    metadata: metadata && typeof metadata === "object" ? metadata : {}
  };
}

export function reasoningContent({ provider, text = null, summary = null, signature = null, encrypted = null, raw = null }) {
  return {
    type: "reasoning",
    provider: provider ?? "unknown",
    text: typeof text === "string" ? text : null,
    summary: summary ?? null,
    signature: signature ?? null,
    encrypted: encrypted ?? null,
    raw: raw ?? null
  };
}

export function toolCallContent({ id, name, input }) {
  return {
    type: "tool-call",
    id: id ?? null,
    name: name ?? "unknown",
    input: input ?? null
  };
}

export function toolResultContent({ callId, output, isError = false }) {
  return {
    type: "tool-result",
    callId: callId ?? null,
    output: output ?? null,
    isError: Boolean(isError)
  };
}

export function rawEvent({ index, provider, kind, timestamp = null, data }) {
  return {
    index,
    provider: provider ?? "unknown",
    kind: kind ?? "unknown",
    timestamp,
    data
  };
}
