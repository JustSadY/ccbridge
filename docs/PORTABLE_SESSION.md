# PortableSession v1

`PortableSession` is the provider-neutral interchange model used when a lossless native import route is unavailable.

It is intentionally smaller than any one agent's private transcript schema. Adapters should preserve useful user-visible context while avoiding provider-private reasoning payloads and signatures.

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
  metadata: {}
}
```

Required fields:

- `schemaVersion` — currently `1`.
- `id` — portable session identifier.
- `source.adapter` — canonical adapter id.
- `messages` — ordered message array.

Paths are informational unless the target adapter explicitly uses them. Adapters must not assume that a source path exists on another machine.

## Message

```js
{
  id: "optional-native-message-id",
  parentId: "optional-parent-id",
  role: "user",
  createdAt: "2026-09-04T07:01:00.000Z",
  content: [],
  metadata: {}
}
```

Typical roles are:

- `user`
- `assistant`
- `system`
- `tool`

Adapters may retain an unfamiliar role when dropping it would lose useful context. Target adapters decide how unsupported roles are represented.

## Text content

```js
{
  type: "text",
  text: "Visible message text"
}
```

## Tool call

```js
{
  type: "tool-call",
  id: "call-id",
  name: "read_file",
  input: {
    path: "src/index.js"
  }
}
```

A tool call in a portable session is historical context. Importing it must not automatically execute the original command/tool.

## Tool result

```js
{
  type: "tool-result",
  callId: "call-id",
  output: "tool output or structured data",
  isError: false
}
```

## What is intentionally excluded

Portable conversion should not carry provider-private chain-of-thought/reasoning blobs, reasoning signatures, authentication material or opaque fields whose semantics are unknown.

Adapters may retain safe product-specific information under `metadata`, but another adapter must be able to ignore that metadata without breaking the session.

## Native routes vs portable routes

The bridge prefers a native route only when the target explicitly accepts the source artifact format. Otherwise it uses `PortableSession` when both adapters support it.

This means adding a new adapter does not require editing existing adapters. It only needs to implement the relevant source/target operations and declare the native formats it understands.
