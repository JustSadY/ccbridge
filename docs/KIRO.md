# Kiro CLI adapter

`kiro-cli` is a read/export source adapter. It does not mutate Kiro's SQLite session database and it does not drive interactive `/chat load` commands.

## Supported local artifact

The adapter reads JSONL-backed Kiro/ACP sessions under:

```text
<KIRO_HOME|~/.kiro>/sessions/cli/<session-id>.jsonl
<KIRO_HOME|~/.kiro>/sessions/cli/<session-id>.json
<KIRO_HOME|~/.kiro>/sessions/cli/<session-id>.history
<KIRO_HOME|~/.kiro>/sessions/cli/<session-id>/...
```

`CCBRIDGE_KIRO_SESSION_ROOTS` can point to one or more alternate JSONL session directories.

The JSONL event stream is normalized from known event/block families such as:

```text
Prompt
AssistantMessage
ToolUse
ToolResults
Clear

text
thinking
toolUse
toolResult
image
```

Thinking blocks become portable `reasoning` only in lossless mode. Unknown event records remain raw events; unknown content blocks additionally become `kiro-unknown`, so `ccbridge compatibility kiro <session>` can report schema drift without silently discarding the source data.

## Clear semantics

Kiro can continue in the same session after `/clear`. Portable reads therefore use only the semantic context after the latest `Clear` event. Lossless reads keep the entire physical JSONL, including pre-clear history and malformed lines.

## Native `.ccbridge` preservation

A Kiro native artifact includes the root JSONL plus available companions:

- `<id>.json` metadata/state
- `<id>.history` prompt history
- files below an adjacent `<id>/` directory

These files are stored as integrity-checked native entries in `.ccbridge` archives.

## Current V3 database limitation

Current Kiro CLI documentation describes local V3 sessions as database-backed under `~/.kiro/`. Some Kiro modes/ACP sessions also expose the JSON/JSONL files above. ccbridge currently parses the versioned JSONL artifact only; it intentionally does not inspect or mutate Kiro's private SQLite schema.

A database-only V3 session therefore may not appear in `ccbridge list kiro` yet. Use Kiro's own session dashboard/list commands for those sessions. A future adapter backend can add database discovery once there is a stable public schema or a safe non-interactive official export API.

Manual Kiro `/chat save` and `/chat load` JSON round-trip exists, but the public docs do not currently define the exported JSON field schema. ccbridge does not guess that schema.

## Commands

```bash
ccbridge scan kiro --sessions
ccbridge list kiro
ccbridge inspect kiro <session-id>
ccbridge inspect kiro <session-id> --all
ccbridge compatibility kiro <session-id>
ccbridge export kiro <session-id> --output kiro.ccbridge
ccbridge transfer kiro opencode <session-id> --all
ccbridge transfer kiro kilo <session-id> --all
```

Kiro has no ccbridge target importer at present. Transfers out of Kiro use the portable route, optionally with a lossless `.ccbridge` side archive.
