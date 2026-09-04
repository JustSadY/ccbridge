#!/usr/bin/env node
import { createBridgeWithPlugins, detectRuntime, defaultClaudeHome, defaultCodexHome, defaultGeminiHome } from "@ccbridge/core";

const rawArgs = process.argv.slice(2);
function repeatedValues(argv, name) { const values = []; for (let i = 0; i < argv.length; i += 1) { if (argv[i] === name && argv[i + 1]) { values.push(argv[i + 1]); i += 1; } } return values; }
function withoutOptionPairs(argv, names) { const output = []; for (let i = 0; i < argv.length; i += 1) { if (names.includes(argv[i])) { i += 1; continue; } output.push(argv[i]); } return output; }
const envPlugins = String(process.env.CCBRIDGE_PLUGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const plugins = [...envPlugins, ...repeatedValues(rawArgs, "--plugin")];
const bridge = await createBridgeWithPlugins({ plugins });
const args = withoutOptionPairs(rawArgs, ["--plugin"]);
const command = args.shift() ?? "help";
function valueOf(name) { const index = args.indexOf(name); return index < 0 ? null : args[index + 1] ?? null; }
function has(name) { return args.includes(name); }
function positional() { const values = []; const booleanOptions = ["--json", "--dry-run", "--all"]; for (let i = 0; i < args.length; i += 1) { if (args[i].startsWith("--")) { if (!booleanOptions.includes(args[i])) i += 1; continue; } values.push(args[i]); } return values; }
function print(value) { if (has("--json")) console.log(JSON.stringify(value, null, 2)); else if (typeof value === "string") console.log(value); else console.log(JSON.stringify(value, null, 2)); }
function requestedMode(defaultMode = "portable") { return has("--all") ? "lossless" : valueOf("--mode") ?? defaultMode; }
function usage() {
  console.log(`ccbridge - local coding-agent session bridge

Usage:
  ccbridge adapters [--plugin MODULE] [--json]
  ccbridge doctor [--plugin MODULE] [--json]
  ccbridge list <adapter> [--plugin MODULE] [--json]
  ccbridge inspect <adapter> <session-id-or-path> [--mode portable|lossless] [--all] [--plugin MODULE] [--json]
  ccbridge export <adapter> <session-id-or-path> [--output PATH] [--mode portable|lossless] [--all] [--plugin MODULE] [--json]
  ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH] [--dry-run] [--plugin MODULE] [--json]
  ccbridge plan <from> <to> <session-id-or-path> [--cwd PATH] [--mode portable|lossless] [--all] [--bundle PATH] [--plugin MODULE] [--json]
  ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH] [--mode portable|lossless] [--all] [--bundle PATH] [--dry-run] [--plugin MODULE] [--json]

Archive:
  export defaults to lossless and embeds the native session file when available.

Examples:
  ccbridge export claude <session-id> --output ./session.ccbridge
  ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
  ccbridge import ./session.ccbridge codex --cwd /path/to/project
  ccbridge transfer claude codex <session-id> --all
`);
}
function transferArgs() { const [from, to, session] = positional(); if (!from || !to || !session) throw new Error("Usage: ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH]"); return { from, to, session, cwd: valueOf("--cwd"), mode: requestedMode(), bundle: valueOf("--bundle") }; }

try {
  if (command === "help" || command === "--help" || command === "-h") usage();
  else if (command === "adapters") print(bridge.listAdapters());
  else if (command === "doctor") print({ runtime: detectRuntime(), plugins, homes: { claude: defaultClaudeHome(), codex: defaultCodexHome(), gemini: defaultGeminiHome() }, adapters: await bridge.doctor() });
  else if (command === "list" || command === "sessions") { const [adapter] = positional(); if (!adapter) throw new Error("Usage: ccbridge list <adapter>"); print(await bridge.listSessions(adapter)); }
  else if (command === "inspect" || command === "show") { const [adapter, session] = positional(); if (!adapter || !session) throw new Error("Usage: ccbridge inspect <adapter> <session-id-or-path>"); print(await bridge.inspect(adapter, session, { mode: requestedMode() })); }
  else if (command === "export") { const [from, session] = positional(); if (!from || !session) throw new Error("Usage: ccbridge export <adapter> <session-id-or-path> [--output PATH]"); print(await bridge.exportSession({ from, session, destination: valueOf("--output"), mode: requestedMode("lossless") })); }
  else if (command === "import") { const [archive, to] = positional(); if (!archive || !to) throw new Error("Usage: ccbridge import <archive.ccbridge> <target-adapter> [--cwd PATH]"); print(await bridge.importArchive({ archive, to, cwd: valueOf("--cwd"), dryRun: has("--dry-run") })); }
  else if (command === "plan") print(await bridge.planTransfer(transferArgs()));
  else if (command === "transfer") print(await bridge.transfer({ ...transferArgs(), dryRun: has("--dry-run") }));
  else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(`ccbridge: ${error.message}`); process.exitCode = 1; }
