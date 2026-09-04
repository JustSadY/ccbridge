# ccbridge

Cross-agent local session bridge for coding assistants.

`ccbridge` is provider-neutral: adapters discover, read, export, import or write sessions while the core plans compatible routes. Built-ins currently cover Claude Code, OpenAI Codex, Gemini CLI, OpenCode and Google Antigravity CLI.

## Repository layout

```text
packages/
  core/   adapter SDK, discovery, portable/lossless model, archives, fidelity, route planner
  cli/    command-line interface only
```

## Current built-ins

| Adapter | Discover | Portable read | Lossless read | Portable write | Native route |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes | yes | yes | no | exports Claude session JSONL |
| OpenAI Codex | yes | yes | yes | no | imports Claude session JSONL via app-server |
| Gemini CLI | yes | yes | yes | no | no target importer yet |
| OpenCode | yes | yes | yes | yes | official `export` / `import` JSON |
| Antigravity CLI | yes | no | native-only | no | lossless SQLite + WAL/SHM export |

Codex imports use `codex app-server` / `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly. OpenCode uses its official CLI import/export surface instead of touching its private database.

## Install from source

```bash
npm install
npm test
npm link --workspace @ccbridge/cli
```

## Interactive mode

```bash
ccbridge ui
```

The dependency-free terminal flow scans local sessions, lets you choose source agent, session, target agent and transfer mode, prints the actual route plan, then requires explicit confirmation before target mutation. Lossless mode is presented first so raw/thinking data can be preserved in a `.ccbridge` side archive.

## Automatic discovery

Scan every built-in and loaded plugin adapter:

```bash
ccbridge scan
ccbridge scan --sessions --limit 10
ccbridge scan claude codex opencode --json
```

`scan` reports adapter installation/store state, discovery support, session counts, newest session time and per-adapter errors. One broken adapter does not stop the remaining scan. `--sessions` includes a bounded list of session summaries.

Individual discovery and inspection are still available:

```bash
ccbridge adapters
ccbridge doctor
ccbridge list claude
ccbridge inspect claude <session-id> --all
```

## Universal `.ccbridge` archive

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
ccbridge export antigravity <conversation-id> --output ./agy.ccbridge
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
```

`.ccbridge` v2 uses a manifest with integrity-checked entries for portable session data, raw events, native artifacts, companion files, attachments and provenance archives. Every entry records byte size and SHA-256. Older v1 archives remain readable.

## Privacy and encrypted archives

Lossless archives may contain credentials, file contents, environment data, raw tool output and provider-private reasoning. Create a shareable sanitized copy instead of editing the original:

```bash
ccbridge sanitize session.ccbridge \
  --output share.ccbridge \
  --redact-secrets \
  --exclude-env \
  --exclude-files
```

Sanitize never overwrites its source. When any privacy transform is requested, embedded native artifacts and provenance source archives are intentionally omitted because ccbridge cannot guarantee redaction inside arbitrary private DB/JSONL payloads. Native-only sessions such as the current Antigravity adapter are rejected instead of producing misleading empty sanitized archives.

Encrypt an archive with AES-256-GCM and a scrypt-derived key:

```bash
CCBRIDGE_PASSPHRASE='use-a-long-secret' \
  ccbridge encrypt share.ccbridge --output share.ccbridge.enc

CCBRIDGE_PASSPHRASE='use-a-long-secret' \
  ccbridge decrypt share.ccbridge.enc --output restored.ccbridge
```

For scripts, a private passphrase file can be used with `--passphrase-file`. Plaintext `--passphrase` arguments are intentionally unsupported so secrets do not land in shell history. Encrypted envelopes expose only cipher/KDF parameters and ciphertext, not session metadata.

## Attachments and media

Portable sessions can carry images, documents, audio and generic files. Byte-backed attachments are stored as separate integrity-checked archive entries.

Current support includes:

- Claude Code inline image/document content;
- Codex `input_image` and `input_audio` content;
- Gemini CLI `inlineData` and `fileData` references;
- OpenCode `file` parts and portable write/import via data URLs.

Remote URI references are preserved as references; ccbridge does not automatically download arbitrary remote URLs.

## Subagents and agent trees

`PortableSession` preserves child-agent history separately in `agents[]` rather than flattening it into fake root chat messages. Each agent can retain its own messages, raw events, metadata, parent identity and source transcript path.

Claude Code support includes `subagents/agent-<id>.jsonl`, workflow subagents, adjacent metadata, symlinked transcripts and subagent attachments. Subagent JSONLs are filtered out of the normal top-level Claude session list.

## Transfer examples

```bash
ccbridge transfer claude codex <session-id> --all
ccbridge transfer claude opencode <session-id>
ccbridge transfer codex opencode <session-id>
ccbridge transfer gemini opencode <session-id>
```

Antigravity is currently native-only, so semantic `antigravity -> codex/opencode` transfer is rejected rather than silently importing an empty conversation.

## Fork, merge and provenance

Universal archives can be branched and combined without overwriting their source history:

```bash
ccbridge fork ./session.ccbridge --output ./fork.ccbridge
ccbridge merge ./branch-a.ccbridge ./branch-b.ccbridge --output ./merged.ccbridge
```

Fork embeds the complete parent archive as provenance. Merge performs timeline/no-dedupe combination, namespaces colliding agent ids and embeds both complete source archives under `provenance/sources/`.

Recover a preserved source archive:

```bash
ccbridge extract-provenance merged.ccbridge \
  provenance/sources/left-branch-a.ccbridge \
  --output recovered.ccbridge
```

## Diff and verification

```bash
ccbridge diff before.ccbridge after.ccbridge --limit 50
ccbridge verify session.ccbridge --deep
ccbridge verify-transfer source.ccbridge opencode ses_123 --all
```

`diff` separates semantic session differences from archive entry/SHA-256 differences. `verify` checks archive integrity, PortableSession structure, tool call/result pairing, attachments, agent relationships and optional nested provenance. `verify-transfer` reads the actual target session and reports preservation percentages per feature, including reasoning/thinking when requested.

## Cross-platform cwd mapping

Windows and Linux are normal runtime targets. The bridge only maps the `cwd` used for target import; it does not rewrite archived provider payloads.

Automatic Windows/WSL conversion:

```bash
ccbridge transfer claude codex <session-id> --target-profile wsl --dry-run
ccbridge import ./session.ccbridge opencode --target-profile windows
```

Supported profiles are `native`, `windows`, `wsl`, and `linux`.

Explicit prefix mappings are repeatable and take priority over profile conversion:

```bash
ccbridge transfer claude opencode <session-id> \
  --map-cwd 'C:\Users\me\Projects=/home/me/projects'
```

## Fidelity and strict mode

```bash
ccbridge fidelity claude opencode <session-id> --all
ccbridge transfer <from> <to> <session> --strict-lossless
```

Normal `--all` can transfer representable data while preserving the rest in the `.ccbridge` archive. Strict mode blocks target mutation when known source features cannot be represented directly.

## External adapters

```bash
ccbridge adapters --plugin @example/ccbridge-agent
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge scan
```

See [docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md), [docs/ARCHIVE.md](docs/ARCHIVE.md), and [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

## Local stores

```text
Claude Code:      ~/.claude/projects/**/*.jsonl
Codex:            ~/.codex/sessions/**/*.jsonl
Gemini CLI:       ~/.gemini/tmp/**/chats/*.{json,jsonl}
Antigravity CLI:  ~/.gemini/antigravity-cli/conversations/*.db
ccbridge:         ~/.ccbridge/archives/*.ccbridge
```

Environment overrides include `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CCBRIDGE_ANTIGRAVITY_HOME`, `CCBRIDGE_HOME`, and `CCBRIDGE_PASSPHRASE`.

## Safety

Use `fidelity`, `plan`, `verify`, or `--dry-run` before mutation. Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content, attachments, subagent transcripts and local paths.

## Status

Early development. Native session formats can change; adapters should prefer official import/export interfaces and fail explicitly rather than guessing unsupported private schemas.
