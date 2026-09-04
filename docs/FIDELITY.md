# Transfer fidelity and preservation classes

ccbridge separates **what the target agent receives** from **what the side archive preserves**. A `.ccbridge` archive can retain the complete source material even when the destination agent cannot represent every source-private field.

## Target preservation classes

### `exact`

Use `exact` only when the target import contract has been audited and is known to preserve the native artifact without changing semantically relevant session state.

An exact claim must cover the provider data that matters to resuming the session, including conversation/tool/reasoning payloads and relevant session identity/context metadata. Merely accepting the same file format is not enough.

Adapters can declare an audited exact format with the legacy-compatible field:

```js
losslessNativeImports = ["vendor/session-json"];
```

or an explicit preservation declaration:

```js
nativeImportPreservation = {
  "vendor/session-json": "exact"
};
```

Explicit `nativeImportPreservation` wins over the legacy list.

### `remapped`

Use `remapped` when the provider's own native importer retains the conversation/message/part payload but intentionally creates or rewrites target-owned session context such as:

- session id
- project id
- cwd / directory / path
- session type
- indexing or target-local ownership metadata

Known examples in the current built-ins are OpenCode, Kilo Code and Goose self-import. Their official importers preserve substantial native conversation data but create or remap destination state, so ccbridge does not call them exact.

```js
nativeImportPreservation = {
  "vendor/session-json": "remapped"
};
```

### `best-effort`

Use `best-effort` when a native/official importer accepts the source format, but ccbridge cannot prove an exact or well-bounded remapped round-trip.

Cross-provider native importers normally start here. For example, an importer may understand another provider's transcript but legitimately omit provider-private reasoning signatures, unknown records, hidden metadata, branches, or unsupported content blocks.

This is the default for a native format without an explicit preservation declaration.

### `portable`

`portable` means ccbridge normalized the source into `PortableSession` and the target used `writePortableSession()`.

Portable fidelity is measured per feature from the actual session. A portable transfer can be 100% for a simple text-only session while being incomplete for another session containing reasoning, attachments, raw events or provider-specific metadata.

## Side archive is a separate axis

In lossless mode (`--all`), ccbridge writes a `.ccbridge` side archive when the source supplies a lossless representation. This archive can preserve provider-private records that the destination cannot represent.

Therefore these are different statements:

```text
targetClass = remapped
sideArchive = true
overallClass = remapped+side-archive
```

and:

```text
targetClass = best-effort
sideArchive = true
overallClass = best-effort+side-archive
```

`sideArchive = true` never upgrades target fidelity to `exact`.

## Strict lossless

`--strict-lossless` mutates the target only when ccbridge can prove a 100% target representation route.

The decision order is:

1. Use an `exact` native import when available.
2. If the native importer is `remapped` or `best-effort`, evaluate an available portable writer against the actual lossless source session.
3. If every observed source feature is representable by the portable target, use the portable route instead of the non-exact native route.
4. Otherwise block before target mutation.

This means a static route can report:

```text
route: native
native preservation: remapped
strict: session-dependent
```

because normal transfers prefer the native route, while strict mode may switch to an exact-for-that-session portable representation.

If no portable target writer exists, a non-exact native route is `strict: unavailable`.

## Adapter author rules

Do not mark a native importer exact because:

- source and target are the same product;
- export and import commands use the same JSON extension;
- messages appear visually identical after import;
- the provider calls its export a backup.

Audit the import implementation or test a round-trip that covers identity/context metadata, message/tool data, reasoning/private blocks, attachments, branches/subagents and unknown provider records relevant to that format.

When uncertain, use `remapped` for a known bounded context rewrite or leave the format at the default `best-effort`.

## Inspecting routes

```bash
ccbridge routes
ccbridge routes opencode opencode --json
ccbridge routes pi goose --json
ccbridge fidelity <source> <target> <session> --all
ccbridge transfer <source> <target> <session> --strict-lossless --dry-run
```

`routes` is static and does not inspect session contents. `fidelity` and strict transfer planning inspect the actual session and can therefore make feature-level decisions.
