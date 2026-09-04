import { AdapterRegistry } from "./adapters/registry.js";
import { ClaudeCodeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { GeminiCliAdapter } from "./adapters/gemini.js";
import { OpenCodeAdapter } from "./adapters/opencode.js";
import { AntigravityCliAdapter } from "./adapters/antigravity.js";
import { registerAdapterModules } from "./adapters/loader.js";
import { SessionBridge } from "./bridge.js";
export { AdapterRegistry } from "./adapters/registry.js";
export { ClaudeCodeAdapter } from "./adapters/claude.js";
export { CodexAdapter } from "./adapters/codex.js";
export { GeminiCliAdapter } from "./adapters/gemini.js";
export { OpenCodeAdapter } from "./adapters/opencode.js";
export { AntigravityCliAdapter } from "./adapters/antigravity.js";
export { SessionBridge } from "./bridge.js";
export { analyzeSessionFeatures, evaluatePortableFidelity, nativeFidelityReport } from "./fidelity.js";
export { diffCcbridgeArchives, diffPortableSessions } from "./diff.js";
export { scanAdapter, scanRegistry } from "./scan.js";
export { verifyCcbridgeArchive, verifyPortableTransfer } from "./verify.js";
export { adapterAcceptsNativeArtifact, adapterCapabilities, nativeArtifactFormat, normalizeAdapterId, validateAdapter } from "./adapters/contract.js";
export { loadAdapterModule, registerAdapterModule, registerAdapterModules } from "./adapters/loader.js";
export { CodexAppServerClient } from "./codex/app-server-client.js";
export { attachmentContent, createPortableAgent, createPortableSession, normalizeTransferMode, rawEvent, reasoningContent, textContent, toolCallContent, toolResultContent, TRANSFER_MODES, validatePortableSession, PORTABLE_SESSION_VERSION } from "./model.js";
export { CCBRIDGE_ARCHIVE_FORMAT, CCBRIDGE_ARCHIVE_VERSION, defaultCcbridgeHome, LEGACY_LOSSLESS_BUNDLE_FORMAT, LOSSLESS_BUNDLE_FORMAT, LOSSLESS_BUNDLE_VERSION, materializeCcbridgeAttachments, materializeCcbridgeNative, readCcbridgeArchive, validateCcbridgeArchive, writeCcbridgeArchive, writeLosslessBundle } from "./lossless/archive.js";
export { extractProvenanceArchive, forkCcbridgeArchive, forkPortableSession, mergeCcbridgeArchives, mergePortableSessions } from "./session-ops.js";
export { detectRuntime, defaultClaudeHome, defaultCodexHome, defaultGeminiHome, defaultAntigravityCliHome, normalizePathKey, windowsPathToWsl, wslPathToWindows } from "./platform/paths.js";
export { TARGET_PROFILES, applyCwdMappings, normalizeCwdMappings, parseCwdMapping, resolveTargetCwd, resolveTargetCwdDetailed } from "./platform/cwd-map.js";
export function createDefaultRegistry(options = {}) { const registry = new AdapterRegistry(); registry.register(new ClaudeCodeAdapter(options.claude)); registry.register(new CodexAdapter(options.codex)); registry.register(new GeminiCliAdapter(options.gemini)); registry.register(new OpenCodeAdapter(options.opencode)); registry.register(new AntigravityCliAdapter(options.antigravity)); return registry; }
export function createDefaultBridge(options = {}) { return new SessionBridge(createDefaultRegistry(options)); }
export async function createBridgeWithPlugins(options = {}) { const registry = createDefaultRegistry(options); await registerAdapterModules(registry, options.plugins ?? [], options.pluginOptions ?? {}); return new SessionBridge(registry); }
