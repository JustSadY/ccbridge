# Adapter model

`ccbridge` is a generic local coding-agent session bridge. Claude Code and Codex are the first built-in adapters, not special cases in the transfer engine.

An adapter may implement any subset of these operations:

- `detect()` — locate the product and its local stores.
- `listSessions()` — discover local sessions.
- `readSession(ref)` — convert a native transcript into the portable session model.
- `getNativeArtifact(ref)` — expose a lossless native artifact.
- `acceptsNativeArtifact(artifact)` — optional compatibility check for native imports.
- `importNativeArtifact(artifact, options)` — import a compatible native artifact.
- `writePortableSession(session, options)` — write the normalized portable model.

The bridge plans transfers in this order:

1. compatible native artifact route;
2. portable-session route;
3. explicit `No compatible transfer route` error.

Native compatibility is format-based. A source artifact should expose a stable `format` string, for example:

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

  async readSession(ref) {
    // Return PortableSession.
  }
};
```

Capabilities are derived from implemented methods. An adapter may also provide a `capabilities` object to explicitly disable an implemented operation or expose additional metadata.

## External plugins

Adapters do not have to live in this repository. The core loader accepts package names, absolute paths, relative paths and file URLs.

Supported module exports:

```js
export default adapter;
```

```js
export const adapter = {...};
```

```js
export const adapters = [adapterA, adapterB];
```

or a factory:

```js
export function createAdapter(options) {
  return new ExampleAdapter(options);
}
```

Load from the CLI:

```bash
ccbridge adapters --plugin @example/ccbridge-gemini
ccbridge list gemini --plugin @example/ccbridge-gemini
```

Multiple plugins can be supplied:

```bash
ccbridge adapters \
  --plugin @example/ccbridge-gemini \
  --plugin ./local-opencode-adapter.js
```

They can also be configured through a comma-separated environment variable:

```bash
CCBRIDGE_PLUGINS=@example/ccbridge-gemini,./local-adapter.js ccbridge adapters
```

## Adding a built-in adapter

Built-in adapters live under `packages/core/src/adapters/` and are registered by `createDefaultRegistry()`. Keep all product-specific storage paths, JSON schemas and import behavior inside the adapter.

Potential adapters include Gemini CLI, Cursor, OpenCode, Aider and other local coding agents.

## Platform support

Adapters should use Node's cross-platform path and filesystem APIs. Windows and Linux are runtime targets; operating-system-specific code should exist only where a product stores its data differently.

The core transfer model itself is operating-system agnostic.

## Provider reasoning

Private reasoning/thinking payloads are not copied between providers. Portable sessions keep user-visible text, tool calls and tool results, while provider-specific reasoning/signatures are dropped.
