# Kimi Code adapter

`kimi-code` is a read/export source adapter for the current MoonshotAI Kimi Code session store. It does not mutate Kimi Code session directories and it does not treat the Visualizer ZIP import as a native CLI resume importer.

## Data root

Kimi Code uses:

```text
KIMI_CODE_HOME
```

with the default:

```text
~/.kimi-code
```

Sessions are self-describing directories:

```text
<KIMI_CODE_HOME>/
  session_index.jsonl
  sessions/<workDirKey>/<sessionId>/
    state.json
    upcoming-goals.json
    agents/
      main/
        wire.jsonl
        blobs/
        plans/
      <subagentId>/
        wire.jsonl
        blobs/
        plans/
    logs/
    tasks/
    cron/
```

Discovery scans `state.json` files instead of depending exclusively on `session_index.jsonl`, so an incomplete/stale index does not hide an otherwise readable session directory.

## Portable reconstruction

Kimi Code's `wire.jsonl` is an append-only replay journal. ccbridge handles the replay-relevant context vocabulary used by current agent-core:

```text
context.append_message
context.append_loop_event
context.clear
context.undo
context.apply_compaction
```

For loop events, ccbridge reconstructs:

```text
step.begin
content.part
tool.call
tool.result
step.end
```

This means an assistant message can be rebuilt even though Kimi does not persist a synthetic assistant `context.append_message` for every model turn.

Pending tool calls that never received a result are closed with an explicit synthetic interrupted/error result, matching Kimi's resume behavior rather than assuming that the tool succeeded.

`context.clear` resets portable model context. `context.undo` removes the corresponding tail of real user turns while respecting injection/compaction boundaries.

## Compaction

Kimi's exact live compaction rebuild selects a bounded set of real user messages and then appends the summary. That selection depends on Kimi's internal token-budget helper.

The first ccbridge Kimi adapter intentionally does not clone that private token-counting implementation. When it encounters `context.apply_compaction`, portable context is conservatively rebuilt from the recorded summary plus subsequent records and:

```text
metadata.compactionApproximation = true
lossless.compactionSemanticApproximation = true
```

is set.

The complete pre/post-compaction wire remains in lossless raw events and in the native `.ccbridge` session-directory payload. Therefore no physical Kimi data is discarded by `--all`, but ccbridge does not claim an exact semantic target reconstruction for that compacted session.

## Thinking and provider signatures

Kimi content parts are normalized as:

```text
text       -> text
think      -> reasoning (lossless mode only)
image_url  -> attachment
audio_url  -> attachment
video_url  -> attachment
```

The `think.encrypted` provider-specific reasoning signature is retained in the portable reasoning block's `encrypted` field when `--all` / lossless mode is used.

Thinking is historical/provider-private context. It is not injected into a different target provider's native reasoning channel by default.

## Tools

Assistant `toolCalls[]` become portable tool calls. Tool-role messages and `tool.result` loop events become portable tool results, including error state and notes where available.

Interrupted tool exchanges are never silently marked successful.

## Media and blob refs

Kimi can offload large media from `wire.jsonl` using:

```text
blobref:<mime>;<hash>
```

ccbridge maps these references to:

```text
<agentDir>/blobs/<hash>
```

and the same blob files are also part of the native session-directory companion archive. Normal URL/data media references remain URI-backed attachments.

## Subagents

Every directory under:

```text
agents/<agentId>/wire.jsonl
```

is read separately. `agents/main` becomes the root session conversation; all other agents become `PortableSession.agents[]`.

Agent lineage comes from `state.json`:

```text
parentAgentId
forkedFrom
type
labels
swarmItem
homedir
```

and is retained as portable agent metadata.

## Native `.ccbridge` preservation

`getNativeArtifact()` uses `state.json` as the primary native file and recursively embeds the rest of the session directory as companions, including when present:

```text
wire.jsonl
subagent wire files
blobs
plans
upcoming-goals.json
tasks and task output
cron state
session logs
```

The archive layer stores these as integrity-checked `.ccbridge` entries with byte count and SHA-256.

## Schema drift

Unknown wire record types remain lossless raw events. Unknown content parts become `kimi-unknown` in lossless semantic content.

Use:

```bash
ccbridge compatibility kimi <session-id>
```

to identify a newer wire/content shape that needs parser coverage.

## Routes

Kimi Code currently has no native target writer in ccbridge.

```text
Kimi -> OpenCode     portable
Kimi -> Kilo Code    portable
*    -> Kimi Code    none
```

Typical commands:

```bash
ccbridge scan kimi --sessions
ccbridge list kimi
ccbridge inspect kimi <session-id> --all
ccbridge compatibility kimi <session-id>
ccbridge export kimi <session-id> --output kimi.ccbridge
ccbridge fidelity kimi opencode <session-id> --all
ccbridge transfer kimi opencode <session-id> --all
ccbridge transfer kimi kilo <session-id> --all
```

Because normal Kimi sessions carry provider metadata, raw wire state, and often thinking/tool lifecycle details that OpenCode/Kilo do not preserve semantically, `--strict-lossless` is expected to block unless a future target route can prove 100% representation.
