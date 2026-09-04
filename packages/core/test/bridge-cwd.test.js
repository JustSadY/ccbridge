import test from "node:test";
import assert from "node:assert/strict";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { SessionBridge } from "../src/bridge.js";

function portable(cwd) { return { schemaVersion: 1, id: "s1", title: null, cwd, startedAt: null, updatedAt: null, source: { adapter: "source", sessionId: "s1", path: null }, messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hello" }], metadata: {} }], metadata: {}, events: [], lossless: null }; }

test("bridge applies cwd mapping before portable target writes", async () => {
  let writtenCwd = null;
  const source = { id: "source", name: "Source", async readSession() { return portable("C:\\Users\\B\\Projects\\app"); } };
  const target = { id: "target", name: "Target", portableSupport: { text: true }, async writePortableSession(_session, options) { writtenCwd = options.cwd; return { cwd: options.cwd }; } };
  const bridge = new SessionBridge(new AdapterRegistry().register(source).register(target));
  const plan = await bridge.planTransfer({ from: "source", to: "target", session: "s1", targetProfile: "wsl" });
  assert.equal(plan.cwd, "/mnt/c/Users/B/Projects/app");
  assert.equal(plan.cwdMapping.method, "windows-to-wsl");
  const result = await bridge.transfer({ from: "source", to: "target", session: "s1", cwdMappings: ["C:\\Users\\B\\Projects=/home/b/projects"] });
  assert.equal(result.cwd, "/home/b/projects/app");
  assert.equal(writtenCwd, "/home/b/projects/app");
});
