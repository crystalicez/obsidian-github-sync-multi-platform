# D184 — Fenced post-crash Receipt/Selector window inspection (read-only, NOT a commit)

Date: 2026-10-31. Status: **internal diagnostic API**, Re-encryption Wizard **Preview-only**, first-release gate **blocked**.

## Why

D183 derives D182's six SHA-256 contract fields under a *single* lease with repeated D179 complete remote Source/Shadow/Git content verification. However D183 intentionally **refuses any persisted `selector.json` or proposed Receipt marker**. After a crash or torn write, the same inspector cannot be used to inspect what remains on disk. D180 safely refuses unknown residue but cannot say whether a proposed two-piece AES-GCM test-vector pair is merely incomplete, cryptographically mismatched, or valid **but still not authoritative**.

D184 adds a separate strictly **read-only post-crash diagnostic**. It does **not** reuse D183's positive result as a live post-crash Git proof. It accepts a historical D183-derived witness and never grants migration authority.

## Implementation

New `src/lib/v4/reencryption-fenced-crash-window-pair-inspection.ts` exposes `inspectV4FencedCrashWindowPairAfterRestart(input)`:

- Inputs are a pinned D176 Prepared identity/32-byte journal key/restart reader, a historical D183/D182 Contract, and the exact historical Source Settings. It validates the entire 3-branch D142 identity, 128-bit nonzero transaction ID, exact Contract fields and six canonical SHA-256 strings, matching Run/Index/Device/Passphrase Secret IDs and one owner-accepted **best-effort** WAL acknowledgement.
- Uses **one exclusive initiating-device cooperative lease** and requires that the holder invoke its body exactly once and return **that body's exact report object**. Checks the lease and authenticated best-effort WAL checkpoint before/after reads; pins the original input, Settings, expected identities, adapter/read methods, journal, WAL, AES-GCM key, both old/new SecretStorage values and immutable historical Contract through every asynchronous boundary.
- Re-reads exact canonical **D173 Sync Fence**, Source Index, separate Destination Shadow, bounded D172 AES-GCM Prepared Selector, exact D170 prepared (unkeyed) Intent checksum and authenticated D165 WAL generation/receipts. Compares the six D183 historical snapshot hashes with freshly read Source, Shadow, Prepared, WAL, historical Source Settings and derived proposed Destination Settings; verifies Shadow encrypted cache completeness.
- Separately identifies disk layouts: `absent`, `receipt-directory-only`, `receipt-only`, `selector-only`, `pair-present`, `unrecognized-layout`, `unverifiable`. A complete pair is independently decrypted/authenticated through D182 with role-separated keys, canonical bounded base64, exact Run and receipt-ciphertext SHA-256 binding. Selector and Receipt are deliberately read in a **fixed order** to catch a Receipt changed after Selector read (a detected race during D184 test development).
- Observes live Settings and Active Index separately as `source`, `destination`, `mixed` or `unverifiable` without claiming a durable transaction. Source Index overwritten with a Destination Index is classified as historical evidence drift rather than restored or silently accepted.
- Verifies a **second independent snapshot**, compares every raw local evidence value and repeats exact Fence checks. Changed files, storage methods, Settings, Secrets, WAL or Holder results return `manual-recovery-required`.

The only benign observation is `source-prepared-uncommitted` **when no commit-looking artifacts exist**, Source Settings and Index are still Source and all locally read historical evidence agrees. Every other scenario, **including a perfectly authentic encrypted Receipt/Selector pair on disk**, returns `manual-recovery-required`. The report may state `cryptographically-linked-uncommitted` to aid future **manual-only** diagnostics; that is *not* a committed marker or permission. All reports have `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` fixed **false**.

There are no persistent writes, remote Git calls, production Wizard integration, automatic retries, active Selector updates, index selection, Settings or SecretStorage mutations, Sync release, old-key cleanup or OS helper.

## Tests and failure observations

**8 new D184 tests** (7 in `tests/v4/reencryption-prepared-selector-stage.test.ts` plus 1 in `tests/v4/reencryption-destination-exact-commit.test.ts`):

1. No Receipt/Selector and exact locally prepared Source yield `source-prepared-uncommitted`; files unchanged and Fence still blocks Sync.
2. Authenticated D182 Selector/Receipt files remain Manual Recovery and preserve Source/SecretStorage.
3. **36 crash-window combinations:** Source/Destination/Mixed Settings × Source/Destination Active Index × no artifacts, receipt directory only, receipt only, selector only, both, foreign pair; check diagnostic reason and the five false permissions with no inspector writes.
4. Torn or corrupted Fence, Prepared, Intent, WAL, Source/Shadow, missing/changing Secrets, changed historical Settings/WAL digest or transaction ID fail closed.
5. Over-limit Selector/Receipt (>8 KiB) and a Receipt marker missing its proposed directory are rejected without attempting an unbounded data read.
6. A Receipt mutated between the two observations is detected; fixed-order reads avoid a parallel-read race that originally masked this change.
7. Holder callback skipped, invoked twice or modified Settings/SecretStorage after callback is rejected.
8. Full D183-backed integration: a historical Contract is first derived by D179 from **real AES-GCM encrypted Unicode, empty and >8 MiB Destination data plus complete mock Git content verification**. After deliberately placing the valid D182 pair on disk, D184 accurately reports it as cryptographically linked but **not authoritative**, and D180 also refuses it. No new GitHub fetches or mutation occur during D184.

**Full Fast 1210/1210 PASS** (+8), Maximum Strict TypeScript PASS, Recovery and Feasibility PASS, Resource **11/11 PASS**, Production Build PASS, GitHub E2E compile-only **3 bundles PASS**, Metadata/Package validators PASS, bounded **100,000,000-byte** cryptographic SHA-256 soak PASS.

## Remaining threats / release blockers

The supplied historical D183 Contract is an **externally supplied witness**. D184 does **not independently reverify live GitHub refs, live Backup ciphertexts, local OS power-loss durability, or old/new SecretStorage passphrases against new remote contents** after Restart. Even an authentic pair proves only encrypted test-vector linkage and journal-key possession, not a durable or authorized migration. A foreign process/Git writer could change-and-restore a ref or disk data between reads (ABA). Only cooperating local actors are excluded by the Lease; Windows Node directory fsync remains unsupported. Settings and Index are not atomically switchable by this inspector. A complete Destination-looking local state is not a committed receipt.

Before any real Cutover, the owner must approve exact **committed Selector/Receipt persist ordering and deterministic Manual Recovery semantics**, and implementation must separately prove multi-process/stale-device fencing, actual Settings/SecretStorage/active-Index transaction, post-crash Git binding and installed Obsidian acceptance. Preserve the Source Branch, frozen Backup Branch, orphan Destination Branch, original passphrase and history. Do **not** enable Wizard Run, release, merge, GitHub Actions, Native Helper or automatic Fence unarm. `docs/release-gates/reencryption-wizard.json` stays **blocked**.
