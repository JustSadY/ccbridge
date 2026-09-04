# ccbridge

Cross-agent local session bridge for coding assistants.

`ccbridge` is provider-neutral: adapters discover, read, export, import or write sessions while the core plans compatible routes. Built-ins currently cover Claude Code, OpenAI Codex, Gemini CLI, OpenCode, Google Antigravity CLI, Aider, Cline, Roo Code and Continue exports.

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
| Antigravity CLI | yes | no | native-only | no | SQLite + WAL/SHM lossless export |
| Aider | yes | yes | yes | no | Markdown history export/read |
| Cline | yes | yes | yes | no | canonical `messages.json` v1 export/read |
| Roo Code | yes | yes | yes | no | API history + UI/metadata companions |
| Continue | exported transcripts | yes | yes | no | official Markdown transcript read/export |

Codex imports use `codex app-server` / `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly. OpenCode uses its official CLI import/export surface instead of touching its private database. Roo Code is read/export-only because its upstream repository is archived; Continue uses the provider's explicit transcript export rather than assuming a private live-session store.

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

```bash
ccbridge scan
ccbridge scan --sessions --limit 10
ccbridge scan claude codex opencode aider cline roo continue --json
```

`scan` reports adapter installation/store state, discovery support, session counts, newest session time and per-adapter errors. One broken adapter does not stop the remaining scan.

Individual discovery and inspection:

```bash
ccbridge adapters
ccbridge doctor
ccbridge list claude
ccbridge list aider
ccbridge list cline
ccbridge list roo
ccbridge list continue
ccbridge inspect claude <session-id> --all
```

## Compatibility / schema drift

```bash
ccbridge compatibility
ccbridge compatibility cline <session-id>
ccbridge compatibility roo <task-id>
```

Built-in adapters have explicit format contracts. Unknown installed versions are reported as `unverified`; real source-format/content drift is reported separately and can return a non-zero status for automation.

## Universal `.ccbridge` archive

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
ccbridge export cline <session-id> --output ./cline.ccbridge
ccbridge export roo <task-id> --output ./roo.ccbridge
ccbridge export continue <exported-session> --output ./continue.ccbridge
ccbridge export antigravity <conversation-id> --output ./agy.ccbridge
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
```

`.ccbridge` v2 uses a manifest with integrity-checked entries for portable session data, raw events, native artifacts, companion files, attachments and provenance archives. Every entry records byte size and SHA-256. Older v1 archives remain readable.

## Privacy and encrypted archives

```bash
ccbridge sanitize session.ccbridge \
  --output share.ccbridge \
  --redact-secrets \
  --exclude-env \
  --exclude-files

CCBRIDGE_PASSPHRASE='use-a-long-secret' \
  ccbridge encrypt share.ccbridge --output share.ccbridge.enc

CCBRIDGE_PASSPHRASE='use-a-long-secret' \
  ccbridge decrypt share.ccbridge.enc --output restored.ccbridge
```

Sanitize never overwrites its source. Embedded native/provenance payloads are omitted when privacy transforms are requested because arbitrary private formats cannot be safely redacted. Native-only sessions are rejected instead of producing misleading empty sanitized archives. Encryption uses AES-256-GCM with a scrypt-derived key; plaintext `--passphrase` CLI arguments are intentionally unsupported.

## Attachments and media

Portable sessions can carry images, documents, audio and generic files. Byte-backed attachments are stored as separate integrity-checked archive entries. Current support includes Claude Code inline image/document content, Codex `input_image` / `input_audio`, Gemini CLI `inlineData` / `fileData`, OpenCode file parts, and Roo Anthropic-style image/document blocks. Remote URI references are preserved but not automatically downloaded.

## Subagents and agent trees

`PortableSession` preserves child-agent history separately in `agents[]`. Claude Code support includes `subagents/agent-<id>.jsonl`, workflow subagents, adjacent metadata, symlinked transcripts and subagent attachments.

## Transfer examples

```bash
ccbridge transfer claude codex <session-id> --all
ccbridge transfer claude opencode <session-id>
ccbridge transfer codex opencode <session-id>
ccbridge transfer gemini opencode <session-id>
ccbridge transfer aider opencode <session-id> --all
ccbridge transfer cline opencode <session-id> --all
ccbridge transfer roo opencode <task-id> --all
ccbridge transfer continue opencode <exported-session> --all
```

Antigravity is currently native-only, so semantic `antigravity -> codex/opencode` transfer is rejected rather than silently importing an empty conversation.

## Fork, merge, diff and verification

```bash
ccbridge fork ./session.ccbridge --output ./fork.ccbridge
ccbridge merge ./branch-a.ccbridge ./branch-b.ccbridge --output ./merged.ccbridge
ccbridge diff before.ccbridge after.ccbridge --limit 50
ccbridge verify session.ccbridge --deep
ccbridge verify-transfer source.ccbridge opencode ses_123 --all
```

Fork embeds the complete parent archive as provenance. Merge keeps both branches without semantic deduplication and embeds both complete source archives. `diff` separates semantic differences from archive entry/SHA-256 differences. `verify-transfer` reports preservation percentages per feature, including reasoning/thinking when requested.

## Cross-platform cwd mapping

Windows and Linux are normal runtime targets. The bridge maps only the `cwd` used for target import; archived provider payloads remain unchanged.

```bash
ccbridge transfer claude codex <session-id> --target-profile wsl --dry-run
ccbridge import ./session.ccbridge opencode --target-profile windows
ccbridge transfer claude opencode <session-id> \
  --map-cwd 'C:\Users\me\Projects=/home/me/projects'
```

Supported profiles are `native`, `windows`, `wsl`, and `linux`.

## Fidelity and strict mode

```bash
ccbridge fidelity claude opencode <session-id> --all
ccbridge transfer <from> <to> <session> --strict-lossless
```

Normal `--all` transfers representable data while preserving the rest in the `.ccbridge` archive. Strict mode blocks target mutation when known source features cannot be represented directly.

## Persistent and one-off plugins

```bash
ccbridge plugins add @example/ccbridge-agent
ccbridge plugins list
ccbridge plugins disable @example/ccbridge-agent
ccbridge plugins remove @example/ccbridge-agent

ccbridge adapters --plugin ./local-adapter.js
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge scan
```

Persistent plugins are stored under `CCBRIDGE_HOME/plugins.json`. Plugin management does not run npm/pnpm automatically. Plugins are executable code; only load modules you trust.

See [docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md), [docs/ARCHIVE.md](docs/ARCHIVE.md), [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), and [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

## Local stores / source artifacts

```text
Claude Code:      ~/.claude/projects/**/*.jsonl
Codex:            ~/.codex/sessions/**/*.jsonl
Gemini CLI:       ~/.gemini/tmp/**/chats/*.{json,jsonl}
Antigravity CLI:  ~/.gemini/antigravity-cli/conversations/*.db
Aider:            .aider.chat.history.md (or AIDER_CHAT_HISTORY_FILE)
Cline:            ~/.cline/data/sessions/<id>/<id>.messages.json
Roo Code:         VS Code globalStorage/.../tasks/<id>/api_conversation_history.json
Continue:         ~/.continue/*_session.md (explicit exported transcripts)
ccbridge:         ~/.ccbridge/archives/*.ccbridge
```

Important environment overrides include `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CCBRIDGE_ANTIGRAVITY_HOME`, `AIDER_CHAT_HISTORY_FILE`, `CCBRIDGE_AIDER_ROOTS`, `CCBRIDGE_ROO_HOME`, `CCBRIDGE_CONTINUE_ROOTS`, `CCBRIDGE_HOME`, and `CCBRIDGE_PASSPHRASE`.

## Safety

Use `fidelity`, `plan`, `verify`, or `--dry-run` before mutation. Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content, attachments, subagent transcripts and local paths.

## Status

Early development. Native session formats can change; adapters prefer official/versioned import/export interfaces and fail explicitly rather than guessing unsupported private schemas.
