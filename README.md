# ccbridge

Cross-agent local session bridge for coding assistants.

The project starts with Claude Code and OpenAI Codex, but the core is adapter-based and is designed for additional local agents without coupling them to Claude/Codex schemas.

## Repository layout

```text
packages/
  core/   reusable discovery, parsers, portable model, adapter registry, transfer engine
  cli/    command-line interface only
```

## Current support

| Adapter | Discover | Read | Import target |
| --- | --- | --- | --- |
| Claude Code | yes | yes | not yet |
| OpenAI Codex | yes | yes | Claude/external session via Codex app-server |

The Codex target uses `codex app-server` and `externalAgentConfig/import`; it does not write Codex SQLite state directly.

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
ccbridge inspect claude <session-id>
ccbridge transfer claude codex <session-id> --dry-run
ccbridge transfer claude codex <session-id>
```

A direct JSONL path is also accepted:

```bash
ccbridge transfer claude codex ~/.claude/projects/<project>/<session>.jsonl --cwd /path/to/project
```

## Local stores

Defaults:

```text
Claude Code: ~/.claude/projects/**/*.jsonl
Codex:       ~/.codex/sessions/**/*.jsonl
```

`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are respected.

Windows, Linux and WSL are treated as separate runtime profiles. The core includes path normalization helpers for Windows verbatim paths and Windows/WSL mount conversion.

## Portable model

Native session formats are parsed into a provider-neutral model containing visible text, tool calls and tool results. Provider-specific private reasoning/signatures are intentionally not transferred.

See [docs/ADAPTERS.md](docs/ADAPTERS.md) for the extension model.

## Safety

`transfer --dry-run` resolves the source and target route without modifying target session state. Use it before importing important sessions.

## Status

Early development. Native session formats are implementation details of their respective products and can change between releases.
