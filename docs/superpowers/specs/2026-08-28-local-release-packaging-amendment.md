# Local Release Packaging Amendment

**Date:** 2026-08-28  
**Applies to:** `2026-08-27-local-qualification-and-release-design.md` and `2026-08-27-local-qualification-and-release-v2.md`

This amendment supersedes only the ZIP implementation choice in design decision D19 and Task 6 steps that required `fflate@0.8.3`. All artifact names, entry order, exact-byte staging rules, SHA-256 verification rules, and publication invariants remain unchanged.

## Final ZIP implementation decision

Use the repository-owned `scripts/deterministic-zip.mjs` to emit a minimal deterministic **ZIP32 stored archive** (compression method 0) for exactly the three fixed plugin files.

The writer deliberately supports only the subset required by this release contract:

- 1..65535 entries,
- UTF-8 forward-slash relative entry names,
- ZIP32 file/offset limits,
- compression method 0 (stored, no compression),
- fixed DOS timestamp `1980-01-01 00:00:00`,
- host OS byte 0 / ZIP version 2.0,
- no extra fields, comments, data descriptors, encryption, ZIP64, or filesystem attributes,
- CRC-32 for every entry,
- exact caller-provided entry order.

`package-plugin.mjs` supplies exactly:

```text
obsidian-github-sync-multi-platform/main.js
obsidian-github-sync-multi-platform/manifest.json
obsidian-github-sync-multi-platform/styles.css
```

## Why this supersedes the library choice

The implementation no longer needs a new runtime/development dependency or a lockfile dependency-graph change. The binary surface is intentionally much smaller than a general ZIP implementation because the release archive has a fixed three-file contract and does not need compression.

The risk that originally motivated avoiding a hand-written general-purpose ZIP implementation is addressed by keeping this writer deliberately non-general and by testing the actual binary format rather than only snapshotting bytes.

## Required evidence

The implementation is acceptable only while all of these remain true:

1. CRC-32 matches the standard `123456789 -> 0xcbf43926` check vector.
2. Tests parse local and central directory records and verify method 0, names, entry order, bytes, and CRCs.
3. An independent ZIP implementation can open the generated archive; implementation verification on 2026-08-28 used Python `zipfile` successfully.
4. Static release inputs still come from exact `HEAD` blobs while `main.js` comes from the current build output.
5. Identical inputs produce byte-identical archives across tested time zones.
6. The upload asset manifest remains exactly the three loose plugin files plus the repository-named ZIP, with size and SHA-256 recorded for every asset.

If the release archive later needs compression, directories beyond the fixed root, ZIP64, permissions, symlinks, arbitrary file discovery, or other general ZIP behavior, this amendment no longer applies; adopt and pin a reviewed ZIP library instead of expanding the minimal writer casually.
