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

Codex imports use `codex app-server` / `externalAgentConfig/import`; ccbridge does not write Codex SQLite state directly. OpenCode uses its official `session list`, `export` and `import` CLI commands instead of touching its private database.

Antigravity currently has a conservative native-only adapter. It backs up `~/.gemini/antigravity-cli/conversations/<id>.db` together with `-wal` / `-shm` companions when present. Portable semantic decoding is intentionally disabled until a stable/versioned transcript decoder can be supported. See [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

## Install from source

```bash
npm install
npm test
npm link --workspace @ccbridge/cli
```

## Discovery and inspection

```bash
ccbridge adapters
ccbridge doctor

ccbridge list claude
ccbridge list codex
ccbridge list gemini
ccbridge list opencode
ccbridge list antigravity

ccbridge inspect claude <session-id>
ccbridge inspect claude <session-id> --all
ccbridge inspect antigravity <conversation-id> --all
```

`--all` is shorthand for `--mode lossless`.

## Universal `.ccbridge` archive

Export a reusable archive:

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
ccbridge export antigravity <conversation-id> --output ./agy.ccbridge
```

`export` defaults to lossless mode. An archive stores the normalized session plus the original native artifact when available. Native artifacts may contain companion files; Antigravity SQLite WAL/SHM files are embedded alongside the main DB.

Restore later, even if the original source session file is gone:

```bash
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
ccbridge import ./session.ccbridge codex --cwd /path/to/project
ccbridge import ./opencode.ccbridge opencode --cwd /path/to/project
```

Import routing prefers an explicitly compatible embedded native format, then falls back to `PortableSession` when the target provides a portable writer. See [docs/ARCHIVE.md](docs/ARCHIVE.md).

## Transfer examples

Claude Code can use Codex's native external-session importer:

```bash
ccbridge transfer claude codex <session-id> --dry-run
ccbridge transfer claude codex <session-id> --all
```

OpenCode is currently the first generic portable write target:

```bash
ccbridge transfer claude opencode <session-id>
ccbridge transfer codex opencode <session-id>
ccbridge transfer gemini opencode <session-id>
```

With `--all`, provider-private reasoning and raw events that cannot be represented directly in OpenCode remain preserved in the generated `.ccbridge` archive.

Antigravity is native-only today, so semantic `antigravity -> codex/opencode` transfer is deliberately rejected rather than silently importing an empty conversation.

## Fidelity report

Before migrating, inspect what the target can represent directly:

```bash
ccbridge fidelity claude opencode <session-id> --all
```

The report separates:

- direct target representation, such as visible text and supported tool history;
- provider-private or unknown data that is bundle-only;
- lossless archive preservation.

Native importer routes do not receive a made-up numeric fidelity score unless the adapter explicitly declares a lossless guarantee.

## Strict lossless mode

```bash
ccbridge transfer <from> <to> <session> --strict-lossless
```

`--strict-lossless` implies lossless reading and checks fidelity before target writes. If any known source feature cannot be represented directly, the transfer is blocked before mutation. A native route is accepted in strict mode only when the target adapter explicitly declares that native format as lossless.

This is intentionally stricter than `--all`: normal lossless mode can transfer representable data while keeping unsupported material in the `.ccbridge` archive; strict mode requires the target itself to represent everything known.

## Portable vs lossless

Portable mode focuses on interoperable history:

```text
visible text
historical tool calls
historical tool results
supported system context
```

Lossless mode additionally preserves source-private material where available:

```text
thinking / reasoning
signatures / opaque reasoning payloads
raw provider events
system / progress records
tool metadata
checkpoints / rewinds
unknown future records
native source artifacts
```

Provider-private reasoning is not blindly rewritten into another provider's reasoning schema. It remains available in the lossless archive when the target cannot safely represent it.

## External adapters

Third-party adapters can be loaded without modifying this repository:

```bash
ccbridge adapters --plugin @example/ccbridge-agent
ccbridge list example --plugin @example/ccbridge-agent
```

Multiple plugins can be supplied with repeated `--plugin` flags or:

```bash
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge adapters
```

See [docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md), [docs/ARCHIVE.md](docs/ARCHIVE.md), and [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

## Local stores

Built-in defaults:

```text
Claude Code:      ~/.claude/projects/**/*.jsonl
Codex:            ~/.codex/sessions/**/*.jsonl
Gemini CLI:       ~/.gemini/tmp/**/chats/*.{json,jsonl}
Antigravity CLI:  ~/.gemini/antigravity-cli/conversations/*.db
ccbridge:         ~/.ccbridge/archives/*.ccbridge
```

Environment overrides include:

```text
CLAUDE_CONFIG_DIR
CODEX_HOME
GEMINI_CLI_HOME
CCBRIDGE_ANTIGRAVITY_HOME
CCBRIDGE_HOME
```

Windows and Linux are supported runtime targets. Platform-specific logic is limited to storage/filesystem differences; the archive and transfer model are operating-system agnostic.

## Safety

Inspect before mutation:

```bash
ccbridge fidelity <from> <to> <session> --all
ccbridge plan <from> <to> <session>
ccbridge transfer <from> <to> <session> --dry-run
ccbridge import ./session.ccbridge <target> --dry-run
```

Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content and paths. They are written with restrictive permissions where supported.

## Status

Early development. Native session formats are implementation details of their respective products and can change between releases. Adapters should prefer official import/export interfaces and fail explicitly instead of guessing unsupported private schemas.
