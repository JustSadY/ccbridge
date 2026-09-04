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
```

## Universal `.ccbridge` archive

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
ccbridge export antigravity <conversation-id> --output ./agy.ccbridge
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
```

`.ccbridge` v2 uses integrity-checked entries for portable session data, raw events, native artifacts, companion files and attachments. Every entry records byte size and SHA-256. Older v1 archives remain readable.

## Attachments and media

Current support includes Claude inline image/document content, Codex `input_image` / `input_audio`, Gemini `inlineData` / `fileData`, and OpenCode `file` parts. Byte-backed assets are preserved inside `.ccbridge`; arbitrary remote URLs are not downloaded automatically.

## Cross-platform cwd mapping

```bash
ccbridge transfer claude codex <session-id> --target-profile wsl --dry-run
ccbridge import ./session.ccbridge opencode --target-profile windows

ccbridge transfer claude opencode <session-id> \
  --map-cwd 'C:\Users\me\Projects=/home/me/projects'
```

Supported profiles are `native`, `windows`, `wsl`, and `linux`. Explicit prefix mappings take priority over automatic Windows/WSL drive conversion. Only target cwd is changed; archived raw provider payloads remain unchanged.

## Fidelity and strict mode

```bash
ccbridge fidelity claude opencode <session-id> --all
ccbridge transfer <from> <to> <session> --strict-lossless
```

Normal `--all` mode may transfer representable data while preserving the remainder in the archive. Strict mode blocks mutation if known source features cannot be represented directly by the target.

## External adapters

```bash
ccbridge adapters --plugin @example/ccbridge-agent
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge adapters
```

See [docs/ADAPTERS.md](docs/ADAPTERS.md), [docs/PORTABLE_SESSION.md](docs/PORTABLE_SESSION.md), [docs/ARCHIVE.md](docs/ARCHIVE.md), and [docs/ANTIGRAVITY.md](docs/ANTIGRAVITY.md).

## Safety

Use `fidelity`, `plan`, or `--dry-run` before mutation. Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content, attachments and local paths.

## Status

Early development. Native formats can change; adapters should prefer official import/export interfaces and fail explicitly rather than guessing unsupported private schemas.
