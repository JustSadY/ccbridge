#!/usr/bin/env node
import { createDefaultBridge, detectRuntime, defaultClaudeHome, defaultCodexHome } from "@ccbridge/core";

const bridge = createDefaultBridge();
const args = process.argv.slice(2);
const command = args.shift() ?? "help";

function valueOf(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function has(name) {
  return args.includes(name);
}

function positional() {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (!["--json", "--dry-run"].includes(args[i])) i += 1;
      continue;
    }
    values.push(args[i]);
  }
  return values;
}

function print(value) {
  if (has("--json")) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`ccbridge - local coding-agent session bridge

Usage:
  ccbridge adapters [--json]
  ccbridge doctor [--json]
  ccbridge list <adapter> [--json]
  ccbridge inspect <adapter> <session-id-or-path> [--json]
  ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH] [--dry-run] [--json]

Examples:
  ccbridge adapters
  ccbridge list claude
  ccbridge inspect claude 395e3f13-...
  ccbridge transfer claude codex 395e3f13-... --dry-run
  ccbridge transfer claude codex /path/to/session.jsonl --cwd /path/to/project
`);
}

try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "adapters") {
    print(bridge.listAdapters());
  } else if (command === "doctor") {
    const runtime = detectRuntime();
    const adapters = await bridge.doctor();
    print({
      runtime,
      homes: { claude: defaultClaudeHome(), codex: defaultCodexHome() },
      adapters
    });
  } else if (command === "list" || command === "sessions") {
    const [adapter] = positional();
    if (!adapter) throw new Error("Usage: ccbridge list <adapter>");
    print(await bridge.listSessions(adapter));
  } else if (command === "inspect" || command === "show") {
    const [adapter, session] = positional();
    if (!adapter || !session) throw new Error("Usage: ccbridge inspect <adapter> <session-id-or-path>");
    print(await bridge.inspect(adapter, session));
  } else if (command === "transfer" || command === "import") {
    const [from, to, session] = positional();
    if (!from || !to || !session) {
      throw new Error("Usage: ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH]");
    }
    print(await bridge.transfer({
      from,
      to,
      session,
      cwd: valueOf("--cwd"),
      dryRun: has("--dry-run")
    }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`ccbridge: ${error.message}`);
  process.exitCode = 1;
}
