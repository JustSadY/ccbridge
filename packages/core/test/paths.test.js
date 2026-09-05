import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  defaultGeminiHome,
  defaultQwenHome,
  defaultQwenRuntimeHome,
  defaultKiroHome,
  defaultKimiCodeHome,
  normalizePathKey,
  windowsPathToWsl,
  wslPathToWindows
} from "../src/platform/paths.js";

test("normalizes Windows verbatim paths for identity comparisons", () => {
  assert.equal(
    normalizePathKey("\\\\?\\C:\\Users\\Foo\\Project", "win32"),
    normalizePathKey("c:/Users/Foo/Project", "win32")
  );
});

test("converts Windows and WSL mount paths", () => {
  assert.equal(windowsPathToWsl("C:\\Users\\Foo\\Project"), "/mnt/c/Users/Foo/Project");
  assert.equal(wslPathToWindows("/mnt/c/Users/Foo/Project"), "C:\\Users\\Foo\\Project");
});

test("Gemini CLI home respects GEMINI_CLI_HOME as the home root", () => {
  assert.equal(
    defaultGeminiHome({ env: { GEMINI_CLI_HOME: "/custom/gemini-home" }, home: "/ignored" }),
    path.join("/custom/gemini-home", ".gemini")
  );
});

test("Qwen home defaults to .qwen and honors QWEN_HOME", () => {
  assert.equal(defaultQwenHome({ env: {}, home: "/home/example" }), path.resolve("/home/example/.qwen"));
  assert.equal(defaultQwenHome({ env: { QWEN_HOME: "/data/qwen-home" }, home: "/home/example" }), path.resolve("/data/qwen-home"));
});

test("Qwen runtime home defaults to Qwen home and QWEN_RUNTIME_DIR wins", () => {
  assert.equal(defaultQwenRuntimeHome({ env: { QWEN_HOME: "/data/qwen-home" }, home: "/home/example" }), path.resolve("/data/qwen-home"));
  assert.equal(defaultQwenRuntimeHome({ env: { QWEN_HOME: "/data/qwen-home", QWEN_RUNTIME_DIR: "/runtime/qwen" }, home: "/home/example" }), path.resolve("/runtime/qwen"));
});

test("Kiro home defaults to .kiro and honors KIRO_HOME", () => {
  assert.equal(defaultKiroHome({ env: {}, home: "/home/example" }), path.resolve("/home/example/.kiro"));
  assert.equal(defaultKiroHome({ env: { KIRO_HOME: "/data/kiro" }, home: "/home/example" }), path.resolve("/data/kiro"));
});

test("Kimi Code home defaults to .kimi-code and honors KIMI_CODE_HOME", () => {
  assert.equal(defaultKimiCodeHome({ env: {}, home: "/home/example" }), path.resolve("/home/example/.kimi-code"));
  assert.equal(defaultKimiCodeHome({ env: { KIMI_CODE_HOME: "/data/kimi" }, home: "/home/example" }), path.resolve("/data/kimi"));
});
