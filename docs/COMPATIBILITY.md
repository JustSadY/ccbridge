# Adapter compatibility and schema drift

Coding-agent local session formats can change without being public/stable APIs. ccbridge therefore separates **installed product version evidence** from **observed session schema evidence**.

## Commands

Report the current contracts and detected product versions:

```bash
ccbridge compatibility
ccbridge compatibility claude
```

Probe a real session in lossless mode:

```bash
ccbridge compatibility claude <session-id>
ccbridge compatibility codex <session-id>
```

When a probed session contains an unknown source format, raw record kind, or portable content type, the command reports `drift-detected` and exits with status `4`.

An installed CLI version that is not explicitly listed in an adapter's `testedVersions` is reported as `unverified`. That alone is **not** schema drift and does not fail the command.

## Why versions are not enough

A product version can change while keeping the session format compatible, and a storage schema can change independently of a user-visible CLI version. ccbridge therefore probes the actual session representation when a session id is supplied.

A built-in compatibility contract can declare:

```js
{
  contractVersion: 1,
  sourceFormats: ["vendor/session-v1"],
  recordKinds: ["user", "assistant"],
  recordKindPrefixes: ["part:"],
  contentTypes: ["text", "tool-call", "tool-result"],
  preserveUnknownRecords: true,
  testedVersions: ["1.2.3"]
}
```

External adapters can expose the same object as `adapter.compatibility`.

## Unknown raw records

Lossless readers should preserve unfamiliar source records under `session.events[].data`. If a new raw record kind appears and `preserveUnknownRecords` is true, compatibility still reports drift so maintainers know semantic coverage may need work, while noting that the raw data remains preserved.

## Opaque formats

Some adapters, such as the current Antigravity SQLite adapter, intentionally treat the provider format as opaque/native-only. The compatibility report marks these as `opaque-native` rather than pretending ccbridge understands the private protobuf schema.

## CI usage

A fixture or known local test session can be used as a schema canary:

```bash
ccbridge compatibility claude "$CLAUDE_FIXTURE_SESSION"
```

Exit status `4` means schema drift was observed. Adapter unit fixtures should also exercise every source record/content form that the adapter claims to parse.
