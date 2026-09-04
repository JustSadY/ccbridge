# Universal `.ccbridge` archive

A `.ccbridge` file is a versioned, reusable session archive. It is designed for backup, migration and later restore without requiring the original agent session store to still exist.

## Export

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
```

Export defaults to `lossless` mode. Use `--mode portable` when you only want the normalized provider-neutral representation.

When the source adapter exposes a native session artifact, ccbridge embeds that file as base64 inside the archive in addition to the `PortableSession`. This is important for targets with native importers, because the archive remains restorable even after the original `~/.claude`, `~/.codex`, or other source file is gone.

Archive v1 contains:

```text
format: ccbridge/session
version: 1
source
mode
session            # PortableSession, including lossless events when requested
nativeArtifact     # optional embedded original native session bytes
metadata
```

Lossless archives may contain prompts, thinking/reasoning, signatures, tool output, file contents, paths and unknown provider records. Archive files are written with restrictive permissions where supported.

## Import

```bash
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
ccbridge import ./session.ccbridge codex --cwd /path/to/project
```

Import routing is generic:

1. If the archive contains an embedded native artifact and the target explicitly accepts that native format, ccbridge materializes a temporary private copy and uses the target native importer.
2. Otherwise, if the target implements `writePortableSession`, ccbridge imports the stored `PortableSession`.
3. Otherwise the import fails explicitly without guessing a private target format.

Temporary materialized native files are removed after import.

## Legacy bundle compatibility

The reader accepts the previous `ccbridge/lossless-session` v1 JSON bundle and normalizes it to the universal archive model. Legacy bundles do not contain embedded native bytes, so restore options may be more limited than newly exported `.ccbridge` files.
