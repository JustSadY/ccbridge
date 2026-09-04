#!/usr/bin/env node
import {
  createBridgeWithPlugins,
  detectRuntime,
  defaultClaudeHome,
  defaultCodexHome,
  defaultGeminiHome,
  defaultAntigravityCliHome,
  diffCcbridgeArchives,
  extractProvenanceArchive,
  forkCcbridgeArchive,
  mergeCcbridgeArchives
} from "@ccbridge/core";
const rawArgs = process.argv.slice(2);
function repeatedValues(argv, name) { const values = []; for (let i = 0; i < argv.length; i += 1) { if (argv[i] === name && argv[i + 1]) { values.push(argv[i + 1]); i += 1; } } return values; }
function withoutOptionPairs(argv, names) { const output = []; for (let i = 0; i < argv.length; i += 1) { if (names.includes(argv[i])) { i += 1; continue; } output.push(argv[i]); } return output; }
const envPlugins = String(process.env.CCBRIDGE_PLUGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean); const plugins = [...envPlugins, ...repeatedValues(rawArgs, "--plugin")]; const bridge = await createBridgeWithPlugins({ plugins }); const args = withoutOptionPairs(rawArgs, ["--plugin"]); const command = args.shift() ?? "help";
function valueOf(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; } function has(name) { return args.includes(name); }
function positional() { const values = []; const booleanOptions = ["--json", "--dry-run", "--all", "--strict-lossless"]; for (let i = 0; i < args.length; i += 1) { if (args[i].startsWith("--")) { if (!booleanOptions.includes(args[i])) i += 1; continue; } values.push(args[i]); } return values; }
function print(value) { if (has("--json")) console.log(JSON.stringify(value, null, 2)); else if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2)); }
function requestedMode(defaultMode = "portable") { return has("--all") || has("--strict-lossless") ? "lossless" : valueOf("--mode") ?? defaultMode; }
function cwdRouteOptions() { return { cwd: valueOf("--cwd"), cwdMappings: repeatedValues(args, "--map-cwd"), targetProfile: valueOf("--target-profile") ?? "native" }; }
function numericValue(name, fallback) { const raw = valueOf(name); if (raw === null) return fallback; const parsed = Number(raw); if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive number`); return Math.floor(parsed); }
function usage() { console.log(`ccbridge - local coding-agent session bridge\n\nUsage:\n  ccbridge fidelity <from> <to> <session> [--all] [--map-cwd FROM=TO] [--target-profile PROFILE]\n  ccbridge transfer <from> <to> <session> [--all] [--strict-lossless] [--dry-run] [--map-cwd FROM=TO] [--target-profile PROFILE]\n  ccbridge export <adapter> <session> [--output PATH] [--all]\n  ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH] [--map-cwd FROM=TO] [--target-profile PROFILE] [--dry-run]\n  ccbridge fork <archive.ccbridge> [--output PATH] [--id ID] [--title TITLE]\n  ccbridge merge <left.ccbridge> <right.ccbridge> [--output PATH] [--id ID] [--title TITLE] [--cwd PATH]\n  ccbridge diff <left.ccbridge> <right.ccbridge> [--limit N]\n  ccbridge extract-provenance <archive.ccbridge> <entry> [--output PATH]\n\nFork / merge:\n  fork creates a new universal session while embedding the complete parent archive as provenance.\n  merge keeps both branches without deduplication and embeds both complete source archives.\n\nDiff:\n  compares both semantic session history and integrity-manifest archive entries.\n\nCross-platform cwd mapping:\n  --map-cwd FROM=TO        repeatable prefix mapping; explicit mappings win\n  --target-profile native|windows|wsl|linux\n                           windows<->WSL drive paths are converted automatically\n\nExamples:\n  ccbridge diff ./before.ccbridge ./after.ccbridge --limit 50\n  ccbridge fork ./session.ccbridge --output ./fork.ccbridge\n  ccbridge merge ./branch-a.ccbridge ./branch-b.ccbridge --output ./merged.ccbridge\n`); }
function transferArgs() { const [from, to, session] = positional(); if (!from || !to || !session) throw new Error("Usage: ccbridge <command> <from> <to> <session> [--cwd PATH]"); return { from, to, session, ...cwdRouteOptions(), mode: requestedMode(), bundle: valueOf("--bundle") }; }
try {
  if (command === "help" || command === "--help" || command === "-h") usage();
  else if (command === "adapters") print(bridge.listAdapters());
  else if (command === "doctor") print({ runtime: detectRuntime(), plugins, homes: { claude: defaultClaudeHome(), codex: defaultCodexHome(), gemini: defaultGeminiHome(), antigravity: defaultAntigravityCliHome() }, adapters: await bridge.doctor() });
  else if (command === "list" || command === "sessions") { const [adapter] = positional(); if (!adapter) throw new Error("Usage: ccbridge list <adapter>"); print(await bridge.listSessions(adapter)); }
  else if (command === "inspect" || command === "show") { const [adapter, session] = positional(); if (!adapter || !session) throw new Error("Usage: ccbridge inspect <adapter> <session>"); print(await bridge.inspect(adapter, session, { mode: requestedMode() })); }
  else if (command === "fidelity") print(await bridge.fidelity(transferArgs()));
  else if (command === "export") { const [from, session] = positional(); if (!from || !session) throw new Error("Usage: ccbridge export <adapter> <session> [--output PATH]"); print(await bridge.exportSession({ from, session, destination: valueOf("--output"), mode: requestedMode("lossless") })); }
  else if (command === "import") { const [archive, to] = positional(); if (!archive || !to) throw new Error("Usage: ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH]"); print(await bridge.importArchive({ archive, to, ...cwdRouteOptions(), dryRun: has("--dry-run") })); }
  else if (command === "fork") { const [archive] = positional(); if (!archive) throw new Error("Usage: ccbridge fork <archive.ccbridge> [--output PATH]"); print(await forkCcbridgeArchive(archive, { destination: valueOf("--output"), id: valueOf("--id"), title: valueOf("--title") })); }
  else if (command === "merge") { const [left, right] = positional(); if (!left || !right) throw new Error("Usage: ccbridge merge <left.ccbridge> <right.ccbridge> [--output PATH]"); print(await mergeCcbridgeArchives(left, right, { destination: valueOf("--output"), id: valueOf("--id"), title: valueOf("--title"), cwd: valueOf("--cwd") })); }
  else if (command === "diff") { const [left, right] = positional(); if (!left || !right) throw new Error("Usage: ccbridge diff <left.ccbridge> <right.ccbridge> [--limit N]"); print(await diffCcbridgeArchives(left, right, { limit: numericValue("--limit", 20) })); }
  else if (command === "extract-provenance") { const [archive, entry] = positional(); if (!archive || !entry) throw new Error("Usage: ccbridge extract-provenance <archive.ccbridge> <entry> [--output PATH]"); print(await extractProvenanceArchive(archive, entry, valueOf("--output"))); }
  else if (command === "plan") print(await bridge.planTransfer(transferArgs()));
  else if (command === "transfer") print(await bridge.transfer({ ...transferArgs(), dryRun: has("--dry-run"), strictLossless: has("--strict-lossless") }));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`ccbridge: ${error.message}`); process.exitCode = 1; }
