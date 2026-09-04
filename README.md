# ccbridge

Cross-agent local session bridge for coding assistants.

`ccbridge` is provider-neutral: adapters discover, read, export, import or write sessions while the core plans compatible routes. Built-ins currently cover Claude Code, OpenAI Codex, Gemini CLI, OpenCode, Google Antigravity CLI, Aider, Cline, Roo Code, Continue, Cursor, VS Code Chat/GitHub Copilot, Goose, Pi Coding Agent and Kilo Code.

## Repository layout

```text
packages/
  core/   adapter SDK, discovery, portable/lossless model, archives, fidelity, route planner
  cli/    command-line interface only
```

## Current built-ins

| Adapter | Discover | Portable read | Lossless read | Portable write | Native route |
| --- | --- | --- | --- | --- | --- |
| Claude Code | yes | yes | yes | no | exports Claude session JSONL; Codex/Goose can import it |
| OpenAI Codex | yes | yes | yes | no | imports Claude JSONL via app-server; Goose can import Codex JSONL |
| Gemini CLI | yes | yes | yes | no | no target importer yet |
| OpenCode | yes | yes | yes | yes | official `export` / `import` JSON |
| Antigravity CLI | yes | no | native-only | no | SQLite + WAL/SHM lossless export |
| Aider | yes | yes | yes | no | Markdown history export/read |
| Cline | yes | yes | yes | no | canonical `messages.json` v1 export/read |
| Roo Code | yes | yes | yes | no | API history + UI/metadata companions |
| Continue | exported transcripts | yes | yes | no | official Markdown transcript read/export |
| Cursor | yes | yes | yes | no | agent transcript JSONL + subagent companions |
| VS Code Chat / GitHub Copilot | yes | yes | yes | no | open-source `.json` / mutation-log `.jsonl` chat store |
| Goose | yes | yes | yes | no | official CLI session export/import |
| Pi Coding Agent | yes | yes | yes | no | native session-tree JSONL; Goose can import it |
| Kilo Code | yes | yes | yes | yes | current official CLI JSON plus legacy Roo-compatible task store |

Codex imports use `codex app-server` / `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly. OpenCode, Goose and current Kilo use official CLI import/export surfaces instead of touching private databases. Roo Code is read/export-only because its upstream repository is archived. Continue uses the provider's explicit transcript export rather than assuming a private live-session store. Pi sessions are tree-structured: portable reads follow the active leaf/current compaction context while lossless mode preserves inactive branches as raw events. Kilo supports both the current CLI backend and older extension task files; current sessions are preferred, and ambiguous ids can be addressed with `current:<id>` or `legacy:<id>`.

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
ccbridge scan claude codex opencode cursor copilot goose pi kilo --json
```

`scan` reports adapter installation/store state, discovery support, session counts, newest session time and per-adapter errors. One broken adapter does not stop the remaining scan.

Individual discovery and inspection:

```bash
ccbridge adapters
ccbridge doctor
ccbridge list claude
ccbridge list cursor
ccbridge list copilot
ccbridge list goose
ccbridge list pi
ccbridge list kilo
ccbridge inspect pi <session-id> --all
ccbridge inspect kilo current:<session-id> --all
ccbridge inspect kilo legacy:<task-id> --all
```

## Compatibility / schema drift

```bash
ccbridge compatibility
ccbridge compatibility cursor <session-id>
ccbridge compatibility pi <session-id>
ccbridge compatibility kilo current:<session-id>
```

Built-in adapters have explicit format contracts. Unknown installed versions are reported as `unverified`; real source-format/content drift is reported separately and can return a non-zero status for automation. Lossless readers keep unfamiliar provider records so schema drift does not silently erase source data.

## Universal `.ccbridge` archive

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
ccbridge export cursor <session-id> --output ./cursor.ccbridge
ccbridge export copilot <session-id> --output ./copilot.ccbridge
ccbridge export goose <session-id> --output ./goose.ccbridge
ccbridge export pi <session-id> --output ./pi.ccbridge
ccbridge export kilo current:<session-id> --output ./kilo.ccbridge
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

Portable sessions can carry images, documents, audio and generic files. Byte-backed attachments are stored as separate integrity-checked archive entries. Current support includes Claude Code inline image/document content, Codex `input_image` / `input_audio`, Gemini CLI `inlineData` / `fileData`, OpenCode/Kilo file parts, Roo Anthropic-style image/document blocks, Goose image/document blocks and Pi image content. Remote URI references are preserved but not automatically downloaded.

## Subagents, branches and agent trees

`PortableSession` preserves child-agent history separately in `agents[]`. Claude Code support includes `subagents/agent-<id>.jsonl`, workflow subagents, adjacent metadata, symlinked transcripts and subagent attachments. Cursor supports `agent-transcripts/<session>/subagents/*.jsonl`.

Pi uses a different tree model inside one append-only JSONL. ccbridge finds the active leaf, walks `parentId` back to root, applies the latest compaction boundary for portable context, and retains every inactive branch/label/custom entry as raw lossless events.

## Transfer examples

```bash
ccbridge transfer claude codex <session-id> --all
ccbridge transfer claude opencode <session-id>
ccbridge transfer codex opencode <session-id>
ccbridge transfer gemini opencode <session-id>
ccbridge transfer cursor opencode <session-id> --all
ccbridge transfer copilot opencode <session-id> --all
ccbridge transfer pi opencode <session-id> --all

ccbridge transfer claude goose <session-id> --all
ccbridge transfer codex goose <session-id> --all
ccbridge transfer pi goose <session-id> --all

ccbridge transfer opencode kilo <session-id> --all
ccbridge transfer kilo opencode current:<session-id> --all
ccbridge transfer claude kilo <session-id> --all
```

Goose's official `session import` accepts Goose JSON plus Claude Code, Codex and Pi JSONL. These cross-provider native routes are intentionally not marked `strict-lossless`: provider-private fields remain protected by the `.ccbridge` side archive when `--all` is used. Goose JSON -> Goose is the only Goose native route currently advertised as a strict native-lossless import.

Current Kilo and OpenCode use the same export/import data family. Kilo accepts `kilo/session-json` and OpenCode-compatible session JSON; only Kilo-native JSON -> Kilo is marked strict native-lossless. Legacy Kilo task files are read/export-only because current Kilo does not provide a guaranteed lossless migration of that old task format.

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
ccbridge transfer pi opencode <session-id> \
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
Cursor:           ~/.cursor/projects/**/agent-transcripts/**/*.jsonl
VS Code Chat:     VS Code workspaceStorage/*/chatSessions/*.{json,jsonl}
Goose:            official `goose session list/export/import` CLI
Pi:               ~/.pi/agent/sessions/**/*.jsonl
Kilo current:     official `kilo session list`, `kilo export`, `kilo import` CLI; DB remains untouched
Kilo legacy:      VS Code globalStorage/kilocode.kilo-code/tasks/<id>/api_conversation_history.json
ccbridge:         ~/.ccbridge/archives/*.ccbridge
```

Important environment overrides include `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CCBRIDGE_ANTIGRAVITY_HOME`, `AIDER_CHAT_HISTORY_FILE`, `CCBRIDGE_AIDER_ROOTS`, `CCBRIDGE_ROO_HOME`, `CCBRIDGE_CONTINUE_ROOTS`, `CURSOR_AGENT_HOME`, `CCBRIDGE_VSCODE_CHAT_ROOTS`, `CCBRIDGE_GOOSE_EXPORT_ROOTS`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `CCBRIDGE_PI_SESSION_ROOTS`, `CCBRIDGE_KILO_LEGACY_HOME`, `CCBRIDGE_HOME`, and `CCBRIDGE_PASSPHRASE`.

## Safety

Use `fidelity`, `plan`, `verify`, or `--dry-run` before mutation. Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content, attachments, subagent transcripts, inactive branches and local paths.

## Status

Early development. Native session formats can change; adapters prefer official/versioned import/export interfaces and fail explicitly rather than guessing unsupported private schemas.
