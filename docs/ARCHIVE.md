# Universal `.ccbridge` archive

A `.ccbridge` file is a versioned, reusable session archive for backup, migration and later restore without requiring the original agent store to still exist.

## Export

```bash
ccbridge export claude <session-id> --output ./session.ccbridge
```

Export defaults to `lossless` mode. Use `--mode portable` when only the normalized provider-neutral representation is required.

When the source adapter exposes a native session artifact, ccbridge embeds it in the archive in addition to the `PortableSession`. Companion files are supported as separate native entries; for example Antigravity SQLite `-wal` and `-shm` files are preserved alongside the main database.

## Archive v2

New exports use:

```text
format: ccbridge/session
version: 2
source
mode
manifest
entries
metadata
```

The logical entry layout is:

```text
portable/session.json   normalized PortableSession without duplicated raw events
raw/events.json         lossless provider/raw events
native/<filename>       optional original native session bytes
native/<companion>      optional WAL/SHM/other companion bytes
```

`manifest.entries` contains, for every entry:

```text
path
mediaType
encoding
bytes
sha256
```

The reader verifies entry path metadata, decoded byte length and SHA-256 before returning session data or materializing native files. A corrupted or internally inconsistent v2 archive is rejected before import.

The SHA-256 values provide integrity/corruption detection inside the archive. They are not a digital signature and do not prove who created the archive.

Lossless archives may contain prompts, thinking/reasoning, signatures, tool output, file contents, paths and unknown provider records. Archive files are written with restrictive permissions where supported.

## Import

```bash
ccbridge import ./session.ccbridge codex --cwd /path/to/project --dry-run
ccbridge import ./session.ccbridge codex --cwd /path/to/project
```

Import routing is generic:

1. If the archive contains an embedded native artifact and the target explicitly accepts that native format, ccbridge materializes a temporary private copy and uses the target native importer.
2. Otherwise, if the target implements `writePortableSession`, ccbridge imports the reconstructed `PortableSession`.
3. Otherwise the import fails explicitly without guessing a private target format.

Temporary materialized native files are removed after import.

## Backward compatibility

The reader continues to accept:

- `ccbridge/session` version 1 archives;
- the older `ccbridge/lossless-session` version 1 bundle.

Version 1 has no per-entry SHA-256 manifest. New exports should use version 2; legacy files are read in place and are not silently rewritten.
