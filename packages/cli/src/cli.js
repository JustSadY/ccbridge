#!/usr/bin/env node
import {
  createBridgeWithPlugins,
  detectRuntime,
  defaultClaudeHome,
  defaultCodexHome,
  defaultGeminiHome
} from "@ccbridge/core";

const rawArgs = process.argv.slice(2);

function repeatedValues(argv, name) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === name && argv[i + 1]) {
      values.push(argv[i + 1]);
      i += 1;
    }
  }
  return values;
}

function withoutOptionPairs(argv, names) {
  const output = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (names.includes(argv[i])) {
      i += 1;
      continue;
    }
    output.push(argv[i]);
  }
  return output;
}

const envPlugins = String(process.env.CCBRIDGE_PLUGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const plugins = [...envPlugins, ...repeatedValues(rawArgs, "--plugin")];
const bridge = await createBridgeWithPlugins({ plugins });

const args = withoutOptionPairs(rawArgs, ["--plugin"]);
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
  const booleanOptions = ["--json", "--dry-run", "--all"];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (!booleanOptions.includes(args[i])) i += 1;
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

function requestedMode() {
  return has("--all") ? "lossless" : valueOf("--mode") ?? "portable";
}

function usage() {
  console.log(`ccbridge - local coding-agent session bridge

Usage:
  ccbridge adapters [--plugin MODULE] [--json]
  ccbridge doctor [--plugin MODULE] [--json]
  ccbridge list <adapter> [--plugin MODULE] [--json]
  ccbridge inspect <adapter> <session-id-or-path> [--mode portable|lossless] [--all] [--plugin MODULE] [--json]
  ccbridge plan <from> <to> <session-id-or-path> [--cwd PATH] [--mode portable|lossless] [--all] [--bundle PATH] [--plugin MODULE] [--json]
  ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH] [--mode portable|lossless] [--all] [--bundle PATH] [--dry-run] [--plugin MODULE] [--json]

Modes:
  portable  normalized visible conversation/tool history (default)
  lossless  also preserves provider thinking/reasoning, raw events, rewinds,
            metadata and unknown records in a private ccbridge bundle
  --all     shorthand for --mode lossless

Built-ins:
  claude / claude-code
  codex
  gemini / gemini-cli

Environment:
  CCBRIDGE_PLUGINS=package-a,./local-adapter.js
  CCBRIDGE_HOME=/custom/ccbridge/home

Examples:
  ccbridge adapters
  ccbridge list claude
  ccbridge inspect claude <session-id> --all
  ccbridge inspect codex <session-id> --mode lossless
  ccbridge plan claude codex <session-id> --all
  ccbridge transfer claude codex <session-id> --all --dry-run
  ccbridge transfer claude codex <session-id> --all --bundle ./session.ccbridge.json
  ccbridge list opencode --plugin @example/ccbridge-opencode
`);
}

function transferArgs() {
  const [from, to, session] = positional();
  if (!from || !to || !session) {
    throw new Error("Usage: ccbridge transfer <from> <to> <session-id-or-path> [--cwd PATH]");
  }
  return {
    from,
    to,
    session,
    cwd: valueOf("--cwd"),
    mode: requestedMode(),
    bundle: valueOf("--bundle")
  };
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
      plugins,
      homes: {
        claude: defaultClaudeHome(),
        codex: defaultCodexHome(),
        gemini: defaultGeminiHome()
      },
      adapters
    });
  } else if (command === "list" || command === "sessions") {
    const [adapter] = positional();
    if (!adapter) throw new Error("Usage: ccbridge list <adapter>");
    print(await bridge.listSessions(adapter));
  } else if (command === "inspect" || command === "show") {
    const [adapter, session] = positional();
    if (!adapter || !session) throw new Error("Usage: ccbridge inspect <adapter> <session-id-or-path>");
    print(await bridge.inspect(adapter, session, { mode: requestedMode() }));
  } else if (command === "plan") {
    print(await bridge.planTransfer(transferArgs()));
  } else if (command === "transfer" || command === "import") {
    print(await bridge.transfer({ ...transferArgs(), dryRun: has("--dry-run") }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`ccbridge: ${error.message}`);
  process.exitCode = 1;
}
