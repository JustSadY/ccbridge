# PortableSession v1

`PortableSession` is the provider-neutral interchange model used by ccbridge. Version 1 supports portable conversion plus additive lossless preservation without changing the schema version.

## Session

```js
{
  schemaVersion: 1,
  id: "session-id",
  title: "Optional title",
  cwd: "/optional/project/path",
  startedAt: "2026-09-04T07:00:00.000Z",
  updatedAt: "2026-09-04T08:00:00.000Z",
  source: {
    adapter: "example-agent",
    sessionId: "native-session-id",
    path: "/optional/native/source/path"
  },
  messages: [],
  metadata: {},
  events: [],
  lossless: null
}
```

Required fields remain `schemaVersion`, `id`, `source.adapter`, `messages` and `events`. Portable readers normally return `events: []` and `lossless: null`.

## Portable mode

Portable mode carries normalized user-visible context such as text, attachments, tool calls, tool results and safe adapter metadata. Provider-private thinking/reasoning is not exposed in portable mode.

### Text

```js
{ type: "text", text: "hello" }
```

### Attachment

```js
{
  type: "attachment",
  name: "screen.png",
  mimeType: "image/png",
  path: null,
  uri: null,
  data: "...",
  encoding: "base64",
  size: 1234,
  sha256: "...",
  archiveEntry: "attachments/0001-002-screen.png",
  metadata: {}
}
```

Adapters may provide attachment bytes inline (`data`), through a readable local `path`, or only as a `uri` reference. ccbridge does not fetch arbitrary remote URLs during archive creation.

When a `.ccbridge` v2 archive is written, readable attachment bytes are stored as dedicated `attachments/...` entries. The serialized `portable/session.json` references those entries instead of duplicating the inline payload. On archive read, verified bytes are reattached to the in-memory portable attachment so a target writer can import them. `materializeCcbridgeAttachments()` can additionally create temporary private files for targets that require paths.

## Lossless mode

A source adapter that supports lossless reads may be called with:

```js
await adapter.readSession(ref, { mode: "lossless" });
```

The returned session should set:

```js
{
  lossless: {
    enabled: true,
    sourceFormat: "vendor/session-jsonl",
    rawRecordCount: 42,
    includesProviderReasoning: true,
    includesUnknownEvents: true
  }
}
```

and populate `events` with source-native records in original order.

### Raw event

```js
{
  index: 12,
  provider: "example-agent",
  kind: "progress",
  timestamp: "2026-09-04T07:02:00.000Z",
  data: {}
}
```

Unknown records should be preserved instead of discarded when lossless mode is active.

## Reasoning content

Reasoning entries are emitted only in lossless mode:

```js
{
  type: "reasoning",
  provider: "example-agent",
  text: "provider reasoning text or null",
  summary: null,
  signature: null,
  encrypted: null,
  raw: {}
}
```

A target adapter must not assume that a source provider's reasoning object can be inserted into the target provider's reasoning field. Signed, encrypted or provider-validated data should be treated as preserved historical data unless the target explicitly documents compatible import semantics.

## Tool history

Tool calls and tool results are historical context. Importing a transferred session must not automatically re-execute the original command or tool.

## Lossless archive

Lossless transfers use the universal versioned `.ccbridge` archive. The archive keeps the normalized session, raw events, readable attachments and optional source-native artifacts as independent integrity-checked entries. See [ARCHIVE.md](ARCHIVE.md).

Lossless archives may include prompts, private provider reasoning, tool output, file content, system events, signatures, local paths and opaque product metadata. Treat them as sensitive files.

## Native routes vs portable routes

The bridge prefers a compatible native route when available. In lossless mode it also reads the complete source representation and creates a `.ccbridge` archive because a native target importer may legitimately discard source-private fields it cannot represent.

This gives two independent preservation layers: the target receives the best route it supports, while source data remains available for later replay, conversion or a future richer adapter.
