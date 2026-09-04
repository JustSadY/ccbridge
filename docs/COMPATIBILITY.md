# Adapter compatibility and schema drift

Coding-agent local session formats can change without being public/stable APIs. ccbridge therefore separates **installed product version evidence** from **observed session schema evidence**.

## Commands

Report the current contracts and detected product versions:

```bash
ccbridge compatibility
ccbridge compatibility claude
ccbridge compatibility qwen
```

Probe a real session in lossless mode:

```bash
ccbridge compatibility claude <session-id>
ccbridge compatibility codex <session-id>
ccbridge compatibility qwen <session-id>
```

When a probed session contains an unknown source format, raw record kind, or portable/lossless content type, the command reports `drift-detected` and exits with status `4`.

An installed CLI version that is not explicitly listed in an adapter's `testedVersions` is reported as `unverified`. That alone is **not** schema drift and does not fail the command.

## Why versions are not enough

A product version can change while keeping the session format compatible, and a storage schema can change independently of a user-visible CLI version. ccbridge therefore probes the actual session representation when a session id is supplied.

A built-in compatibility contract can declare:

```js
{
  contractVersion: 1,
  sourceFormats: ["vendor/session-v1"],
  recordKinds: ["record:user", "record:assistant", "record:system"],
  recordKindPrefixes: ["part:"],
  recordKindSuffixes: [":known-system-subtype"],
  contentTypes: ["text", "tool-call", "tool-result"],
  preserveUnknownRecords: true,
  testedVersions: ["1.2.3"]
}
```

External adapters can expose the same object as `adapter.compatibility`.

`recordKindSuffixes` are constrained by a known base record kind. For example, with `record:system` plus `:custom_title`, `record:system:custom_title` can be known while `record:future:custom_title` still counts as drift. This prevents a familiar subtype name from hiding a new physical record type.

## Unknown raw records and content

Lossless readers should preserve unfamiliar source records under `session.events[].data`. If a new raw record kind appears and `preserveUnknownRecords` is true, compatibility still reports drift so maintainers know semantic coverage may need work, while noting that the raw data remains preserved.

The same principle applies to unfamiliar content blocks. A lossless adapter may retain the complete provider block as a provider-specific content item instead of dropping it. Compatibility then reports the unfamiliar content type as drift while the original data remains available in the `.ccbridge` archive.

## Qwen Code example

Qwen Code is tree-structured and compression-aware. Its compatibility probe follows the active `parentUuid` chain, applies the current `chat_compression` resume context, and also inspects lossless raw records and subagents.

The current Qwen GenAI compatibility layer recognizes `text`, `functionCall`, `functionResponse`, `inlineData`, `fileData`, `videoMetadata`, `executableCode`, and `codeExecutionResult` Part shapes. ccbridge therefore treats its mapped lossless forms such as `qwen-executable-code`, `qwen-code-execution-result`, and `qwen-video-metadata` as **known Qwen schema**, not drift.

That does not mean every target can represent those provider-specific blocks. Source compatibility and target fidelity are separate checks:

```text
known Qwen executableCode
        |
        +-- compatibility: schema-known
        |
        +-- portable target lacks an equivalent: fidelity reports unknownContent
            and strict-lossless blocks that target route
```

A genuinely new Qwen Part shape is preserved as `qwen-unknown` in lossless mode and causes `ccbridge compatibility qwen <session-id>` to report `drift-detected`.

## Opaque formats

Some adapters, such as the current Antigravity SQLite adapter, intentionally treat the provider format as opaque/native-only. The compatibility report marks these as `opaque-native` rather than pretending ccbridge understands the private protobuf schema.

## CI usage

A fixture or known local test session can be used as a schema canary:

```bash
ccbridge compatibility claude "$CLAUDE_FIXTURE_SESSION"
ccbridge compatibility qwen "$QWEN_FIXTURE_SESSION"
```

Exit status `4` means schema drift was observed. Adapter unit fixtures should also exercise every source record/content form that the adapter claims to parse.
