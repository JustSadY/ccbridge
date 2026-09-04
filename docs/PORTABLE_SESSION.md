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
  agents: [],
  metadata: {},
  events: [],
  lossless: null
}
```

Required fields are `schemaVersion`, `id`, `source.adapter`, `messages`, `agents` and `events`. Portable readers normally return `events: []`, `agents: []` when no child agents exist, and `lossless: null`.

## Agent tree

Child-agent history is kept separate from the root message stream rather than being flattened into fake chat messages:

```js
{
  id: "reviewer-a1",
  parentId: null,
  name: "security-reviewer",
  kind: "subagent",
  startedAt: "...",
  updatedAt: "...",
  source: {
    adapter: "claude-code",
    sessionId: "reviewer-a1",
    path: ".../subagents/agent-reviewer-a1.jsonl"
  },
  messages: [],
  events: [],
  metadata: {}
}
```

`parentId: null` means the agent belongs directly to the root session. A provider may set `parentId` when nested-agent parent identity is available. Workflow/team identifiers and provider-specific metadata remain in `metadata`.

Targets that do not support agent trees must not silently claim to preserve them. Fidelity reports expose agent-tree history as its own feature; in lossless mode unsupported agent trees remain available in the `.ccbridge` archive.

Claude Code currently discovers normal subagents and workflow subagents beneath the parent session's `subagents/` directory. Subagent JSONL files are not exposed as duplicate top-level sessions.

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

When a `.ccbridge` v2 archive is written, readable root and subagent attachment bytes are stored as dedicated integrity-checked entries. Subagent assets use paths such as `attachments/agents/<agent-id>/...`. `materializeCcbridgeAttachments()` can create temporary private files for targets that require paths.

## Lossless mode

A source adapter that supports lossless reads may be called with:

```js
await adapter.readSession(ref, { mode: "lossless" });
```

The returned session can set fields such as:

```js
{
  lossless: {
    enabled: true,
    sourceFormat: "vendor/session-jsonl",
    rawRecordCount: 42,
    includesProviderReasoning: true,
    includesUnknownEvents: true,
    includesSubagents: true
  }
}
```

Root `events` and each agent's `events` preserve source-native records in original order when available.

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

Lossless transfers use the universal versioned `.ccbridge` archive. The archive keeps the normalized session, root/subagent raw events, readable attachments and optional source-native artifacts as integrity-checked data. See [ARCHIVE.md](ARCHIVE.md).

Lossless archives may include prompts, private provider reasoning, tool output, file content, system events, signatures, local paths, subagent transcripts and opaque product metadata. Treat them as sensitive files.

## Native routes vs portable routes

The bridge prefers a compatible native route for normal transfers because the provider's own importer usually understands more native structure than a generic conversion. Native compatibility alone does **not** mean exact preservation.

ccbridge classifies the target representation separately:

- `exact` — an audited native importer preserves semantically relevant session state without a target-side rewrite.
- `remapped` — native message/conversation data is retained while target-owned identity/context is recreated or changed.
- `best-effort` — the native importer accepts the format but ccbridge cannot prove a bounded or exact round-trip.
- `portable` — the destination is written from `PortableSession` and fidelity is evaluated feature by feature.

In lossless mode a second, independent dimension records whether a `.ccbridge` side archive is written. Thus `remapped+side-archive` means the destination session is remapped while the complete available source representation remains archived. It does not mean the destination became exact.

`--strict-lossless` only mutates a destination through a provably complete target representation. An audited `exact` native route is accepted directly. If the preferred native route is `remapped` or `best-effort`, ccbridge can evaluate a portable fallback against the actual lossless session; it uses that fallback only when every observed feature is representable. Otherwise strict mode blocks before mutation.

This gives two independent preservation layers: the target receives the safest representation it can prove, while source data remains available for later replay, conversion or a future richer adapter.

See [FIDELITY.md](FIDELITY.md) for the complete preservation contract.
