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

The bridge plans normal transfers in this order: compatible native artifact route, portable-session route, then explicit error. Strict-lossless planning is more conservative and may choose a portable route instead of a compatible native importer when the native importer is not audited as exact.

In `lossless` mode the bridge also requires the source reader to return lossless data and writes a ccbridge side archive after a successful transfer.

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

Compatibility and fidelity are different. `nativeImports` only says that the target accepts a format; it does not mean the import is lossless.

## Native preservation contract

A target may describe audited native behavior with:

```js
nativeImportPreservation = {
  "vendor/session-json": "remapped",
  "vendor/legacy-json": "best-effort"
};
```

Allowed explicit native classes are:

- `exact` — audited native round-trip without semantically relevant target-side rewrites.
- `remapped` — native conversation/message data is retained, while target-owned identity/context such as session id, project, cwd/path or session type is recreated or changed.
- `best-effort` — the importer accepts the format, but ccbridge cannot prove an exact or bounded remapped round-trip.

A format omitted from `nativeImportPreservation` defaults to `best-effort`.

The older field remains supported:

```js
losslessNativeImports = ["vendor/session-json"];
```

A format listed there is treated as `exact` only when no explicit `nativeImportPreservation[format]` is present. New adapters should prefer the explicit map because it makes remapped behavior visible.

Do not declare `exact` merely because export and import use the same JSON extension or belong to the same product. Audit whether session identity/context, reasoning/private blocks, tool payloads, attachments, branches/subagents, unknown records and relevant metadata survive the round-trip.

See [FIDELITY.md](FIDELITY.md).

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

A writable target should describe the normalized features it can represent. This is used for actual-session fidelity checks and strict portable fallback:

```js
portableSupport = {
  text: true,
  toolCall: true,
  toolResult: true,
  reasoning: false,
  system: true,
  attachment: false,
  subagent: false,
  unknownContent: false,
  rawEvent: false,
  metadata: true
};
```

Do not set a feature to `true` unless `writePortableSession()` really preserves it in the target representation.

## Lossless adapter requirements

When `options.mode === "lossless"`, a reader should preserve as much source material as the local transcript actually contains: provider thinking/reasoning blocks, reasoning signatures or opaque encrypted fields, system/progress/status events, tool metadata/results, checkpoints/rewinds/compact records, unknown future records and reconstruction metadata.

Prefer preserving the original parsed record under `session.events[].data` rather than guessing semantics for an unfamiliar field.

Normalized `reasoning` content is useful for adapters that understand it, but raw records remain the source of truth in lossless mode.

Do not blindly rewrite one provider's reasoning object into another provider's reasoning field. Such data may be signed, encrypted or version-specific. A target should only perform a semantic reasoning import when it explicitly supports that source format.

## Strict-lossless behavior

`--strict-lossless` must never mutate a target through a route that ccbridge cannot prove complete.

For a native route:

1. `exact` is accepted.
2. `remapped` or `best-effort` is not accepted as strict native preservation.
3. If the target also has `writePortableSession()`, ccbridge evaluates the actual lossless source session against `portableSupport`.
4. It switches to portable only if every observed feature is preserved.
5. Otherwise it rejects before `importNativeArtifact()` or `writePortableSession()` runs.

The `.ccbridge` side archive is independent from this decision. Preserving raw source bytes in an archive does not make the destination exact.

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

Before promoting a built-in native format above `best-effort`, add source-backed evidence and fixture tests for the claimed preservation class.

## Platform support

Adapters should use Node's cross-platform path and filesystem APIs. Windows and Linux are runtime targets; operating-system-specific code should exist only where a product stores its data differently. The core transfer model itself is operating-system agnostic.
