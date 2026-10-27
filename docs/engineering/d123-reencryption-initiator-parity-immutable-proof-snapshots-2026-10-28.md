# D123 — Freeze authenticated source and physical inventory evidence during initiating-vault parity

Date: 2026-10-28. **Read-only pre-cutover parity hardening; Re-encryption Wizard remains RELEASE BLOCKED.**

## Two verified false-positive conditions (RED before fixes)

The D105/D107 two-pass parity verifier compares physical initiating-vault SHA-256 hashes with the authenticated, pinned Git source inventory and re-enumerates the local file list between and after the two hash passes. It originally kept **caller-owned object references** for both sides of the proof.

1. **Authenticated source record mutation:** The verifier validated source records and constructed a `Map` before the first asynchronous fence, but mapped the original `V4IndexFileRecord` references directly. During `await reader.listFiles()`, a callback can mutate an original record's `plaintextSha256` while also changing the local note bytes to the new hash with identical size and mtime. The later hash compares against the **mutated hash**, not the SHA from the authenticated source preflight. A new regression reproduced an incorrect successful parity report on unpatched code (Missing expected rejection).
2. **Reused physical inventory metadata:** The verifier likewise saved the original `V4InitiatingFile` objects from `listFiles()` in its `start`, `between` and `end` snapshots. An adapter can reuse one mutable metadata object across all scans. If the physical file changes after the second SHA pass but immediately before the final inventory result, and its shared metadata object is updated in place, `start` changes retroactively too. Thus `assertSameInventory(start,end)` incorrectly sees equal size and mtime. A second regression reproduced this false-success condition before the fix.

Both are **test-only deterministic async fault injections** using the same read-only verifier API and do not require a malicious filesystem, GitHub access, or real user Vault changes. They demonstrate that static TypeScript `readonly` does not freeze runtime objects received from callers.

## Runtime changes

In `src/lib/v4/reencryption-initiator-parity.ts`:

- Capture and freeze a **shallow value copy of each authenticated source record** and of `verifiedSource` synchronously **before the first await**. The verifier uses those captured primitives (path, size, SHA, authenticated totals) in both hash passes. Mutating the caller's original remote index record cannot redefine the accepted cryptographic source hash mid-scan.
- For every local `listFiles()` call, capture a new frozen `{path,size,mtime}` object rather than retaining caller-owned entries. This makes the start/intermediate/end inventory comparisons compare the metadata actually sampled at those times, even if the reader reuses mutable objects internally.
- Preserve the two full SHA-256 passes, strict source path/scope validation, D122 unsaved-editor refusal, on-every-file live guard checks and `initiatorLocalCutoverAuthorized:false`. No edits to Vault files, branch selection, credentials, key material or local index, and no new cutover permission.

## Regression and verification

Two cases were added to `tests/v4/reencryption-initiator-parity.test.ts`, and **both failed under prior behavior** before the relevant fix, then passed with the immutable snapshots. Focused initiator parity **12/12 PASS**. Full Fast **926/926**, Fast repeat **10×926/926** (exit 0, no failures), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript, Production Build, GitHub E2E compile-only (3 bundles) and package/metadata validation PASS. Bounded cryptographic Soak **100,000,000 bytes / 12 chunks / 2 parts** PASS; full SHA-256 matched the independently calculated reference.

These snapshots prevent **object-aliasing false proofs**; they do **not** lock Vault files on disk. An external process could still replace same-size/same-mtime files after the final hash and inventory guard without an OS-wide write fence or true filesystem snapshot. The released UI must not claim automatic writer protection.

## Production policy and hard blockers unchanged

Owner-approved D90/D91 three branches in one repository: independent writable old Source, frozen Backup at pinned old-source SHA, zero-parent orphan encrypted new-key Destination. Initiating client only may eventually execute a crash-safe Branch/Passphrase/Index cutover, subject to separate permission. Other devices must switch manually; no automatic old branch deletion, force migration, GitHub Actions or Native Helper promotion. Windows pure-Node WAL directory `fsync EPERM` still blocks actual sudden-power-loss durability. Full OS-wide Vault writing fence, crash-safe initiating-only cutover/new-key provenance and recovery, numeric `GITHUB_E2E_EXPECTED_REPO_ID` pinned live same-repo GitHub qualification and installed multi-device Windows/mobile acceptance remain pending. Re-encryption Wizard is Preview-only, `docs/release-gates/reencryption-wizard.json` status remains `blocked`.
