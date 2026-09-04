import { AdapterRegistry } from "./adapters/registry.js";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { registerAdapterModules } from "./adapters/loader.js";
import { SessionBridge } from "./bridge.js";

export { AdapterRegistry } from "./adapters/registry.js";
export { ClaudeCodeAdapter } from "./adapters/claude.js";
export { CodexAdapter } from "./adapters/codex.js";
export { SessionBridge } from "./bridge.js";
export {
  adapterAcceptsNativeArtifact,
  adapterCapabilities,
  nativeArtifactFormat,
  normalizeAdapterId,
  validateAdapter
} from "./adapters/contract.js";
export { loadAdapterModule, registerAdapterModule, registerAdapterModules } from "./adapters/loader.js";
export { CodexAppServerClient } from "./codex/app-server-client.js";
export { createPortableSession, validatePortableSession, PORTABLE_SESSION_VERSION } from "./model.js";
export {
  detectRuntime,
  defaultClaudeHome,
  defaultCodexHome,
  normalizePathKey,
  windowsPathToWsl,
  wslPathToWindows
} from "./platform/paths.js";

export function createDefaultRegistry(options = {}) {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter(options.claude));
  registry.register(new CodexAdapter(options.codex));
  return registry;
}

export function createDefaultBridge(options = {}) {
  return new SessionBridge(createDefaultRegistry(options));
}

export async function createBridgeWithPlugins(options = {}) {
  const registry = createDefaultRegistry(options);
  await registerAdapterModules(registry, options.plugins ?? [], options.pluginOptions ?? {});
  return new SessionBridge(registry);
}
