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

## Portable vs lossless

`ccbridge` has two read/transfer modes.

### Portable (default)

```bash
ccbridge inspect claude <session-id>
ccbridge transfer claude codex <session-id>
```

Portable mode keeps normalized conversation text, tool calls and tool results. Provider-private reasoning/thinking is not exposed in this mode.

### Lossless

```bash
ccbridge inspect claude <session-id> --mode lossless
ccbridge inspect codex <session-id> --all
ccbridge inspect gemini <session-id> --all

ccbridge transfer claude codex <session-id> --all --dry-run
ccbridge transfer claude codex <session-id> --all
```

`--all` is shorthand for `--mode lossless`.

Lossless mode preserves all JSON session records that the source adapter can read, including provider thinking/reasoning payloads, signatures or opaque reasoning fields, system/progress records, metadata updates, rewinds, tool metadata and unknown event types.

Provider-specific reasoning is never blindly rewritten into another provider's native reasoning field. Those fields may be signed, encrypted or schema-validated. Instead, ccbridge passes through whatever the target natively supports and writes a lossless sidecar bundle containing the complete source representation.

Default bundle location:

```text
~/.ccbridge/lossless/*.ccbridge.json
```

Override the path:

```bash
ccbridge transfer claude codex <session-id> \
  --all \
  --bundle ./session-backup.ccbridge.json
```

Lossless bundles can contain sensitive prompts, reasoning, tool output, file contents, paths, signatures and other provider data. They are created with restrictive file permissions where the operating system supports them.

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

See [docs/ADAPTERS.md](docs/ADAPTERS.md) for the adapter/plugin contract and [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md) for the interchange/lossless model.

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

In lossless mode, the source is additionally read into a lossless `PortableSession` and persisted as a ccbridge bundle after a successful transfer. A native import therefore does not have to understand every source-private event for the original data to remain recoverable.

## Local stores

Built-in defaults:

```text
Claude Code: ~/.claude/projects/**/*.jsonl
Codex:       ~/.codex/sessions/**/*.jsonl
Gemini CLI:  ~/.gemini/tmp/**/chats/*.{json,jsonl}
ccbridge:    ~/.ccbridge/lossless/*.ccbridge.json
```

Environment overrides are respected:

```text
CLAUDE_CONFIG_DIR
CODEX_HOME
GEMINI_CLI_HOME  # home root; Gemini state is under <GEMINI_CLI_HOME>/.gemini
CCBRIDGE_HOME    # ccbridge bundle/config root
```

Windows and Linux are supported runtime targets. Platform-specific handling is limited to filesystem/storage differences; the session and transfer architecture are operating-system agnostic.

## Safety

Use either command to inspect the route before an import:

```bash
ccbridge plan <from> <to> <session>
ccbridge transfer <from> <to> <session> --dry-run
```

For lossless transfers:

```bash
ccbridge plan <from> <to> <session> --all
ccbridge transfer <from> <to> <session> --all --dry-run
```

## Status

Early development. Native session formats are implementation details of their respective products and can change between releases.
