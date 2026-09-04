# ccbridge

Cross-agent local session bridge for coding assistants.

Claude Code, OpenAI Codex and Gemini CLI are built-in adapters. The transfer engine itself is provider-neutral and is designed for additional agents such as Cursor, OpenCode, Aider and others.

## Repository layout

```text
packages/
  core/   adapter SDK, discovery, portable/lossless model, plugin loader, route planner
  cli/    command-line interface only
```

## Current built-ins

| Adapter | Discover | Read | Lossless read | Native import target |
| --- | --- | --- | --- | --- |
| Claude Code | yes | yes | yes | no |
| OpenAI Codex | yes | yes | yes | Claude Code session JSONL via Codex app-server |
| Gemini CLI | yes | yes | yes | no |

The Codex target uses `codex app-server` and `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly.

## Install from source

```bash
npm install
npm test
npm link --workspace @ccbridge/cli
```

Then:

```bash
ccbridge adapters
ccbridge doctor
ccbridge list claude
ccbridge list codex
ccbridge list gemini
ccbridge inspect claude <session-id>
ccbridge plan claude codex <session-id>
ccbridge transfer claude codex <session-id> --dry-run
```

## Universal `.ccbridge` archive

Export a reusable archive:

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
```

`export` defaults to lossless mode. The archive stores the `PortableSession` and, when the source adapter exposes one, embeds the original native session file as well.

Restore later, even if the original source session file no longer exists:

```bash
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
ccbridge import ./session.ccbridge codex --cwd /path/to/project
```

Import routing prefers an explicitly compatible embedded native format and falls back to `PortableSession` when the target implements a portable writer. See [docs/ARCHIVE.md](docs/ARCHIVE.md).

## Portable vs lossless

Portable mode is the default for inspect/transfer:

```bash
ccbridge inspect claude <session-id>
ccbridge transfer claude codex <session-id>
```

Lossless mode preserves source-private thinking/reasoning, raw events, signatures, system/progress records, tool metadata, checkpoints/rewinds and unknown records:

```bash
ccbridge inspect claude <session-id> --all
ccbridge transfer claude codex <session-id> --all
```

`--all` is shorthand for `--mode lossless`.

Lossless transfer sidecars are universal `.ccbridge` archives, so they can be reused for later import rather than acting as one-way backup JSON.

## External adapters

Third-party adapters can be loaded without modifying this repository:

```bash
ccbridge adapters --plugin @example/ccbridge-opencode
ccbridge list opencode --plugin @example/ccbridge-opencode
```

Multiple adapter packages can be loaded with repeated `--plugin` flags or with:

```bash
CCBRIDGE_PLUGINS=@example/ccbridge-opencode,./local-adapter.js ccbridge adapters
```

See [docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md), and [docs/ARCHIVE.md](docs/ARCHIVE.md).

## Local stores

Built-in defaults:

```text
Claude Code: ~/.claude/projects/**/*.jsonl
Codex:       ~/.codex/sessions/**/*.jsonl
Gemini CLI:  ~/.gemini/tmp/**/chats/*.{json,jsonl}
ccbridge:    ~/.ccbridge/archives/*.ccbridge
```

Environment overrides:

```text
CLAUDE_CONFIG_DIR
CODEX_HOME
GEMINI_CLI_HOME
CCBRIDGE_HOME
```

Windows and Linux are supported runtime targets. Platform-specific handling is limited to filesystem/storage differences; the session and transfer architecture are operating-system agnostic.

## Safety

Inspect a route before import:

```bash
ccbridge plan <from> <to> <session>
ccbridge transfer <from> <to> <session> --dry-run
ccbridge import ./session.ccbridge <target> --dry-run
```

Lossless archives can contain sensitive prompts, reasoning, tool output and file content. They are written with restrictive permissions where supported.

## Status

Early development. Native session formats are implementation details of their respective products and can change between releases.
