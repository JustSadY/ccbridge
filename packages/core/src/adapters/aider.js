import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createPortableSession, rawEvent, textContent } from "../model.js";

const DEFAULT_HISTORY_NAME = ".aider.chat.history.md";
const SESSION_HEADING = /^# aider chat started at (.+?)\s*$/i;
const USER_HEADING = /^####(?:\s+(.*))?$/;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache"]);

function exists(file) {
  return fs.access(file).then(() => true).catch(() => false);
}

function stableId(file, startOffset) {
  const digest = createHash("sha256").update(`${path.resolve(file)}\0${startOffset}`).digest("hex").slice(0, 16);
  return `aider-${digest}`;
}

function isoFromHeading(value) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stripBlockquote(line) {
  return line.replace(/^> ?/, "");
}

function nonEmptyText(lines) {
  const text = lines.join("\n").trim();
  return text || null;
}

function parseTurnBody(lines) {
  const assistant = [];
  const system = [];
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current || !buffer.length) { buffer = []; return; }
    const text = nonEmptyText(current === "system" ? buffer.map(stripBlockquote) : buffer);
    if (text) (current === "system" ? system : assistant).push(text);
    buffer = [];
  };
  for (const line of lines) {
    const kind = line.startsWith(">") ? "system" : "assistant";
    if (kind !== current) { flush(); current = kind; }
    buffer.push(line);
  }
  flush();
  return { assistant, system };
}

function splitSections(text, file) {
  const lines = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const starts = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(SESSION_HEADING);
    if (match) starts.push({ line: i, offset, heading: match[1] });
    offset += Buffer.byteLength(lines[i], "utf8") + 1;
  }
  if (!starts.length) return [{ id: stableId(file, 0), heading: null, startLine: 0, endLine: lines.length, startOffset: 0, lines }];
  return starts.map((start, index) => {
    const endLine = starts[index + 1]?.line ?? lines.length;
    return {
      id: stableId(file, start.offset),
      heading: start.heading,
      startLine: start.line,
      endLine,
      startOffset: start.offset,
      lines: lines.slice(start.line, endLine)
    };
  });
}

function sectionMessages(section, mode) {
  const messages = [];
  const lines = section.lines;
  const userIndices = [];
  for (let i = 0; i < lines.length; i += 1) if (USER_HEADING.test(lines[i])) userIndices.push(i);
  for (let turn = 0; turn < userIndices.length; turn += 1) {
    const userIndex = userIndices[turn];
    const userMatch = lines[userIndex].match(USER_HEADING);
    const next = userIndices[turn + 1] ?? lines.length;
    const userText = String(userMatch?.[1] ?? "").trim();
    if (userText) messages.push({ id: `${section.id}-u${turn + 1}`, parentId: null, role: "user", createdAt: null, content: [textContent(userText)], metadata: { aiderTurn: turn + 1 } });
    const body = parseTurnBody(lines.slice(userIndex + 1, next));
    for (let i = 0; i < body.assistant.length; i += 1) messages.push({ id: `${section.id}-a${turn + 1}-${i + 1}`, parentId: null, role: "assistant", createdAt: null, content: [textContent(body.assistant[i])], metadata: { aiderTurn: turn + 1 } });
    if (mode === "lossless") for (let i = 0; i < body.system.length; i += 1) messages.push({ id: `${section.id}-s${turn + 1}-${i + 1}`, parentId: null, role: "system", createdAt: null, content: [textContent(body.system[i])], metadata: { aiderTurn: turn + 1, aiderBlockquote: true } });
  }
  return messages;
}

function titleFromSection(section) {
  for (const line of section.lines) {
    const match = line.match(USER_HEADING);
    const text = String(match?.[1] ?? "").trim();
    if (text) return text.slice(0, 100);
  }
  return section.heading ? `Aider chat ${section.heading}` : null;
}

async function findHistories(root, output, seen) {
  let stat;
  try { stat = await fs.stat(root); } catch { return; }
  if (stat.isFile()) {
    if (path.basename(root) === DEFAULT_HISTORY_NAME || root.endsWith(".md")) {
      const real = await fs.realpath(root).catch(() => path.resolve(root));
      if (!seen.has(real)) { seen.add(real); output.push(path.resolve(root)); }
    }
    return;
  }
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await findHistories(full, output, seen);
    } else if (entry.isFile() && entry.name === DEFAULT_HISTORY_NAME) {
      const real = await fs.realpath(full).catch(() => full);
      if (!seen.has(real)) { seen.add(real); output.push(full); }
    }
  }
}

function configuredRoots(options = {}) {
  const env = options.env ?? process.env;
  if (options.chatHistoryFile || env.AIDER_CHAT_HISTORY_FILE) return [path.resolve(options.chatHistoryFile ?? env.AIDER_CHAT_HISTORY_FILE)];
  if (Array.isArray(options.roots) && options.roots.length) return options.roots.map((root) => path.resolve(root));
  const raw = String(env.CCBRIDGE_AIDER_ROOTS ?? "").trim();
  if (raw) return raw.split(path.delimiter).filter(Boolean).map((root) => path.resolve(root));
  return [process.cwd()];
}

export class AiderAdapter {
  constructor(options = {}) {
    this.id = "aider";
    this.name = "Aider";
    this.aliases = [];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["aider/chat-history-markdown-v1"];
    this.command = options.command ?? "aider";
    this.runner = options.runner ?? spawnSync;
    this.roots = configuredRoots(options);
  }

  async detect() {
    const result = this.runner(this.command, ["--version"], { encoding: "utf8", windowsHide: true });
    const files = await this.#historyFiles();
    return {
      installed: !result?.error && result?.status === 0,
      version: result?.status === 0 ? String(result.stdout || result.stderr || "").trim() : null,
      historyRoots: this.roots,
      historyFiles: files,
      sessionStoreExists: files.length > 0,
      storageFormat: "markdown-chat-history"
    };
  }

  async #historyFiles() {
    const output = [];
    const seen = new Set();
    for (const root of this.roots) await findHistories(root, output, seen);
    return output.sort();
  }

  async #sections() {
    const result = [];
    for (const file of await this.#historyFiles()) {
      let text;
      try { text = await fs.readFile(file, "utf8"); } catch { continue; }
      const stat = await fs.stat(file).catch(() => null);
      for (const section of splitSections(text, file)) result.push({ file, stat, section });
    }
    return result;
  }

  async listSessions() {
    const sessions = [];
    for (const item of await this.#sections()) {
      sessions.push({
        adapter: this.id,
        id: item.section.id,
        title: titleFromSection(item.section),
        cwd: path.dirname(item.file),
        path: item.file,
        createdAt: isoFromHeading(item.section.heading),
        updatedAt: item.stat?.mtime?.toISOString?.() ?? null,
        size: Buffer.byteLength(item.section.lines.join("\n"), "utf8"),
        kind: "markdown-chat"
      });
    }
    sessions.sort((a, b) => String(b.createdAt ?? b.updatedAt ?? "").localeCompare(String(a.createdAt ?? a.updatedAt ?? "")));
    return sessions;
  }

  async #resolve(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".md") && await exists(ref)) {
      const file = path.resolve(ref);
      const text = await fs.readFile(file, "utf8");
      const sections = splitSections(text, file);
      if (!sections.length) throw new Error(`Aider history is empty: ${ref}`);
      return { file, section: sections[sections.length - 1] };
    }
    for (const item of await this.#sections()) if (item.section.id === ref) return { file: item.file, section: item.section };
    throw new Error(`Aider session not found: ${sessionRef}`);
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const { file, section } = await this.#resolve(sessionRef);
    const raw = section.lines.join("\n").replace(/\n*$/, "\n");
    const stat = await fs.stat(file);
    const messages = sectionMessages(section, mode);
    const events = mode === "lossless" ? [rawEvent({
      index: 0,
      provider: this.id,
      kind: "markdown-section",
      timestamp: isoFromHeading(section.heading),
      data: { file, heading: section.heading, startLine: section.startLine + 1, endLine: section.endLine, markdown: raw }
    })] : [];
    return createPortableSession({
      id: section.id,
      title: titleFromSection(section),
      cwd: path.dirname(file),
      startedAt: isoFromHeading(section.heading),
      updatedAt: stat.mtime.toISOString(),
      source: { adapter: this.id, sessionId: section.id, path: file },
      messages,
      agents: [],
      metadata: {
        historyFile: file,
        sectionHeading: section.heading,
        semanticParser: "aider-markdown-v1",
        note: "Aider chat history is presentation-oriented Markdown; blockquote/system classification is best-effort."
      },
      events,
      lossless: mode === "lossless" ? {
        enabled: true,
        sourceFormat: "aider/chat-history-markdown-v1",
        rawRecordCount: 1,
        includesProviderReasoning: false,
        includesUnknownEvents: true,
        presentationHistory: true
      } : null
    });
  }

  async getNativeArtifact(sessionRef) {
    const { file, section } = await this.#resolve(sessionRef);
    const content = section.lines.join("\n").replace(/\n*$/, "\n");
    return {
      kind: "agent-session",
      format: "aider/chat-history-markdown-v1",
      formatVersion: 1,
      sourceAdapter: this.id,
      content,
      encoding: "utf8",
      filename: `${section.id}.aider.chat.history.md`,
      cwd: path.dirname(file),
      sessionId: section.id,
      sourcePath: file
    };
  }
}
