# ccbridge

Cross-agent local session bridge for coding assistants.

Claude Code, OpenAI Codex and Gemini CLI are built-in adapters. The transfer engine itself is provider-neutral and is designed for additional agents such as Cursor, OpenCode, Aider and others.

## Repository layout

```text
packages/
  core/   adapter SDK, discovery, portable model, plugin loader, route planner
  cli/    command-line interface only
```

## Current built-ins

| Adapter | Discover | Read | Native import target |
| --- | --- | --- | --- |
| Claude Code | yes | yes | no |
| OpenAI Codex | yes | yes | Claude Code session JSONL via Codex app-server |
| Gemini CLI | yes | yes | no |

The Codex target uses `codex app-server` and `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly.

Gemini CLI support currently reads its project-scoped recorded sessions, including JSONL metadata updates and rewind records. Provider-private `thoughts` are intentionally excluded from the portable model.

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
ccbridge inspect gemini <session-id>
ccbridge plan claude codex <session-id>
ccbridge transfer claude codex <session-id> --dry-run
ccbridge transfer claude codex <session-id>
```

A direct JSONL path is also accepted by adapters that expose native session files:

```bash
ccbridge transfer claude codex ~/.claude/projects/<project>/<session>.jsonl --cwd /path/to/project
```

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

See [docs/ADAPTERS.md](docs/ADAPTERS.md) for the adapter/plugin contract and [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md) for the interchange model.

## Transfer routing

Transfers are planned generically:

```text
source adapter
    |
    +-- compatible native format --> target native importer
    |
    +-- PortableSession -----------> target portable writer
    |
    `-- no compatible route -------> explicit error
```

Native import is selected only when the target explicitly accepts the source artifact format. This avoids accidental cross-imports between unrelated agents.

## Local stores

Built-in defaults:

```text
Claude Code: ~/.claude/projects/**/*.jsonl
Codex:       ~/.codex/sessions/**/*.jsonl
Gemini CLI:  ~/.gemini/tmp/**/chats/*.{json,jsonl}
```

Environment overrides are respected:

```text
CLAUDE_CONFIG_DIR
CODEX_HOME
GEMINI_CLI_HOME  # home root; Gemini state is under <GEMINI_CLI_HOME>/.gemini
```

Individual adapters may also accept explicit home/config paths through the core API.

Windows and Linux are supported runtime targets. Platform-specific handling is limited to filesystem/storage differences; the portable session and transfer architecture are operating-system agnostic.

## Portable model

Native session formats are parsed into a provider-neutral model containing visible text, tool calls and tool results. Provider-specific private reasoning/signatures are intentionally not transferred.

## Safety

Use either command to inspect the route before an import:

```bash
ccbridge plan <from> <to> <session>
ccbridge transfer <from> <to> <session> --dry-run
```

## Status

Early development. Native session formats are implementation details of their respective products and can change between releases.
