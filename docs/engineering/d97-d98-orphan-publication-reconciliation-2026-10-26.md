# D97–D98 — Read-only orphan-ref reconciliation and verified create-once publication

Date: 2026-10-26. **Incremental implementation, NOT an end-user Re-encryption release.**

## Binding architecture

D90–D91 are unchanged: the physical GitHub repo has three required roles — independently writable original Source, pinned old-encrypted Backup, and newly encrypted orphan-root Destination. Other old-branch clients may Sync indefinitely and follow the new destination only manually. No device registry, migration marker, cross-branch auto-merge, auto-delete, or old-branch freeze.

## D97: Independent READ-ONLY destination recovery

New `src/lib/v4/reencryption-orphan-recovery.ts` provides `inspectV4ReencryptionOrphanAfterAmbiguousPublication` for an ambiguous/lost response from the exact `createGitRef` request, or for a later trusted recovery operator with authenticated candidate/manifest inputs. Its GitHub dependency has **only GET-capable methods**; it cannot create/update/delete a ref.

- Binds an exact SHA-pinned D96 unpublished candidate and its tree to the D74 orphan plan, fully qualified GitHub destination branch, physical repository numeric ID/name, and the real default branch. It checks ref twice before classification and checks repository identity/default branch again afterward. Any mismatched/invalid ref, race/drift, API error or cancellation fails closed.
- Returns one of: `destination-not-observed` (two observations, **not** proof it can safely be created); `destination-occupied-by-unexpected-commit` (collision, **never overwrite**); or `destination-pinned-and-fully-verified`. For the latter it invokes the existing `verifyV4ReencryptionDestinationExactCommit`, which checks zero-parent commit ancestry, exact Git tree, every encrypted V4 config/head/shard and Git ciphertext object, new-password AES-GCM decryption and every file's plaintext SHA-256/size; then rechecks the ref.
- Even a verified match always reports `refPublicationProvenByThisRun:false`, `automaticallyRetryCreateAuthorized:false`, `overwriteAuthorized:false`, `backupRestoreVerified:false`, `localCutoverAuthorized:false`. A successful read is not proof of WAL durability or legitimate creation provenance. No old Source HEAD equality requirement, per D90.

## D98: guarded create-once + automatic read-only reconciliation

New `src/lib/v4/reencryption-orphan-publication-reconciled.ts` exposes `publishAndVerifyV4ReencryptionOrphanRef`. It wraps D96 `publishV4ReencryptionOrphanRef` and D97. It requires an **external caller-supplied durable publication-intent barrier** and exclusive lease:

- If the intent barrier fails, no new ref is created and the error propagates.
- D96 permits one `createGitRef` attempt only. Whether the response is HTTP-success or lost/ambiguous after the journal-intent barrier, D98 independently re-reads and fully decrypts the exact published destination with the NEW passphrase. A matching, fully verified result returns `response-confirmed` or `lost-response-reconciled`; no ref retry, no overwrite, no source/backup branch mutation.
- Missing, occupied, unreadable, mutated or corrupt destination never gets success or an automatic retry. An ambiguous mutation + failing readback raises an explicit unresolved-result error, preserving the remote ref for manual inspection.
- **Critical trust boundary:** D98 takes a callback, not a measured OS durability guarantee. A no-op callback in mocks does NOT establish physical WAL fsync. The report explicitly declares `durableJournalIndependentlyAudited:false`, `backupRestoreVerified:false`, `initiatingDeviceCutoverAuthorized:false`. D98 is not yet connected to the real Wizard or user vault.
- A real production coordinator must persist the exact candidate+intent and complete manifest in a crash-durable WAL **before** mutation, so the data required for a restarted D97 recovery is available after process loss. D81 WAL currently covers immutable ciphertext upload receipts, **not the entire orphan commit+ref+initiating-device cutover**. That gap remains blocked.

## Automated and real GitHub evidence

- `tests/v4/reencryption-orphan-publication.test.ts` added **ten** D97–D98 tests: absent/ref occupied/correct-match classification; lost HTTP response after remote acceptance; actual in-memory V4 encrypted metadata/tree/commit/ref reread and NEW passphrase decryption; wrong passphrase; corrupted blob; malformed/drifting ref; physical repo mismatch; unknown GitHub GET result; abort; missing durable intent; wrong new key; refusal to retry on network ambiguity.
- Real GitHub E2E scenario `tests/github-e2e/v4-real-github-e2e.test.ts` now also calls D97 against the existing guarded synthetic orphan branch after D83 full exact-content verification. This is read-only against an E2E-owned disposable ref; it verifies no Git mutations, no automatic retries and no cutover approval. **Compiled but NOT executed against GitHub in this stage.**
- Attempted `pnpm test:github-e2e` **stopped in preflight (exit 2)**: existing local `.env.github-e2e` does not set mandatory `GITHUB_E2E_EXPECTED_REPO_ID`. No live GitHub branch mutation or remote test was initiated. This guard was **not bypassed or guessed**. An ignored temporary env copy was removed from the isolated worktree; the primary source credential file remained untouched. The maintainer must pin the verified numeric ID for the approved test repository before remote E2E can resume. Do not turn the safety check off.
- Full local qualification after D98: `pnpm test:fast` **820/820 PASS**, `pnpm test:recovery` **79/79**, `pnpm test:resource` **11/11**, `pnpm test:feasibility` **136/136**, `pnpm typecheck:max-strict`, `pnpm build`, `pnpm test:github-e2e:compile` (3 bundles), `pnpm validate:package`, `pnpm validate:metadata` all PASS.

## Hard release blockers, unchanged

1. One trusted three-role operation that pins source, creates and fully verifies same-repo frozen Backup + isolated scratch restore, stages fresh encrypted destination, persists every candidate/intent, publishes with D98 and independently verifies complete content.
2. Persistent encrypted restartable journal encompassing blob metadata/tree/commit/ref publication and local cutover, along with a real cross-process lock and **Node.js-only Windows power-loss durability**. D86 WAL's directory fsync yields `EPERM` on the tested Windows machine, so `assertCrashDurable()` currently fails and MUST continue blocking remote mutation on that platform. No native helper, GitHub Actions or rollback policy change is authorized.
3. Initiating-device local changes/safe recovery+config/index switching and zero silent loss; other devices stay independently syncing old Source forever until manual opt-in.
4. Credentialed protected test-repository E2E with pinned numeric ID, installed desktop 2-device and mobile acceptance, interruption/rate-limit/large-file scenarios (real test file limit 100 MB), security/performance/UX review. No real Obsidian user vault writes this stage.

The tracked `docs/release-gates/reencryption-wizard.json` remains `status:"blocked"`. The visible Settings action remains **Preview wizard**, never full production Re-encryption.
