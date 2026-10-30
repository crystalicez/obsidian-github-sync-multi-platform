# D171 — Best-effort read-only local restart and crash-window inspection

Date: 2026-10-30. Status: internal diagnostic implementation; first-release Re-encryption Wizard still blocked.

## Why

D170 added an internal best-effort writer of a nonsecret **prepared-uncommitted** local cutover Intent, but the existing D136/D139 restart readers still required a true directory-fsync crash durability assertion. On Windows Node this is unavailable. A restart must inspect the encrypted WAL, original and shadow local indices, persisted intent, settings and both passphrase references without treating recovered-looking state as a committed local transaction.

## Implementation

New `src/lib/v4/reencryption-best-effort-local-restart.ts` provides two internal read-only entrypoints:

- `inspectV4BestEffortReencryptionRestartEvidence()` — uses the established D136 exact nonsecret Intent, original Source/Shadow cache, Settings/SecretStorage presence and twice-bracketed complete WAL observation. Its positive observation is **source-with-prepared-intent-uncommitted**.
- `inspectV4BestEffortReencryptionLocalTransactionAfterCrash()` — uses the D139 single-held-initiator-lease state classifier to distinguish **source-prepared-uncommitted**, **destination-observed-without-commit-proof**, and **manual-recovery-required** for partial or inconsistent Settings/Index switches.

Both require explicit `accept-best-effort-power-loss-recovery-risk`, a live cooperative WAL lease and an exact pinned Source/Destination repository identity and WAL generation. The checkpoint invokes D165's three stable filesystem readbacks and two authenticated AES-GCM journal snapshot checks. Original WAL lease/read methods, source identity, run ID, expected Settings and Storage references are pinned against substitution across awaits. Existing D136/D139 inspectors remain the only local matching and crash-window classifiers. Their strict call sites continue using the caller's real `assertCrashDurable()`. The new read-only adapter supplies an explicitly **best-effort checkpoint**, not a real fsync durability claim.

Both reports have the distinguishing literal `evidence: "best-effort-wal-readback-not-power-loss-durable"`. No report authorizes selecting Destination, resuming Sync, retrying a GitHub write, reverting Settings, replacing local Index or deleting the original passphrase. An ambiguous / damaged WAL or missing lease fails closed (Manual Recovery or explicit error). This checkpoint authenticates WAL state and caller identities but cannot fence an unrelated OS process or prove physical power-loss safety. The preexisting, unkeyed local intent remains only a hint.

## Tests and scope

`tests/v4/reencryption-local-cutover-restart.test.ts` adds D171 cases for exact prepared Source intent and unchanged file map, risk-decline before any local read, forged Intent, changed Settings and incomplete WAL, stale generation/lost lease/mutated settings mid-check, plus a **real Windows WAL reopened with a new Node filesystem adapter** and independent AES-GCM journal readback of a previously prepared local Intent. Local Settings/Index files are still represented with an in-memory adapter, not an installed Obsidian vault.

`tests/v4/reencryption-local-transaction-recovery.test.ts` adds D171 cases proving Source, mixed Settings/Index and Destination-looking crash windows are all non-authorizing, plus missing consent and lost WAL lease rejection. Focused Restart **15/15 PASS**, focused crash recovery **12/12 PASS**, maximum strict TypeScript PASS. Full Fast, Recovery, Feasibility, Resource, production Build, three GitHub E2E compile-only bundles and local metadata/package/100 MB soak verification also pass. This stage does not run credentialed GitHub network tests, native Obsidian migration or a real power cut.

## Next release blockers

There is no authoritative persistent encrypted Selector that can safely bind a committed transaction to Settings, SecretStorage and Source/Shadow Index. No production Sync startup fence currently consumes these internal reports. A future local Cutover must define a separately authenticated commit receipt and controlled ordering, preserve old secrets until verified, classify every partial write at restart and provide Manual Recovery UI. Real installed Desktop/Mobile and disposable GitHub acceptance remain outstanding. Keep `docs/release-gates/reencryption-wizard.json` at `blocked`, with Wizard Preview-only.
