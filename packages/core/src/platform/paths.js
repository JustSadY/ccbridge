import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function detectRuntime(env = process.env, platform = process.platform) {
  const isWsl = platform === "linux" && Boolean(env.WSL_DISTRO_NAME || safeReadProcVersion().includes("microsoft"));
  return {
    platform,
    isWindows: platform === "win32",
    isLinux: platform === "linux",
    isMac: platform === "darwin",
    isWsl,
    label: isWsl ? "wsl" : platform
  };
}

export function defaultClaudeHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
}

export function defaultCodexHome({ env = process.env, home = os.homedir() } = {}) {
  return env.CODEX_HOME || path.join(home, ".codex");
}

export function defaultGeminiHome({ home = os.homedir() } = {}) {
  return path.join(home, ".gemini");
}

export function normalizePathKey(input, platform = process.platform) {
  if (!input) return "";
  let value = String(input).trim();

  if (platform === "win32") {
    value = value.replace(/^\\\\\?\\/, "");
    value = value.replaceAll("/", "\\");
    value = path.win32.normalize(value);
    return value.toLowerCase();
  }

  return path.posix.normalize(value.replaceAll("\\", "/"));
}

export function windowsPathToWsl(input) {
  const match = String(input).replace(/^\\\\\?\\/, "").match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return input;
  const drive = match[1].toLowerCase();
  const rest = match[2].replaceAll("\\", "/");
  return `/mnt/${drive}/${rest}`;
}

export function wslPathToWindows(input) {
  const match = String(input).match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return input;
  return `${match[1].toUpperCase()}:\\${match[2].replaceAll("/", "\\")}`;
}

function safeReadProcVersion() {
  try {
    return fs.readFileSync("/proc/version", "utf8").toLowerCase();
  } catch {
    return "";
  }
}
