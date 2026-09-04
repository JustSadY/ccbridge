export const PORTABLE_SESSION_VERSION = 1;

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
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {}
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
  return session;
}

export function textContent(text) {
  return { type: "text", text: String(text) };
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
