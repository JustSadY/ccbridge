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

`.ccbridge` v2 uses a manifest with integrity-checked entries for portable session data, raw events, native artifacts, companion files and attachments. Every entry records byte size and SHA-256. Older v1 archives remain readable.

## Attachments and media

Portable sessions can carry images, documents, audio and generic files. Byte-backed attachments are stored as separate integrity-checked archive entries.

Current support includes:

- Claude Code inline image/document content;
- Codex `input_image` and `input_audio` content;
- Gemini CLI `inlineData` and `fileData` references;
- OpenCode `file` parts and portable write/import via data URLs.

Remote URI references are preserved as references; ccbridge does not automatically download arbitrary remote URLs.

## Transfer examples

```bash
ccbridge transfer claude codex <session-id> --all
ccbridge transfer claude opencode <session-id>
ccbridge transfer codex opencode <session-id>
ccbridge transfer gemini opencode <session-id>
```

Antigravity is currently native-only, so semantic `antigravity -> codex/opencode` transfer is rejected rather than silently importing an empty conversation.

## Cross-platform cwd mapping

Windows and Linux are normal runtime targets. The bridge only maps the `cwd` used for target import; it does not rewrite archived provider payloads.

Automatic Windows/WSL conversion:

```bash
ccbridge transfer claude codex <session-id> \
  --target-profile wsl \
  --dry-run

ccbridge import ./session.ccbridge opencode \
  --target-profile windows
```

Supported profiles:

```text
native
windows
wsl
linux
```

Explicit prefix mappings are repeatable and take priority over profile conversion:

```bash
ccbridge transfer claude opencode <session-id> \
  --map-cwd 'C:\Users\me\Projects=/home/me/projects'
```

Example mapping:

```text
C:\Users\me\Projects\ccbridge
→ /home/me/projects/ccbridge
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
CCBRIDGE_PLUGINS=@example/a,./local-adapter.js ccbridge adapters
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

Environment overrides include `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `CCBRIDGE_ANTIGRAVITY_HOME`, and `CCBRIDGE_HOME`.

## Safety

Use `fidelity`, `plan`, or `--dry-run` before mutation. Lossless archives can contain sensitive prompts, reasoning, signatures, tool output, file content, attachments and local paths.

## Status

Early development. Native session formats can change; adapters should prefer official import/export interfaces and fail explicitly rather than guessing unsupported private schemas.
