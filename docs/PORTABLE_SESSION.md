# PortableSession v1

`PortableSession` is the provider-neutral interchange model used by ccbridge. Version 1 now supports two operating modes without changing the schema version: normal portable conversion and additive lossless preservation.

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

Required fields remain:

- `schemaVersion` — currently `1`.
- `id` — portable session identifier.
- `source.adapter` — canonical adapter id.
- `messages` — ordered normalized message array.

`events` and `lossless` are additive fields. Portable readers normally return `events: []` and `lossless: null`.

## Portable mode

Portable mode is the default. It carries normalized user-visible context such as text, tool calls, tool results and safe adapter metadata. Provider-private thinking/reasoning is not exposed in portable mode.

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
  data: {
    // original parsed provider record, unchanged
  }
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

The fields intentionally accommodate different provider formats. Some products expose plaintext thinking, others summaries, signatures, encrypted/opaque content or only structured reasoning records.

A target adapter must not assume that a source provider's reasoning object can be inserted into the target provider's reasoning field. Signed/encrypted/provider-validated data should be treated as preserved historical data unless the target explicitly documents compatible import semantics.

## Tool history

Tool calls and tool results remain historical context. Importing a transferred session must not automatically re-execute the original command or tool.

## Lossless bundle

When a transfer is run with `mode: "lossless"`, ccbridge writes a sidecar bundle after the target transfer succeeds:

```js
{
  format: "ccbridge/lossless-session",
  version: 1,
  createdAt: "...",
  from: "claude-code",
  to: "codex",
  session: {
    // complete lossless PortableSession
  }
}
```

The default path is under `~/.ccbridge/lossless/`; `CCBRIDGE_HOME` or the CLI `--bundle` option can override it.

Lossless bundles may include prompts, private provider reasoning, tool output, file content, system events, signatures, local paths and opaque product metadata. Treat them as sensitive files.

## Native routes vs portable routes

The bridge still prefers a compatible native route when available. In lossless mode it also reads the complete source representation and creates a bundle, because a native target importer may legitimately discard source-private fields it cannot represent.

This gives two independent guarantees: the target receives the best import route it supports, and the original source data remains preserved for later replay, conversion or a future adapter with richer capabilities.
