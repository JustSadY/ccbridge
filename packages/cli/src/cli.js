#!/usr/bin/env node
import fs from "node:fs/promises";
import {
  addConfiguredPlugin,
  configuredPluginSpecifiers,
  createBridgeWithPlugins,
  createDefaultRegistry,
  decryptCcbridgeArchive,
  detectRuntime,
  defaultClaudeHome,
  defaultCodexHome,
  defaultGeminiHome,
  defaultAntigravityCliHome,
  diffCcbridgeArchives,
  encryptCcbridgeArchive,
  extractProvenanceArchive,
  forkCcbridgeArchive,
  listConfiguredPlugins,
  mergeCcbridgeArchives,
  readCcbridgeArchive,
  registerAdapterModule,
  removeConfiguredPlugin,
  sanitizeCcbridgeArchive,
  setConfiguredPluginEnabled,
  verifyCcbridgeArchive,
  verifyPortableTransfer
} from "@ccbridge/core";
import { runInteractive } from "./interactive.js";
const rawArgs = process.argv.slice(2);
function repeatedValues(argv, name) { const values = []; for (let i = 0; i < argv.length; i += 1) { if (argv[i] === name && argv[i + 1]) { values.push(argv[i + 1]); i += 1; } } return values; }
function withoutOptionPairs(argv, names) { const output = []; for (let i = 0; i < argv.length; i += 1) { if (names.includes(argv[i])) { i += 1; continue; } output.push(argv[i]); } return output; }
const strippedArgs = withoutOptionPairs(rawArgs, ["--plugin"]);
const initialCommand = strippedArgs[0] ?? "help";
const envPlugins = String(process.env.CCBRIDGE_PLUGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const explicitPlugins = repeatedValues(rawArgs, "--plugin");
const persistentPlugins = initialCommand === "plugins" ? [] : await configuredPluginSpecifiers();
const plugins = [...new Set([...persistentPlugins, ...envPlugins, ...explicitPlugins])];
const bridge = await createBridgeWithPlugins({ plugins });
const args = strippedArgs;
const command = args.shift() ?? "help";
function valueOf(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; } function has(name) { return args.includes(name); }
function positional() { const values = []; const booleanOptions = ["--json", "--dry-run", "--all", "--strict-lossless", "--deep", "--include-raw", "--sessions", "--redact-secrets", "--exclude-env", "--exclude-files"]; for (let i = 0; i < args.length; i += 1) { if (args[i].startsWith("--")) { if (!booleanOptions.includes(args[i])) i += 1; continue; } values.push(args[i]); } return values; }
function print(value) { if (has("--json")) console.log(JSON.stringify(value, null, 2)); else if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2)); }
function printRoutes(matrix) {
  if (has("--json")) { console.log(JSON.stringify(matrix, null, 2)); return; }
  for (const row of matrix.rows) {
    const detail = row.route === "native" ? `native [${row.nativeFormats.join(", ")}]` : row.route;
    const strict = row.lossless.strict === "native-for-listed-formats" ? `strict:${row.lossless.strictNativeFormats.join(",")}` : `strict:${row.lossless.strict}`;
    console.log(`${row.from} -> ${row.to}: ${detail}; --all=${row.lossless.route}; ${strict}`);
  }
}
function requestedMode(defaultMode = "portable") { return has("--all") || has("--strict-lossless") ? "lossless" : valueOf("--mode") ?? defaultMode; }
function cwdRouteOptions() { return { cwd: valueOf("--cwd"), cwdMappings: repeatedValues(args, "--map-cwd"), targetProfile: valueOf("--target-profile") ?? "native" }; }
function privacyOptions() { return { redactSecrets: has("--redact-secrets"), excludeEnv: has("--exclude-env"), excludeFiles: has("--exclude-files") }; }
function numericValue(name, fallback) { const raw = valueOf(name); if (raw === null) return fallback; const parsed = Number(raw); if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive number`); return Math.floor(parsed); }
async function encryptionPassphrase() { const file = valueOf("--passphrase-file"); if (file) { const value = await fs.readFile(file, "utf8"); return value.replace(/[\r\n]+$/, ""); } const value = process.env.CCBRIDGE_PASSPHRASE; if (value) return value; throw new Error("Set CCBRIDGE_PASSPHRASE or use --passphrase-file; plaintext --passphrase arguments are intentionally unsupported"); }
function requireOutput(label) { const output = valueOf("--output"); if (!output) throw new Error(`${label} requires --output PATH`); return output; }
async function validatePluginSpecifier(specifier) { const registry = createDefaultRegistry(); const adapters = await registerAdapterModule(registry, specifier); return adapters.map((adapter) => ({ id: adapter.id, name: adapter.name, aliases: adapter.aliases ?? [] })); }
function usage() { console.log(`ccbridge - local coding-agent session bridge\n\nUsage:\n  ccbridge ui\n  ccbridge scan [adapter ...] [--sessions] [--limit N]\n  ccbridge routes [from-adapter] [to-adapter] [--json]\n  ccbridge plugins list\n  ccbridge plugins add <module>\n  ccbridge plugins remove <module>\n  ccbridge plugins enable <module>\n  ccbridge plugins disable <module>\n  ccbridge fidelity <from> <to> <session> [--all]\n  ccbridge transfer <from> <to> <session> [--all] [--strict-lossless] [--dry-run]\n  ccbridge export <adapter> <session> [--output PATH] [--all]\n  ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH] [--dry-run]\n  ccbridge sanitize <archive.ccbridge> --output clean.ccbridge [--redact-secrets] [--exclude-env] [--exclude-files]\n  ccbridge encrypt <archive.ccbridge> --output archive.ccbridge.enc [--passphrase-file PATH]\n  ccbridge decrypt <archive.ccbridge.enc> --output archive.ccbridge [--passphrase-file PATH]\n  ccbridge fork <archive.ccbridge> [--output PATH] [--id ID] [--title TITLE]\n  ccbridge merge <left.ccbridge> <right.ccbridge> [--output PATH] [--id ID] [--title TITLE] [--cwd PATH]\n  ccbridge diff <left.ccbridge> <right.ccbridge> [--limit N]\n  ccbridge verify <archive.ccbridge> [--deep]\n  ccbridge verify-transfer <source.ccbridge> <target-adapter> <target-session> [--all] [--include-raw] [--limit N]\n  ccbridge extract-provenance <archive.ccbridge> <entry> [--output PATH]\n\nRoutes:\n  routes is static: it does not read session contents or mutate a target. Native routes are based on declared source/target formats.\n  strict:session-dependent means the portable route exists, but 100% strict fidelity depends on the actual session features.\n\nPlugins:\n  persistent plugins are stored under CCBRIDGE_HOME/plugins.json and loaded automatically by normal commands.\n  add/enable validates the module against the built-in registry before persisting it.\n  plugin management never runs npm/pnpm automatically; install packages yourself. Plugins are executable code, so only add modules you trust.\n  --plugin and CCBRIDGE_PLUGINS remain available for one-off loading.\n\nPrivacy:\n  sanitize never overwrites its source and drops embedded native/provenance payloads because arbitrary private formats cannot be safely redacted.\n  native-only sessions are rejected by sanitize rather than producing a misleading empty archive.\n  encrypt uses AES-256-GCM with a scrypt-derived key. Passphrases come only from CCBRIDGE_PASSPHRASE or --passphrase-file.\n\nInteractive:\n  ui scans local sessions, lets you choose source/session/target/mode, prints the route plan, then requires explicit confirmation before mutation.\n  lossless is presented first so raw/thinking data is preserved in the side archive by default.\n\nExamples:\n  ccbridge plugins add @example/ccbridge-cursor\n  ccbridge plugins list\n  ccbridge ui\n  ccbridge scan --sessions --limit 10\n  ccbridge routes claude codex\n  ccbridge routes pi goose --json\n  ccbridge sanitize session.ccbridge --output share.ccbridge --redact-secrets --exclude-env --exclude-files\n  CCBRIDGE_PASSPHRASE='use-a-long-secret' ccbridge encrypt share.ccbridge --output share.ccbridge.enc\n`); }
function transferArgs() { const [from, to, session] = positional(); if (!from || !to || !session) throw new Error("Usage: ccbridge <command> <from> <to> <session> [--cwd PATH]"); return { from, to, session, ...cwdRouteOptions(), mode: requestedMode(), bundle: valueOf("--bundle") }; }
try {
  if (command === "help" || command === "--help" || command === "-h") usage();
  else if (command === "plugins") {
    const [action = "list", specifier] = positional();
    if (action === "list") print(await listConfiguredPlugins());
    else if (action === "add") { if (!specifier) throw new Error("Usage: ccbridge plugins add <module>"); const adapters = await validatePluginSpecifier(specifier); print({ ...(await addConfiguredPlugin(specifier)), adapters }); }
    else if (action === "remove") { if (!specifier) throw new Error("Usage: ccbridge plugins remove <module>"); print(await removeConfiguredPlugin(specifier)); }
    else if (action === "enable") { if (!specifier) throw new Error("Usage: ccbridge plugins enable <module>"); const adapters = await validatePluginSpecifier(specifier); print({ ...(await setConfiguredPluginEnabled(specifier, true)), adapters }); }
    else if (action === "disable") { if (!specifier) throw new Error("Usage: ccbridge plugins disable <module>"); print(await setConfiguredPluginEnabled(specifier, false)); }
    else throw new Error(`Unknown plugins action: ${action}`);
  }
  else if (command === "adapters") print(bridge.listAdapters());
  else if (command === "routes") { const [from, to] = positional(); printRoutes(bridge.routes({ from: from ?? null, to: to ?? null })); }
  else if (command === "ui" || command === "interactive") await runInteractive(bridge);
  else if (command === "scan") print(await bridge.scan({ adapterIds: positional(), includeSessions: has("--sessions"), limit: numericValue("--limit", 20) }));
  else if (command === "doctor") print({ runtime: detectRuntime(), plugins: { persistent: persistentPlugins, environment: envPlugins, explicit: explicitPlugins, loaded: plugins }, homes: { claude: defaultClaudeHome(), codex: defaultCodexHome(), gemini: defaultGeminiHome(), antigravity: defaultAntigravityCliHome() }, adapters: await bridge.doctor() });
  else if (command === "list" || command === "sessions") { const [adapter] = positional(); if (!adapter) throw new Error("Usage: ccbridge list <adapter>"); print(await bridge.listSessions(adapter)); }
  else if (command === "inspect" || command === "show") { const [adapter, session] = positional(); if (!adapter || !session) throw new Error("Usage: ccbridge inspect <adapter> <session>"); print(await bridge.inspect(adapter, session, { mode: requestedMode() })); }
  else if (command === "fidelity") print(await bridge.fidelity(transferArgs()));
  else if (command === "export") { const [from, session] = positional(); if (!from || !session) throw new Error("Usage: ccbridge export <adapter> <session> [--output PATH]"); print(await bridge.exportSession({ from, session, destination: valueOf("--output"), mode: requestedMode("lossless") })); }
  else if (command === "import") { const [archive, to] = positional(); if (!archive || !to) throw new Error("Usage: ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH]"); print(await bridge.importArchive({ archive, to, ...cwdRouteOptions(), dryRun: has("--dry-run") })); }
  else if (command === "sanitize") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge sanitize <archive.ccbridge> --output PATH [privacy flags]"); print(await sanitizeCcbridgeArchive(archive, { destination: requireOutput("sanitize"), ...privacyOptions() })); }
  else if (command === "encrypt") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge encrypt <archive.ccbridge> --output PATH"); print(await encryptCcbridgeArchive(archive, { destination: requireOutput("encrypt"), passphrase: await encryptionPassphrase() })); }
  else if (command === "decrypt") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge decrypt <archive.ccbridge.enc> --output PATH"); print(await decryptCcbridgeArchive(archive, { destination: requireOutput("decrypt"), passphrase: await encryptionPassphrase() })); }
  else if (command === "fork") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge fork <archive.ccbridge> [--output PATH]"); print(await forkCcbridgeArchive(archive, { destination: valueOf("--output"), id: valueOf("--id"), title: valueOf("--title") })); }
  else if (command === "merge") { const [left, right] = positional(); if (!left || !right) throw new Error("Usage: ccbridge merge <left.ccbridge> <right.ccbridge> [--output PATH]"); print(await mergeCcbridgeArchives(left, right, { destination: valueOf("--output"), id: valueOf("--id"), title: valueOf("--title"), cwd: valueOf("--cwd") })); }
  else if (command === "diff") { const [left, right] = positional(); if (!left || !right) throw new Error("Usage: ccbridge diff <left.ccbridge> <right.ccbridge> [--limit N]"); print(await diffCcbridgeArchives(left, right, { limit: numericValue("--limit", 20) })); }
  else if (command === "verify") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge verify <archive.ccbridge> [--deep]"); const result = await verifyCcbridgeArchive(archive, { deep: has("--deep") }); print(result); if (!result.valid) process.exitCode = 2; }
  else if (command === "verify-transfer") { const [archive, targetAdapter, targetSession] = positional(); if (!archive || !targetAdapter || !targetSession) throw new Error("Usage: ccbridge verify-transfer <source.ccbridge> <target-adapter> <target-session>"); const source = await readCcbridgeArchive(archive); const target = await bridge.inspect(targetAdapter, targetSession, { mode: requestedMode() }); const result = verifyPortableTransfer(source.session, target, { includeRaw: has("--include-raw"), limit: numericValue("--limit", 20) }); print(result); if (!result.complete) process.exitCode = 3; }
  else if (command === "extract-provenance") { const [archive, entry] = positional(); if (!archive || !entry) throw new Error("Usage: ccbridge extract-provenance <archive.ccbridge> <entry> [--output PATH]"); print(await extractProvenanceArchive(archive, entry, valueOf("--output"))); }
  else if (command === "plan") print(await bridge.planTransfer(transferArgs()));
  else if (command === "transfer") print(await bridge.transfer({ ...transferArgs(), dryRun: has("--dry-run"), strictLossless: has("--strict-lossless") }));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`ccbridge: ${error.message}`); process.exitCode = 1; }
