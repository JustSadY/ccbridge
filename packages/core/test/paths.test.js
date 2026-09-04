import test from "node:test";
import assert from "node:assert/strict";
import { normalizePathKey, windowsPathToWsl, wslPathToWindows } from "../src/platform/paths.js";

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
