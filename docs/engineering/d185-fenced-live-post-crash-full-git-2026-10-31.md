# D185 — One-lease post-crash live Git content revalidation (non-authorizing)

Date: 2026-10-31. Status: **internal read-only diagnostic only**, no Run/Cutover writer, Wizard Preview-only, release gate **blocked**.

## Gap

D184 already classifies post-crash local Settings/active Index/Prepared/Intent/WAL and hypothetical D182 AES-GCM Receipt/Selector residue with exact D183 snapshot hashes. But D184's Git integrity evidence is a *historical D183 witness* from before any Selector/Receipt was placed in storage. A remote Source, Backup or Destination reference, Git commit/tree, or encrypted Destination Blob could change after the previously successful read, making old evidence inadequate for manual recovery guidance.

D179 cannot simply be reused: D183/D179 **deliberately refuse** the local Selector/receipt paths even if these are genuine D182 test-vector residues; a real post-crash diagnostic must inspect them rather than claim a committed migration. D177 revalidates three refs and WAL without full Destination content. **D178** independently verifies current three branch refs/commits/trees, WAL/fence, a freshly loaded Destination Shadow and every Destination Git encrypted HEAD/shard/Blob, including decrypting and recomputing original plaintext SHA-256, without depending on current active Source Index selection. Thus D178 can remain useful after a Settings-first or Index-first crash.

## Added implementation

New `src/lib/v4/reencryption-fenced-live-post-crash-verification.ts` exports internal `inspectV4FencedLivePostCrashAfterRestart(input:V4FencedLivePostCrashInput)`. It composes D184 post-crash local triage with D178 full current Git proof, **under one outer caller-owned cooperative initiating-device lease**:

1. Require matching D142 Run/Source/Backup/Destination identity, separate historical D183 contract, exact D173 Fence/owner-acknowledged best-effort WAL, *same* journal/WAL/local adapter, encryption key, old/new SecretStorage, D178 branch readers/GitHub client and lease assertions. Pin source/historical Settings, original Settings values, branch/publication objects, methods, physical Repo ID, remote configuration/receipt/Passphrase scope and full serialized Contract. A real GitHub client can have cyclic runtime state; the inspector **does not JSON.stringify the client object** and separately pins reader/client method identities.
2. Invoke D184 under a checked **borrowed** lease, including its double Source/Shadow/Prepared/Intent/WAL, Settings and persisted Receipt/Selector inspection. No recursive acquisition of the nonreentrant initiator lease.
3. Invoke D178 under that same borrowed lease. D178 independently checks **all three current Git branch refs/Commit/Trees** twice, the orphan Destination identity, authenticated WAL ciphertext receipts and canonical Fence, and reads/decrypts **every encrypted Destination file and metadata Blob** against the local Shadow and pinned D100 publication evidence.
4. Re-read D184 and require the same diagnostic outcome, including any leftover valid/test-vector pair or torn local cutover.
5. Independently run D178 again and re-read D184 again, catching Git ref motion **between** the two complete scans and local Index/SecretStorage/Selector drift after a Git fetch. Keep the outer holder active and check pinned inputs across every await, then verify it executed exactly once and returned the very report produced by the callback. Skipped, double-called, forged or post-mutating holders fail closed.

The report may classify `source-prepared-and-git-reverified-uncommitted` only for coherent Source with **no** commit-looking residue, or `crash-window-git-reverified-manual-recovery` when a local crash window exists but live Git content checks succeeded. Neither is an authoritative commit. A torn/missing local evidence, a stale Git ref/Blob/WAL, unexpected mutation or unavailable lease yields `manual-recovery-required` and does not claim live content reverified. The flags `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` are **false** for every outcome.

There is **no persistent storage writer, GitHub write, Settings/SecretStorage mutation, active Index switch, automatic retry/rollback, Sync Fence removal or Wizard Run integration**.

## Verification

Seven new D185 regression tests in `tests/v4/reencryption-destination-exact-commit.test.ts` use an existing complete D179 fixture with *real AES-GCM encrypted Unicode, empty and >8 MiB Destination content*, actual local Source/Shadow/Prepared/Intent/Fence and WAL, and mocked GitHub three-branch readers:

- One-lease Source success (a single Holder call; **two additional complete encrypted Destination Git scans**, verified by increased Blob and ref reads), preserving file bytes, Secrets and WAL.
- Fully authenticated historical D182 Receipt/Selector **persisted in a mock local adapter** plus two fresh D178 Git scans still requires Manual Recovery, with no cleanup.
- Destination-looking Settings **and** active Index plus full Git and valid pair never confers an authoritative commit or power-loss-durable transaction; D184 detects original Source Index drift while D178 can still reverify Destination content from Shadow.
- Changed Source/Backup/Destination ref, damaged encrypted Git Blob, non-orphan Destination Commit or stale WAL fails closed.
- Git ref moving **between** the two complete Git scans is detected despite a byte-unchanged local Selector/Receipt pair.
- New SecretStorage secret, Source Index or Source Git reader method mutated while retrieving a remote Git Blob refuses a positive result.
- A holder that skips callback and forges prior success, invokes it twice or mutates Settings / a Backup Git reader after its callback fails closed. The successful fixture also includes a Git client object containing a **circular reference**, proving it isn't serialized.

**Full Fast 1217/1217 PASS** (+7 D185), Maximum Strict TypeScript, Production Build, Recovery, Feasibility, Resource **11/11**, GitHub E2E compile-only **3 bundles**, Metadata/Package validation and bounded **100,000,000-byte** cryptographic SHA-256 soak PASS.

The GH readers for these tests are **mock objects serving real encrypted bytes**, not a credentialed live GitHub E2E or installed Obsidian Desktop/Mobile migration. No actual branch was changed or migrated in this stage.

## Remaining risks / policy decisions

- D178's live Source and Backup branch refs/Commit/Trees are checked, but **full Source/Backup ciphertext is not freshly re-read** in D185; it uses previously verified Backup publication as historical evidence. Noncooperating remote Git writers and ABA ref/data changes cannot be excluded by a local cooperative lease.
- D184 verifies historical Source provenance only as a witness. D185's fresh Destination content check is independent but its prior Source/Settings/SecretStorage/passphrase values are not a committed proof, nor independently read back from physically crash-durable media.
- Node on Windows cannot establish independent **directory fsync** here; D165 is owner-approved **best-effort WAL readback** only, not a guarantee against power loss. Reading every encrypted blob twice also costs extra API latency, appropriate for read-only audit and *not* yet profiled for real-world installed migration.
- Still missing an **owner-approved authoritative committed Receipt/Selector format, write/flush order and Manual Recovery semantics** for any interrupted Settings/SecretStorage/active Index transition; multi-process, stale multi-device writer coordination; and installed Desktop/Mobile and credentialed GitHub acceptance. No positive read-only observation grants permission to cut over, resume, delete old passphrases, or auto-unarm the Sync Fence.

Preserve Source, frozen Backup, orphan Destination, original Git history and old passphrase. Do not enable Wizard Run, release gate, add Native Helper or GitHub Actions, merge or release. `docs/release-gates/reencryption-wizard.json` remains **blocked**.
