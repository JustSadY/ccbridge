const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeAdapterId(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function adapterCapabilities(adapter) {
  return {
    discover: typeof adapter?.listSessions === "function",
    read: typeof adapter?.readSession === "function",
    write: typeof adapter?.writePortableSession === "function",
    nativeExport: typeof adapter?.getNativeArtifact === "function",
    nativeImport: typeof adapter?.importNativeArtifact === "function"
  };
}

export function validateAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("Adapter must be an object");
  }

  const id = normalizeAdapterId(adapter.id);
  if (!id || !ADAPTER_ID_PATTERN.test(id)) {
    throw new Error(`Invalid adapter id: ${adapter.id ?? "<missing>"}`);
  }
  if (!String(adapter.name ?? "").trim()) {
    throw new Error(`Adapter ${id} must have a name`);
  }

  const aliases = [...new Set((adapter.aliases ?? []).map(normalizeAdapterId).filter(Boolean))];
  if (aliases.some((alias) => !ADAPTER_ID_PATTERN.test(alias))) {
    throw new Error(`Adapter ${id} has an invalid alias`);
  }
  if (aliases.includes(id)) {
    throw new Error(`Adapter ${id} must not repeat its id as an alias`);
  }

  const derived = adapterCapabilities(adapter);
  const declared = adapter.capabilities ?? {};
  for (const [capability, implemented] of Object.entries(derived)) {
    if (declared[capability] === true && !implemented) {
      throw new Error(`Adapter ${id} declares ${capability} but does not implement it`);
    }
  }

  return {
    id,
    name: String(adapter.name),
    aliases,
    capabilities: { ...derived, ...declared }
  };
}

export function nativeArtifactFormat(artifact) {
  return String(artifact?.format ?? artifact?.kind ?? "").trim();
}

export async function adapterAcceptsNativeArtifact(adapter, artifact) {
  if (typeof adapter?.acceptsNativeArtifact === "function") {
    return Boolean(await adapter.acceptsNativeArtifact(artifact));
  }

  const format = nativeArtifactFormat(artifact);
  const accepted = adapter?.nativeImports ?? adapter?.nativeFormats ?? [];
  return Boolean(format && Array.isArray(accepted) && (accepted.includes(format) || accepted.includes("*")));
}
