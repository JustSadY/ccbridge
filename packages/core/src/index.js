import { AdapterRegistry } from "./adapters/registry.js";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { SessionBridge } from "./bridge.js";

export { AdapterRegistry } from "./adapters/registry.js";
export { ClaudeCodeAdapter } from "./adapters/claude.js";
export { CodexAdapter } from "./adapters/codex.js";
export { SessionBridge } from "./bridge.js";
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

export function createDefaultBridge(options = {}) {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter(options.claude));
  registry.register(new CodexAdapter(options.codex));
  return new SessionBridge(registry);
}
