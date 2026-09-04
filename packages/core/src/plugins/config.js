import fs from "node:fs/promises";
import path from "node:path";
import { defaultCcbridgeHome } from "../lossless/archive.js";

export const PLUGIN_CONFIG_VERSION = 1;

function normalizeSpecifier(value) {
  const specifier = String(value ?? "").trim();
  if (!specifier) throw new Error("Plugin module specifier is required");
  if (specifier.startsWith("./") || specifier.startsWith("../") || path.isAbsolute(specifier)) return path.resolve(specifier);
  return specifier;
}

export function defaultPluginConfigPath(options = {}) {
  return options.path ? path.resolve(options.path) : path.join(options.home ?? defaultCcbridgeHome(options), "plugins.json");
}

function emptyConfig() {
  return { version: PLUGIN_CONFIG_VERSION, plugins: [] };
}

function validateConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Invalid ccbridge plugin config");
  if (config.version !== PLUGIN_CONFIG_VERSION) throw new Error(`Unsupported ccbridge plugin config version: ${config.version ?? "unknown"}`);
  if (!Array.isArray(config.plugins)) throw new Error("Invalid ccbridge plugin config: plugins must be an array");
  const seen = new Set();
  const plugins = config.plugins.map((item) => {
    const specifier = normalizeSpecifier(item?.specifier);
    if (seen.has(specifier)) throw new Error(`Duplicate configured plugin: ${specifier}`);
    seen.add(specifier);
    return {
      specifier,
      enabled: item?.enabled !== false,
      addedAt: item?.addedAt ?? null,
      metadata: item?.metadata && typeof item.metadata === "object" ? item.metadata : {}
    };
  });
  return { version: PLUGIN_CONFIG_VERSION, plugins };
}

export async function readPluginConfig(options = {}) {
  const configPath = defaultPluginConfigPath(options);
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8"));
    return { path: configPath, config: validateConfig(parsed) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: configPath, config: emptyConfig() };
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ccbridge plugin config: ${configPath}`);
    throw error;
  }
}

async function writePluginConfig(config, options = {}) {
  const configPath = defaultPluginConfigPath(options);
  const validated = validateConfig(config);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, configPath);
  try { await fs.chmod(configPath, 0o600); } catch {}
  return { path: configPath, config: validated };
}

export async function listConfiguredPlugins(options = {}) {
  const loaded = await readPluginConfig(options);
  return {
    path: loaded.path,
    version: loaded.config.version,
    plugins: loaded.config.plugins.map((plugin) => ({ ...plugin }))
  };
}

export async function configuredPluginSpecifiers(options = {}) {
  const loaded = await readPluginConfig(options);
  return loaded.config.plugins.filter((plugin) => plugin.enabled).map((plugin) => plugin.specifier);
}

export async function addConfiguredPlugin(specifier, options = {}) {
  const normalized = normalizeSpecifier(specifier);
  const loaded = await readPluginConfig(options);
  const existing = loaded.config.plugins.find((plugin) => plugin.specifier === normalized);
  if (existing) {
    if (existing.enabled) return { path: loaded.path, changed: false, plugin: { ...existing } };
    existing.enabled = true;
    const written = await writePluginConfig(loaded.config, options);
    return { path: written.path, changed: true, plugin: { ...existing } };
  }
  const plugin = { specifier: normalized, enabled: true, addedAt: new Date().toISOString(), metadata: {} };
  loaded.config.plugins.push(plugin);
  const written = await writePluginConfig(loaded.config, options);
  return { path: written.path, changed: true, plugin: { ...plugin } };
}

export async function removeConfiguredPlugin(specifier, options = {}) {
  const normalized = normalizeSpecifier(specifier);
  const loaded = await readPluginConfig(options);
  const index = loaded.config.plugins.findIndex((plugin) => plugin.specifier === normalized);
  if (index < 0) return { path: loaded.path, changed: false, removed: null };
  const [removed] = loaded.config.plugins.splice(index, 1);
  const written = await writePluginConfig(loaded.config, options);
  return { path: written.path, changed: true, removed };
}

export async function setConfiguredPluginEnabled(specifier, enabled, options = {}) {
  const normalized = normalizeSpecifier(specifier);
  const loaded = await readPluginConfig(options);
  const plugin = loaded.config.plugins.find((item) => item.specifier === normalized);
  if (!plugin) throw new Error(`Configured plugin not found: ${normalized}`);
  const desired = Boolean(enabled);
  if (plugin.enabled === desired) return { path: loaded.path, changed: false, plugin: { ...plugin } };
  plugin.enabled = desired;
  const written = await writePluginConfig(loaded.config, options);
  return { path: written.path, changed: true, plugin: { ...plugin } };
}
