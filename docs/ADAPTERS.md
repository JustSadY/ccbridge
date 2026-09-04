# Adapter model

`ccbridge` is intentionally not a Claude/Codex-only converter. Products are connected through adapters.

An adapter may implement any subset of these operations:

- `detect()` — locate the product and its local stores.
- `listSessions()` — discover local sessions.
- `readSession(ref)` — convert a native transcript into the portable session model.
- `getNativeArtifact(ref)` — expose a native artifact that another product can import without lossy conversion.
- `importNativeArtifact(artifact, options)` — use a target product's official/native importer.
- `writePortableSession(session, options)` — write the normalized format when no native import path exists.

The bridge chooses a native route first, then falls back to the portable model.

## Adding another agent

Create a new class under `packages/core/src/adapters/` and register it in an application-specific registry. A future package can also register adapters without modifying the core package.

Minimal example:

```js
class ExampleAdapter {
  id = "example";
  aliases = ["ex"];
  name = "Example Agent";
  capabilities = { discover: true, read: true, write: false };

  async detect() {}
  async listSessions() {}
  async readSession(ref) {}
}
```

Potential adapters include Gemini CLI, Cursor, OpenCode, Aider and other local agents. Their schemas should remain isolated in their own adapters.

## Provider reasoning

Private reasoning/thinking payloads are not copied between providers. Portable sessions keep user-visible text, tool calls and tool results, while provider-specific reasoning/signatures are dropped.
