# D246: First public release requires complete Re-encryption (owner choice B)

Date: 2026-11-03.

## Decision

The owner selected **B**: ship the first public stable release only when the core Sync engine **and** the full Re-encryption workflow are qualified. A Sync-only first release is **not** approved. Do not hide a preview-only Wizard or defer Re-encryption to a later version as a way around the acceptance gates.

The existing approved three-branch migration topology and plugin-private WAL storage policy stay unchanged. No physical power-cut certification is required; the agreed best-effort durability warnings and Manual Recovery apply where guarantees cannot be proved. This policy does **not** waive any of the six still-pending acceptance checks.

## Release boundary changes

`docs/release-gates/reencryption-wizard.json` now declares:

```json
"firstReleasePolicy": {
  "mode": "sync-and-reencryption-together",
  "syncOnlyReleaseAllowed": false
}
```

`scripts/reencryption-release-gate.mjs` checks these exact fields, rejects missing/extra/contradictory fields and keeps the existing requirement that `status` is `qualified` and **all seven named checks** are `passed` (migration topology is already passed; six are pending). This manifest represents owner policy and release acceptance declarations, not a substitute for installed-platform qualification evidence.

`scripts/local-release.mjs` already checked the Re-encryption gate before any stable release work. D246 also rechecks at each source/evidence boundary (before stable-tag creation, after stable-tag creation and before publishing a draft) and immediately after the final asynchronous release-asset verification, just before publishing the release. A late failed check stops publication, leaving any already-created tag/draft for manual inspection rather than deleting or auto-retrying it.

No GitHub remote mutation, tag creation, public release, forced ref update or GitHub Actions occurred during this change.

## Validation

`tests/feasibility/local-release.test.mjs` proves the actual current manifest remains blocked, rejects sync-only or missing/expanded first-release policy even when every acceptance check is artificially set to `passed`, and simulates gate revocation before stable-ref creation, before final draft publication and **during final asynchronous asset verification**. It confirms that no stable ref is created in the first case and no draft is published in the latter cases. Fully qualified synthetic fixtures still exercise the normal local release state machine without any live remote writes.

## What remains

All six Re-encryption release checks remain pending: safe preview and frozen backup, complete Re-encryption and integrity, interrupted migration and Manual Recovery, multi-device cutover/stale clients, Git history/old key disclosure, and installed native Desktop/Mobile acceptance. D246 **does not mark any of them passed**. Continue the owner-scoped joined D236 original-key/Backup and D239 WAL/Destination read-only proof, then a real end-to-end migration and cross-platform acceptance. The Wizard Run stays Preview-only until the complete feature is genuinely qualified.
