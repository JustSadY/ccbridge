# Antigravity CLI adapter

The built-in `antigravity-cli` adapter intentionally starts as a conservative, read-only interoperability layer.

## Supported now

```bash
ccbridge list antigravity
ccbridge inspect antigravity <conversation-id> --all
ccbridge export antigravity <conversation-id> --output ./conversation.ccbridge
```

The adapter discovers the current Antigravity CLI per-conversation SQLite store under:

```text
~/.gemini/antigravity-cli/conversations/<conversation-id>.db
```

It also preserves adjacent SQLite WAL/SHM companions (`.db-wal`, `.db-shm`) when present. The workspace-to-last-conversation cache is used only to attach a known cwd to discovery results.

## Why portable transcript parsing is not enabled yet

Antigravity CLI moved to SQLite conversations in 1.0.4, but the transcript payload schema is not a documented public interchange contract. Conversation rows include private protobuf/opaque payloads, and the vendor currently does not expose a supported non-interactive full-history export/import command.

ccbridge therefore does not guess protobuf field numbers and does not write the Antigravity private database. `inspect` without `--all` fails explicitly instead of returning a misleading partial transcript.

A lossless `.ccbridge` export embeds the raw SQLite database plus WAL/SHM companions, preserving provider thinking/tool state and any unknown future fields at the native byte level for later decoding or migration support.

## Current limitation

`ccbridge transfer antigravity codex <id>` is not yet available because Codex does not natively import Antigravity SQLite and the Antigravity adapter does not yet expose a stable portable transcript. Raw backup/export is supported; semantic cross-provider migration will be added only behind a versioned decoder with compatibility checks.

Override the store root for testing or non-standard installations with:

```text
CCBRIDGE_ANTIGRAVITY_HOME=/path/to/antigravity-cli
```
