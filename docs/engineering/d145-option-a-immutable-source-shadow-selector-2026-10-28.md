# D145 — Option A accepted: immutable Source Index, Shadow Index and separate selector

Date: 2026-10-28. The owner selected **A** after the D144 cross-phase contradiction. The decision permits development of an independent selector and restart recovery design, **not** production cutover, passphrase cleanup or a weaker crash-safety policy.

## Why A changes the cutover model

D142 inspected a hypothetical state in which the original active Index had already been replaced with the Destination Index. That is **not** the target architecture. The target keeps the original Source Index root unchanged by re-encryption, stores the independently prepared Destination Index at the existing `<source>-rekey-<runId>` Shadow root, and reserves `<source>-rekey-selector-<runId>/selector.json` as an **unimplemented** selector location. An index root is never selected merely because Settings or an untrusted marker names it.

`src/lib/v4/reencryption-separated-selector.ts` validates and derives those three distinct paths, then provides a pure restart-snapshot classifier. It accepts Source and Shadow index matching observations, a presumed selector observation, saved Settings selection, old/new SecretStorage presence and authenticated prepared WAL observation. Only matching Source Settings with an absent or Source selector produce `source-prepared-uncommitted`. Matching Destination Settings with a Destination selector produce `destination-observed-uncommitted`. Missing Source or Shadow, changed index, torn or disagreeing selector/Settings, missing secret or unverified WAL produce `manual-recovery-required`. **None** of these observations authorize any mutation, Sync, rollback or secret cleanup.

The selector location and its values are a proposed contract, not a file that the plugin now writes. This classifier does not authenticate selector bytes or establish physical durability. Its inputs are caller-supplied snapshots. A caller can fabricate a matching observation, but even that receives no authority. Consumers must not treat its output as proof of a committed transaction.

## Fault coverage and remaining implementation

The D145 tests preserve both independent index roots and enumerate all 4! write orders of selector transition, logical Settings branch update, Settings Secret ID update and premature old-secret removal. For each possible acknowledged-write boundary, all subsets of writes that survive a crash are explored. Every result is non-authorizing; torn Settings and missing old secret fail closed. This logical model is conservative and is **not** an OS power-loss test.

To implement a production selector, first establish a single independently authenticated, crash-durable, replay-resistant selector write/read contract with a monotonic generation tied to WAL, physical repository ID, commit and manifest identities. Verify that it survives all restart and power-loss boundaries and cannot race other processes. Recovery must re-read and authenticate the selector, Source, Shadow, Settings, both secrets, encrypted WAL, remote Backup and Destination under an actually enforced writer lease. A surviving Source cache does not itself authorize rollback. Avoid rewriting the active Source Index; avoid depending on an acknowledged `saveData()` call as a commit.

Current blockers remain Windows Node directory `fsync` EPERM, macOS/Linux/mobile physical qualification, Obsidian Settings and SecretStorage durability, cross-process writer exclusion, live disposable three-ref GitHub readback, installed two-device acceptance and independent security review. Prefer existing Obsidian APIs and Node where they meet strict requirements; do not promote a Native Helper without separate owner approval.

No release gate, Wizard, Sync, local Index, Settings, SecretStorage, WAL, GitHub ref, or real cutover path was changed. The Re-encryption Wizard is still **Preview-only**, and `docs/release-gates/reencryption-wizard.json` stays **blocked**.

Verification on unchanged D145 code: focused 5/5, Fast 1048/1048, 10 isolated Fast repeats of 1048/1048, Recovery 88/88, Resource 11/11, Feasibility 136/136, max-strict TypeScript, production build, compile-only GitHub E2E (three bundles), metadata/package checks and 100,000,000-byte SHA-matched cryptographic soak all passed. These checks do not qualify power-loss durability or real remote cutover.
