import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function run(args) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-cli-routes-"));
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, CCBRIDGE_HOME: home },
    windowsHide: true
  });
}

test("routes command emits machine-readable filtered route data", async () => {
  const result = await run(["routes", "pi-agent", "goose-ai", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.from, "pi");
  assert.equal(output.to, "goose");
  assert.equal(output.rows.length, 1);
  assert.equal(output.rows[0].route, "native");
  assert.deepEqual(output.rows[0].nativeFormats, ["pi/session-jsonl"]);
  assert.equal(output.rows[0].nativePreservation["pi/session-jsonl"], "best-effort");
  assert.equal(output.rows[0].lossless.preservation.overallClass, "best-effort+side-archive");
  assert.equal(output.rows[0].lossless.strict, "unavailable");
});

test("routes command human output exposes target and side-archive preservation", async () => {
  const result = await run(["routes", "pi", "goose"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /route=native \[pi\/session-jsonl:best-effort\]/);
  assert.match(result.stdout, /target=best-effort/);
  assert.match(result.stdout, /--all=best-effort\+side-archive/);
  assert.match(result.stdout, /strict:unavailable/);
});

test("routes command human output exposes no-route and strict status", async () => {
  const result = await run(["routes", "antigravity", "opencode"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /antigravity-cli -> opencode: route=none/);
  assert.match(result.stdout, /target=none/);
  assert.match(result.stdout, /--all=none/);
  assert.match(result.stdout, /strict:unavailable/);
});
