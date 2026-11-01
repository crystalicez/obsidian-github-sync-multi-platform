# D216 — Fenced two-pass frozen Backup content re-verification after interruption

Date: 2026-11-01. Status: **read-only internal Recovery prerequisite**, not installed Wizard execution. First-public-release Re-encryption gate **blocked**.

## Release gap

D185 rechecks the current three Git refs and decrypts all Destination data after a simulated crash, but its Backup proof is a *historical* D100 publication/readback witness plus live ref/commit/tree observations. A historical witness does not prove that **the current frozen Backup branch still returns all original encrypted files**. D94 already has a strict GitHub immutable-commit reader that validates the original encrypted V4 configuration, head, shards, Git Blob SHA-1 identity and each decrypted plaintext SHA-256 through the Backup ref.

## Implementation

Added `src/lib/v4/reencryption-fenced-backup-content.ts` as an independent read-only post-crash check. Its inputs must contain an exact D142 migration identity, the D94 owner-approved same-repository frozen Backup proposal and GitHub reader, D173 Sync Fence adapter, the exact WAL journal generation, and a caller-owned exclusive initiating-device lease.

- Pins the Source SHA/tree, old-key Backup/Destination branch IDs, physical repo proposal, GitHub read methods, passphrase and lifecycle callbacks to prevent async substitution.
- Validates the D173 **canonical, byte-exact** fenced Run before, between and after two independent complete Backup readbacks. At the same boundaries, confirms a cooperating lease, WAL lease, best-effort checkpoint and authenticated D142 Prepared WAL Source/Backup/Destination receipt identity.
- Runs D94 **twice**, re-fetching encrypted configuration, head, shard and all original object blobs each time from the immutable Git tree, with independent physical repository/ref checks and passphrase decryption. Compares complete counts, byte totals, pinned Source and Backup identities across runs.
- Returns `complete-frozen-backup-reverified-uncommitted` only for coherent readback. Any missing or changed remote ref, ciphertext, branch, physical repository, fence, WAL or lease gives `manual-recovery-required` with zero permission to Cutover, resume Sync, rollback, perform remote writes or clean the original key. Does not mutate GitHub, Vault, Settings, SecretStorage, Selector or Index.

This evidence is **not** proof of verified backup *creation provenance*, a real OS power-loss durable WAL, an externally lockable Git branch, a second-device restore or an authoritative Cutover receipt. Source remains independently syncable; only the frozen Backup ref is expected to remain pinned.

## Behavioral tests and offline gates

Five focused D216 cases in `tests/v4/reencryption-trusted-loader.test.ts` use the actual D94 immutable Git tree walk over **real AES-GCM encrypted metadata and Unicode file bytes**, but mock GitHub read responses, a fake held lease and a deterministic WAL/Fence adapter. They cover two-pass success with original Source advancing, late Backup ref drift, late ciphertext corruption, missing/torn fence, stale WAL, changed physical repository ID and wrong old passphrase, plus skipped and repeated holder invocation. Focused trusted-loader suite **49/49**; entire Fast tier **1,280/1,280**. All other offline gates pass: `pnpm build`, `pnpm typecheck:max-strict`, Recovery **93/93**, Feasibility **136/136**, Resource **11/11**, three GitHub E2E **compile-only** bundles, metadata/package validators and 100,000,000-byte cryptographic soak with SHA-256 `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8` matching reference.

## Remaining decisions and release work

D216 is an independently callable component and **not yet wired into D185's single outer post-crash inspection, installed Wizard Run or GitHub credentialed acceptance**. Future integration must maintain one nonreentrant initiating lease across D185's full Destination/current local evidence and the new full Backup readback. D94 double content read can be network- and PBKDF2-intensive and requires real performance measurement on installed Desktop and Android/iOS. It cannot exclude an external writer who moves and restores a branch (ABA) after the last read.

The main public-release blockers remain the committed Receipt/Selector format and ordering, restart-safe best-effort Settings/SecretStorage/active Index cutover, unambiguous Manual Recovery, stale multi-device client protection and installed Desktop/Mobile acceptance. Retain original Source, frozen Backup, new orphan Destination, Git history and old passphrase. Do not ship GitHub Actions, Native Helper, live mutation, force push, branch deletion, merge or Release. Keep `docs/release-gates/reencryption-wizard.json` at `blocked`.
