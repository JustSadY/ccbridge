# Adapter model

`ccbridge` is a generic local coding-agent session bridge. Built-in products are adapters, not special cases in the transfer engine.

An adapter may implement any subset of these operations:

- `detect()` — locate the product and its local stores.
- `listSessions()` — discover local sessions.
- `readSession(ref, options)` — convert a native transcript into `PortableSession`; lossless-capable readers inspect `options.mode`.
- `getNativeArtifact(ref)` — expose a native artifact.
- `acceptsNativeArtifact(artifact)` — optional compatibility check for native imports.
- `importNativeArtifact(artifact, options)` — import a compatible native artifact.
- `writePortableSession(session, options)` — write the normalized/lossless portable model.

The bridge plans transfers in this order: compatible native artifact route, portable-session route, then explicit error.

In `lossless` mode the bridge also requires the source reader to return lossless data and writes a ccbridge sidecar bundle after a successful transfer.

## Native artifact compatibility

Native compatibility is format-based. A source artifact should expose a stable `format` string:

```js
{
  kind: "agent-session",
  format: "vendor/session-jsonl",
  formatVersion: 1,
  sourceAdapter: "vendor",
  path: "/path/to/session.jsonl"
}
```

A target may either implement `acceptsNativeArtifact()` or declare:

```js
nativeImports = ["vendor/session-jsonl"];
```

This prevents unrelated adapters from attempting to import each other's private files merely because both expose native import/export methods.

## Adapter contract

Minimal reader adapter:

```js
export default {
  id: "example",
  name: "Example Agent",
  aliases: ["ex"],

  async detect() {
    return { installed: true };
  },

  async listSessions() {
    return [];
  },

  async readSession(ref, options = {}) {
    if (options.mode === "lossless") {
      // Preserve source-private records under events/lossless.
    }
    // Return PortableSession.
  }
};
```

A lossless-capable adapter should expose `capabilities.losslessRead = true`.

## Lossless adapter requirements

When `options.mode === "lossless"`, a reader should preserve as much source material as the local transcript actually contains: provider thinking/reasoning blocks, reasoning signatures or opaque encrypted fields, system/progress/status events, tool metadata/results, checkpoints/rewinds/compact records, unknown future records and reconstruction metadata.

Prefer preserving the original parsed record under `session.events[].data` rather than guessing semantics for an unfamiliar field.

Normalized `reasoning` content is useful for adapters that understand it, but raw records remain the source of truth in lossless mode.

Do not blindly rewrite one provider's reasoning object into another provider's reasoning field. Such data may be signed, encrypted or version-specific. A target should only perform a semantic reasoning import when it explicitly supports that source format.

## External plugins

Adapters do not have to live in this repository. The core loader accepts package names, absolute paths, relative paths and file URLs. Supported module exports include a default adapter, `adapter`, an `adapters` array, or a `createAdapter(options)` factory.

One-off loading remains available:

```bash
ccbridge adapters --plugin @example/ccbridge-opencode
ccbridge list opencode --plugin @example/ccbridge-opencode
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge scan
```

For normal use, plugins can be persisted under `~/.ccbridge/plugins.json` (or `CCBRIDGE_HOME/plugins.json`):

```bash
ccbridge plugins add @example/ccbridge-cursor
ccbridge plugins list
ccbridge plugins disable @example/ccbridge-cursor
ccbridge plugins enable @example/ccbridge-cursor
ccbridge plugins remove @example/ccbridge-cursor
```

`plugins add` and `plugins enable` first load the module against the built-in registry so malformed adapters and id/alias collisions are rejected before the configuration is changed. Plugin management commands intentionally do not auto-load configured plugins, which means a broken plugin can still be disabled or removed.

ccbridge never invokes npm, pnpm, yarn, Bun or another package manager from `plugins add`. Install the package yourself in the same Node environment as ccbridge, then register its module name. Local relative plugin paths are normalized to absolute paths when persisted.

Plugins are executable JavaScript with the same user permissions as ccbridge. Only configure modules you trust.

## Adding a built-in adapter

Built-in adapters live under `packages/core/src/adapters/` and are registered by `createDefaultRegistry()`. Keep product-specific storage paths, JSON schemas and import behavior inside the adapter.

## Platform support

Adapters should use Node's cross-platform path and filesystem APIs. Windows and Linux are runtime targets; operating-system-specific code should exist only where a product stores its data differently. The core transfer model itself is operating-system agnostic.
