# Fork and merge

`ccbridge` forks and merges the universal `.ccbridge` representation rather than mutating private provider databases.

## Fork

```bash
ccbridge fork ./session.ccbridge --output ./fork.ccbridge
```

Optional fields:

```bash
ccbridge fork ./session.ccbridge \
  --id my-fork \
  --title "Experiment branch" \
  --output ./experiment.ccbridge
```

The fork receives a new portable session identity. The complete parent `.ccbridge` file is embedded under `provenance/sources/`, and a compatible embedded native artifact is retained when present. The output path is not allowed to overwrite the source archive.

## Merge

```bash
ccbridge merge ./branch-a.ccbridge ./branch-b.ccbridge \
  --output ./merged.ccbridge
```

Merge is intentionally conservative:

- root messages from both branches are retained;
- no common-prefix or content deduplication is performed;
- root events from both branches are retained;
- child agents from both branches are retained;
- agent ids are namespaced with `left:` and `right:` to avoid collisions;
- original agent ids and source identity remain in metadata;
- source session metadata and lossless descriptors are retained;
- cwd conflicts are recorded in merge metadata;
- the two complete source `.ccbridge` files are embedded byte-for-byte under `provenance/sources/`.

Because two providers can have incompatible native formats, a merge does not arbitrarily choose one source-native artifact as the merged native representation. The complete source archives remain recoverable instead.

## Recover a source archive

Inspect the merged archive entries, then extract a provenance source:

```bash
ccbridge extract-provenance ./merged.ccbridge \
  provenance/sources/left-branch-a.ccbridge \
  --output ./recovered-branch-a.ccbridge
```

Extraction refuses to overwrite the containing archive.

Fork/merge archives can contain the full sensitive contents of every source branch, including reasoning, tool output, files and subagent history. Store them accordingly.
