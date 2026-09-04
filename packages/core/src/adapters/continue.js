import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPortableSession, rawEvent, textContent } from "../model.js";

const HEADER = /^### \[Continue\]\(https:\/\/continue\.dev\) session transcript\s*$/m;
const ROLE = /^#### _(?<role>User|Assistant)_\s*$/gm;
const SESSION_FILE = /_session\.md$/i;
const exists = (file) => fs.access(file).then(() => true).catch(() => false);

function roots(options = {}) {
  if (options.home) return [path.resolve(options.home)];
  if (Array.isArray(options.roots) && options.roots.length) return [...new Set(options.roots.map((value) => path.resolve(value)))];
  const env = options.env ?? process.env;
  const configured = String(env.CCBRIDGE_CONTINUE_ROOTS ?? "").split(path.delimiter).map((value) => value.trim()).filter(Boolean);
  return configured.length ? configured.map((value) => path.resolve(value)) : [path.join(options.userHome ?? os.homedir(), ".continue")];
}

function parseExportedAt(markdown) {
  const match = markdown.match(/^ Exported:\s*(.+)$/m);
  if (!match) return null;
  const date = new Date(match[1]);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unquote(body) {
  return body.split(/\r?\n/).map((line) => line.startsWith("> ") ? line.slice(2) : line === ">" ? "" : line).join("\n").trim();
}

export function parseContinueTranscript(markdown) {
  if (!HEADER.test(markdown)) throw new Error("Not a Continue exported session transcript");
  ROLE.lastIndex = 0;
  const markers = [];
  let match;
  while ((match = ROLE.exec(markdown))) markers.push({ role: match.groups.role.toLowerCase(), start: match.index, bodyStart: ROLE.lastIndex, heading: match[0] });
  return markers.map((marker, index) => {
    const end = markers[index + 1]?.start ?? markdown.length;
    return { role: marker.role, heading: marker.heading, raw: markdown.slice(marker.start, end).trim(), text: unquote(markdown.slice(marker.bodyStart, end).trim()) };
  });
}

export class ContinueAdapter {
  constructor(options = {}) {
    this.id = "continue";
    this.name = "Continue";
    this.aliases = ["continue-dev"];
    this.capabilities = { discover: true, read: true, write: false, nativeExport: true, nativeImport: false, losslessRead: true };
    this.nativeExports = ["continue/session-transcript-markdown-v1"];
    this.roots = roots(options);
  }

  async detect() {
    const detected = [];
    for (const root of this.roots) if (await exists(root)) detected.push(root);
    return { installed: detected.length > 0, version: null, storageRoots: this.roots, detectedStorageRoots: detected, sessionStoreExists: detected.length > 0, storageFormat: "exported-markdown-transcript", exportOnly: true };
  }

  async listSessions() {
    const sessions = [];
    for (const root of this.roots) {
      let entries;
      try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue;
        const file = path.join(root, entry.name);
        try {
          const markdown = await fs.readFile(file, "utf8");
          if (!HEADER.test(markdown)) continue;
          const stat = await fs.stat(file);
          const sections = parseContinueTranscript(markdown);
          sessions.push({ adapter: this.id, id: path.basename(entry.name, ".md"), title: sections.find((item) => item.role === "user" && item.text)?.text.slice(0, 100) ?? null, cwd: null, path: file, createdAt: parseExportedAt(markdown), updatedAt: stat.mtime.toISOString(), size: stat.size, exportOnly: true });
        } catch {}
      }
    }
    return sessions.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  }

  async resolveSession(sessionRef) {
    const ref = String(sessionRef);
    if (ref.endsWith(".md") && await exists(ref)) return path.resolve(ref);
    const sessions = await this.listSessions();
    const match = sessions.find((session) => session.id === ref || session.path === ref);
    if (!match) throw new Error(`Continue exported transcript not found: ${sessionRef}`);
    return match.path;
  }

  async readSession(sessionRef, options = {}) {
    const mode = options.mode === "lossless" ? "lossless" : "portable";
    const file = await this.resolveSession(sessionRef);
    const markdown = await fs.readFile(file, "utf8");
    const sections = parseContinueTranscript(markdown);
    const exportedAt = parseExportedAt(markdown);
    const stat = await fs.stat(file);
    const messages = sections.filter((section) => section.text).map((section, index) => ({ id: `continue-${index + 1}`, parentId: null, role: section.role, createdAt: null, content: [textContent(section.text)], metadata: { presentationOriented: true } }));
    const events = mode === "lossless" ? sections.map((section, index) => rawEvent({ index, provider: this.id, kind: `markdown:${section.role}`, timestamp: null, data: { heading: section.heading, raw: section.raw } })) : [];
    return createPortableSession({ id: path.basename(file, ".md"), title: messages.find((item) => item.role === "user")?.content?.[0]?.text?.slice(0, 100) ?? null, cwd: null, startedAt: exportedAt, updatedAt: exportedAt ?? stat.mtime.toISOString(), source: { adapter: this.id, sessionId: path.basename(file, ".md"), path: file }, messages, agents: [], metadata: { exportOnly: true, presentationOriented: true }, events, lossless: mode === "lossless" ? { enabled: true, sourceFormat: "continue/session-transcript-markdown-v1", rawRecordCount: events.length, includesProviderReasoning: false, includesUnknownEvents: false, presentationOriented: true } : null });
  }

  async getNativeArtifact(sessionRef) {
    const file = await this.resolveSession(sessionRef);
    return { kind: "agent-session", format: "continue/session-transcript-markdown-v1", formatVersion: 1, sourceAdapter: this.id, path: file, filename: path.basename(file), cwd: null, sessionId: path.basename(file, ".md"), exportOnly: true };
  }
}
