import test from "node:test";
import assert from "node:assert/strict";
import { applyCwdMappings, parseCwdMapping, resolveTargetCwdDetailed } from "../src/platform/cwd-map.js";

test("explicit cwd mappings apply by path prefix", () => {
  const parsed = parseCwdMapping("C:\\Users\\B\\Projects=/home/b/projects");
  assert.equal(parsed.from, "C:\\Users\\B\\Projects");
  const result = applyCwdMappings("C:\\Users\\B\\Projects\\app", [parsed]);
  assert.equal(result.cwd, "/home/b/projects/app");
  assert.equal(result.method, "explicit");
});

test("target profiles convert Windows and WSL drive paths", () => {
  const wsl = resolveTargetCwdDetailed("C:\\Users\\B\\Projects\\app", { targetProfile: "wsl" });
  assert.equal(wsl.cwd, "/mnt/c/Users/B/Projects/app");
  assert.equal(wsl.method, "windows-to-wsl");
  const windows = resolveTargetCwdDetailed("/mnt/c/Users/B/Projects/app", { targetProfile: "windows" });
  assert.equal(windows.cwd, "C:\\Users\\B\\Projects\\app");
  assert.equal(windows.method, "wsl-to-windows");
});

test("explicit mapping wins over target-profile inference", () => {
  const result = resolveTargetCwdDetailed("C:\\work\\app", { targetProfile: "wsl", cwdMappings: ["C:\\work=/home/me/work"] });
  assert.equal(result.cwd, "/home/me/work/app");
  assert.equal(result.method, "explicit");
});
