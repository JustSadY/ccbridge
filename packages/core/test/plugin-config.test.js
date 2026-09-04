import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  addConfiguredPlugin,
  configuredPluginSpecifiers,
  listConfiguredPlugins,
  readPluginConfig,
  removeConfiguredPlugin,
  setConfiguredPluginEnabled
} from "../src/plugins/config.js";

async function pluginHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "ccbridge-plugins-"));
}

test("persistent plugin config supports add/list/disable/enable/remove", async () => {
  const home = await pluginHome();
  let listed = await listConfiguredPlugins({ home });
  assert.deepEqual(listed.plugins, []);

  const added = await addConfiguredPlugin("@example/ccbridge-agent", { home });
  assert.equal(added.changed, true);
  assert.equal(added.plugin.enabled, true);
  const duplicate = await addConfiguredPlugin("@example/ccbridge-agent", { home });
  assert.equal(duplicate.changed, false);
  assert.deepEqual(await configuredPluginSpecifiers({ home }), ["@example/ccbridge-agent"]);

  const disabled = await setConfiguredPluginEnabled("@example/ccbridge-agent", false, { home });
  assert.equal(disabled.changed, true);
  assert.deepEqual(await configuredPluginSpecifiers({ home }), []);

  const enabled = await setConfiguredPluginEnabled("@example/ccbridge-agent", true, { home });
  assert.equal(enabled.plugin.enabled, true);
  assert.deepEqual(await configuredPluginSpecifiers({ home }), ["@example/ccbridge-agent"]);

  const removed = await removeConfiguredPlugin("@example/ccbridge-agent", { home });
  assert.equal(removed.changed, true);
  listed = await listConfiguredPlugins({ home });
  assert.deepEqual(listed.plugins, []);
});

test("plugin config persists versioned JSON and rejects malformed files", async () => {
  const home = await pluginHome();
  await addConfiguredPlugin("local-plugin", { home });
  const loaded = await readPluginConfig({ home });
  assert.equal(loaded.config.version, 1);
  assert.equal(loaded.config.plugins[0].specifier, "local-plugin");

  await fs.writeFile(loaded.path, "{not-json", "utf8");
  await assert.rejects(readPluginConfig({ home }), /Invalid JSON/);
});
