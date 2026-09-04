#!/usr/bin/env node
import {
  configuredPluginSpecifiers,
  createBridgeWithPlugins
} from "@ccbridge/core";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";

function repeatedValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name && args[i + 1]) {
      values.push(args[i + 1]);
      i += 1;
    }
  }
  return values;
}

function withoutOptionPairs(args, names) {
  const output = [];
  for (let i = 0; i < args.length; i += 1) {
    if (names.includes(args[i])) {
      i += 1;
      continue;
    }
    output.push(args[i]);
  }
  return output;
}

if (command !== "compatibility" && command !== "compat") {
  await import("./cli.js");
} else {
  const stripped = withoutOptionPairs(argv.slice(1), ["--plugin"]);
  const json = stripped.includes("--json");
  const positional = stripped.filter((value) => !value.startsWith("--"));
  const [adapter, session] = positional;
  const persistent = await configuredPluginSpecifiers();
  const environment = String(process.env.CCBRIDGE_PLUGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const explicit = repeatedValues(argv, "--plugin");
  const plugins = [...new Set([...persistent, ...environment, ...explicit])];
  try {
    const bridge = await createBridgeWithPlugins({ plugins });
    const result = await bridge.compatibility({
      adapterIds: adapter ? [adapter] : [],
      sessionRef: session ?? null
    });
    console.log(JSON.stringify(result, null, 2));
    if (session && result.driftDetected) process.exitCode = 4;
  } catch (error) {
    const message = `ccbridge: ${error.message}`;
    if (json) console.error(JSON.stringify({ error: error.message }, null, 2));
    else console.error(message);
    process.exitCode = 1;
  }
}
