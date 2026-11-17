# V4 GitHub REST end-to-end test

The destructive suite uses a dedicated non-default branch in a real GitHub repository. One physical runner simulates independent Obsidian devices A/B/C with separate in-memory vaults, V4 indexes, device IDs, `GitHubClient`s, and `V4SyncSession`s while sharing one real remote branch. This makes stale-device conflicts and branch-head races real network behavior without requiring multiple physical machines.

The suite is deliberately deterministic: sequential multi-device scenarios and controlled one-shot interference are preferred over random concurrency or correctness-by-sleep timing.

## Scenario coverage

The main plaintext/encrypted suite covers:

- force push -> no-op -> history -> clean-vault force pull,
- Unicode/emoji/nested paths, spaces/punctuation, dotfile-style content, zero-byte files, and deterministic binary payloads,
- encrypted logical-path opacity and authenticated object verification,
- two-device stale catch-up plus disjoint local creation,
- same-file concurrent edits using Copy policy,
- rename versus stale edit,
- delete -> publish -> recreate identity break,
- cross-device binary overwrite,
- controlled plaintext branch-head interference with a real external Git commit.

A second focused live test covers encrypted out-of-band mutation. It publishes encrypted V4, injects a normal Git commit that does not update the authenticated V4 journal/head contract, and proves normal encrypted sync refuses the mutation without silently overwriting the injected commit or trusting it in the local index.

The runner executes E2E test files serially so their destructive branch reset/cleanup phases cannot race one another.

## Qualification boundary

This is a live network and multi-device correctness smoke suite. It is **not** physical-device qualification, 5 GiB qualification, pack-scale benchmarking, or a large-file performance claim. Physical Windows/Android evidence remains separate in `tests/baselines/v4/` and `docs/testing/v4-windows-android-validation.md`.

**Policy from 2026-10-21: GitHub Actions are prohibited for this project.** Qualification is local/manual only with isolated credentials and exact target repository ID. The local `pnpm qualify:local` process compiles and verifies the E2E inputs before running against a unique disposable branch, and requires cleanup/absence evidence before producing an exact-SHA qualification receipt.

## Local/manual configuration

Credentialed local execution requires all of these values in `.env.github-e2e` or the shell:

```text
GITHUB_E2E_OWNER=owner
GITHUB_E2E_REPO=dedicated-disposable-repository
GITHUB_E2E_EXPECTED_REPO_ID=123456789
GITHUB_E2E_BRANCH=obsidian-sync-e2e/local-v4-e2e-123456
GITHUB_E2E_TOKEN=<credential scoped only to that repository>
```

`GITHUB_E2E_EXPECTED_REPO_ID` is mandatory and must be the target repository's numeric GitHub ID. Owner/repository text is routing information only; the resolved numeric ID is checked before destructive work. Destructive E2E resets only accept a leaf of the reserved `obsidian-sync-e2e/local-*` namespace; manually selected feature, release, or personal branches are rejected before any HTTP request. Never use `main`, `master`, `production`, `prod`, `release`, or `stable`, and never point this configuration at a real notes repository. The canonical plugin source repository is refused by its name and immutable numeric GitHub ID even when an optional source ID is missing. Prefer generated cryptographically random branch names over manually chosen ones.

For release-qualifying use, the credential's mutable repository scope must be limited to the dedicated disposable target repository. A token that can modify the plugin source repository or unrelated repositories is not acceptable qualification configuration.

Run the local convenience flow with:

```bash
pnpm test:github-e2e:quick
```

Local quick mode compiles and runs in one process. For a credential-free compile check on any supported shell, including PowerShell:

```text
pnpm test:github-e2e:compile
```

The runner also accepts `node scripts/run-github-e2e.mjs --compile-only`. Compile-only mode does not load the target env file and requires no target credential or repository ID.

Manual execution also resolves the checkout's GitHub `origin` **and its numeric repository ID**. It refuses a destructive target equal to either the current source repository or the canonical source repository by route/name or by numeric repository identity. Before mutation, the configured owner/repository route must resolve to `GITHUB_E2E_EXPECTED_REPO_ID`, the selected branch must differ from the actual target default branch, and the target default Git ref must be readable. If source identity cannot be proven, the manual run fails closed.

For an isolated manual run, `node scripts/run-github-e2e.mjs --preflight-only --fresh-isolated-branch` performs only read-only identity and two branch-absence checks. It requires a dedicated `GITHUB_E2E_TOKEN`, owner, repository and pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID`; missing values fail closed before test writes. Without `--preflight-only`, `--fresh-isolated-branch` creates a random 128-bit `obsidian-sync-e2e/local-*` branch and runs the live suite, but **does not automatically delete it**. Use the separately pinned disposable wrapper (described below) when automatic twice-verified cleanup is required.

The maintained audit runner `node scripts/run-github-e2e-disposable.mjs full` is restricted to the previously approved dedicated test repository and numeric ID. It checks branch absence twice, runs the complete GitHub E2E suite on one fresh disposable branch, attempts cleanup even after a test failure, and independently checks the branch is absent twice afterward. A fresh manual `full` run also resets that same isolated branch between the live read-only Re-encryption source scenario and the synthetic encrypted orphan-root scenario; the latter requires a newly absent ref. The reset is **test harness isolation only**, not a Re-encryption rollback or permission to mutate source/default branches. Run it only with explicit owner authorization for destructive tests.

D373 adds `node scripts/run-github-e2e-disposable.mjs frozen-backup-encrypted`: it publishes a synthetic old-key Source on a fresh approved test ref, pins that immutable Git commit, uses the **production D93 create-only frozen Backup ref helper**, advances the Source using regular encrypted Sync, and independently decrypts/verifies every file from the old snapshot through the Backup ref. The test asserts that Source has moved and Backup still points at the original commit; it does **not** claim WAL crash durability, installed Obsidian restore, new-key Destination integrity, or migration cutover.

The Backup ref name is a fixed-size SHA-256-derived leaf `obsidian-sync-e2e/local-backup-<32 hex>` of the unique test Source branch, using the same derivation in the E2E child and outer cleanup wrapper. Both refs are proven absent twice before the child starts. The outer wrapper attempts independent verified cleanup for **both** refs even if the test child fails or exits abruptly, and refuses a successful result unless both are absent twice. `node scripts/run-github-e2e-disposable.mjs frozen-backup-crash` is an explicitly synthetic fault-injection check: the child exits after the Backup create-only request and **must return a nonzero status** while the parent still verifies both refs removed. Do not treat its expected failure as a failed regular migration or as proof of physical power-loss safety. Hard kills of the outer wrapper itself still require manual branch cleanup.

D374 adds `node scripts/run-github-e2e-disposable.mjs newkey-destination-encrypted`. On the ID-pinned isolated test repo, the scenario combines independently verified Source and frozen Backup with the production new-key whole-vault transcoder and zero-parent orphan creator, creates ONLY the preflighted disposable Destination ref, verifies the exact committed metadata/objects with a second GitHub client, rejects the old password, and uses a new empty *synthetic* Vault and normal V4 Force Pull to compare the restored bytes of all seven files with the pinned original snapshot. The orphan commit subject must match the authenticated V4 HEAD `journalId` for new-device ancestry verification; foreign encrypted commits still fail closed. This is **not** a real Obsidian installed migration, not a persistence-safe publication WAL intent, not a user-facing Execute/Cutover, and not mobile acceptance. Parent cleanup and independent read-only checks must confirm all three temporary refs absent.

D375 extends that same `newkey-destination-encrypted` scenario through the **first ordinary encrypted Sync after migration**. The first new-key peer independently derives its own keyring, restores all seven source-snapshot files using normal Force Pull, modifies one note, and publishes a new Destination-only commit whose sole parent must be the original zero-parent re-encryption orphan. A third entirely fresh peer derives another independent keyring and Force Pulls the new tip; all seven bytestrings must match the original snapshot except for that one deliberate edit. Both the old-key Source ref and frozen Backup ref must remain exactly unchanged after the new-key Push/Pull. All three refs are test-owned and independently cleaned afterward. This confirms simulated post-migration multi-device Sync on the disposable GitHub repo, **not** installed-device Cutover, stale-client automatic reconfiguration, physical mobile acceptance, or durability of a real WAL publication intent.

D376 extends the same disposable E2E case to an explicitly **un-reconfigured old-key client**. It derives an independent old-key keyring, Force Pulls the **original pinned Source** before the Source's post-backup update, and remains stale while two new-key peers restore, Push, and Pull on Destination. The old-key client then edits a separate note and uses ordinary Sync; its Source commit must extend the prior Source HEAD, its local Vault must catch up the other Source edit, and GitHub must report the **new-key Destination ref and frozen Backup ref unchanged**. This is deliberate branch separation, **not** automatic stale-client migration or an endorsement of silently diverging Vaults. Users must reconfigure their other devices manually after a verified initiating-device cutover. The test never merges old and new branch histories or changes installed Settings and does not close the native stale-device release gate by itself.

D378 adds two **WAL-backed, real-GitHub Backup-only** focused modes: `node scripts/run-github-e2e-disposable.mjs wal-backup-encrypted` and `node scripts/run-github-e2e-disposable.mjs wal-backup-ambiguous`. Both use a fresh disposable Windows WAL directory, production best-effort WAL coordinator and readback, the approved pinned test repository, and freshly generated Source/Backup refs proven absent twice. The first mode persists the authenticated Backup intent **before** a create-only POST, verifies the complete old-key Backup, records the exact readback into WAL, then closes/reopens physical storage with a **new journal instance** to authenticate two intact WAL slots at generation 3. The second mode deliberately hides the **one** successful create-only POST response from the child, leaves the physical WAL at generation 2 with one unresolved pending Backup ref, closes/reopens it, and exercises the production **read-only** best-effort recovery coordinator. It fully authenticates the GitHub Backup, records the verified receipt without any additional GitHub mutation, and still denies Cutover. Both tests require Source independence, frozen Backup contents, and independently twice-verified cleanup of the two branches. **They do not** simulate a full installed Obsidian restart/true power loss, initiate a real user's Migration, authorize Destination, or prove a power-loss-durable publication intent; see `docs/engineering/d378-journaled-live-backup-2026-11-10.md`.

D379 adds `node scripts/run-github-e2e-disposable.mjs wal-stage-encrypted`, a **test-only**, triple-ref guarded mode. It first creates an authenticated real GitHub frozen Backup through the production best-effort two-slot Windows WAL, then uses the **same still-held OS WAL and journal run** with the production `stageV4BestEffortJournaledThreeBranchVault` to transcode the original seven old-key files into seven immutable new-key blobs, persist exact upload intents/receipts and independently read back Git Blob SHA identities. The stage closes/reopens physical WAL storage under a **new reader** to authenticate every receipt and both slots. Destination remains **absent** and `cutoverAuthorized:false`; no candidate preparation, ref publication, installed Obsidian migration, old/new-key device Cutover or true power-loss guarantee is claimed. Three generated Source/Backup/Destination test refs are each absent-checked twice and cleaned twice by the wrapper; see `docs/engineering/d379-live-wal-staging-2026-11-10.md`.

D380 tightens the real Git Blob staging readback: independently derived new key decrypts **all seven** original files byte-for-byte and the staged logical-path set matches the pinned Source exactly without duplicates; the original key must read SHA-verified ciphertext and fail with AES-GCM `OperationError`, not an arbitrary GitHub transport error. Focused real GitHub rerun passed, with all generated test refs independently absent-verified.

D381 adds `node scripts/run-github-e2e-disposable.mjs wal-candidate-encrypted`. Under the same physical best-effort two-slot WAL that holds the frozen Backup and independently verified seven staged new-key Git Blobs, the production candidate coordinator records a sealed preparation digest and creates a zero-parent immutable orphan commit with nine encrypted metadata Git objects. The Destination ref remains **absent**. A fresh OS WAL reader confirms the exact prepared commit/manifest receipt at generation 20. Focused real GitHub E2E and independent three-ref cleanup checks passed; see `docs/engineering/d381-wal-orphan-candidate-2026-11-10.md`.

D382 adds `node scripts/run-github-e2e-disposable.mjs wal-scratch-encrypted` and deliberately **disables** the premature `wal-publish-encrypted` selector. The same real GitHub frozen Backup and held physical WAL are reused through staging and orphan Candidate, followed by the production complete-Backup restore rehearsal into an explicitly isolated disposable disk scratch directory. All seven files are old-key-decrypted from the original Backup, SHA-256-verified after scratch physical readback, and removed from scratch. This focused real GitHub E2E **passed 1/1** and independently confirmed Source/Backup/Destination refs absent twice after cleanup; the Destination was never published, and no initiating-device Cutover occurred. Test scratch is a ~1 MiB-file synthetic sample, **not** installed Obsidian recovery, multi-part large-file verification or physical power-loss durability. See `docs/engineering/d382-live-backup-scratch-2026-11-10.md`.

D383 adds `node scripts/run-github-e2e-disposable.mjs wal-publish-encrypted` for the **approved isolated GitHub test repository** and three generated Source/Backup/Destination refs. Unlike D381/D382, this runs the production same-WAL `publishV4BestEffortJournaledThreeBranchDestination` create-only mutation. Before the GitHub ref POST, it requires authenticated frozen Backup, actual isolated physical scratch restore, a candidate recorded in the same two-slot WAL, and **double full SHA-256 parity of an isolated disk-backed synthetic initiating Vault**; a deliberately mutated byte is rejected before ref creation. The publisher issues exactly one create-only Destination POST, verifies the complete zero-parent encrypted Destination commit and every file, and persists the exact remote ref observation. A fresh client independently reads back the complete new-key branch. The WAL then reopens at **generation 22** with no pending mutation and `cutoverAuthorized:false`. Source old-key Sync continues independently after Destination publication; the frozen Backup still points to its original commit. Live D383 rerun **passed 1/1**, with 7 files / 1,048,689 plaintext bytes, 9 encrypted metadata objects, and an independent process verifying all three test refs absent twice after cleanup. The first attempt failed only a legacy test assertion incorrectly expecting Backup-only WAL observations after Destination publication; this was corrected and rerun successfully. No installed Obsidian Vault/editor fence, Settings/Index Cutover, physical power-loss durability, unknown-response GitHub recovery or large-file mobile acceptance was proven. See `docs/engineering/d383-live-wal-destination-createonly-2026-11-10.md`.

D384 adds `node scripts/run-github-e2e-disposable.mjs wal-publish-lost-response` in the approved isolated GitHub test repo with triple-ref preflight and verified cleanup. It inherits full D383 real old-key Backup, physical scratch restore, pinned local Source parity, same-WAL new-key staging, zero-parent candidate and exact one-shot Destination ref intent. The **real GitHub create-only Destination POST returns success**; a test-only wrapper then suppresses that success and throws a no-status error. Production must recover by full GitHub AES-GCM/SHA-256 metadata/file readback with **exactly one create-ref attempt, never blind retry**; a separate GitHub reader checks all seven plaintext files and a new OS WAL owner reopens journal generation **22** with completed Backup+Destination observations, no pending mutation and `cutoverAuthorized:false`. Focused D384 Live E2E passed **1/1, EXIT 0**, and three independently launched read-only checkers each proved Source/Backup/Destination test refs absent twice after cleanup. Targeted offline D351–D353 tests passed **5/5** covering lost and unreadable Destination replies, substituted ciphertext and multipart integrity. **This does not test process termination between POST and readback**, installed Obsidian Settings/Index migration, or physical power-loss durability; see `docs/engineering/d384-live-lost-destination-response-2026-11-10.md`.

D385 adds `node scripts/run-github-e2e-disposable.mjs wal-publish-process-loss` for a **real GitHub POST + simulated Node OS process death + fresh OS process WAL recovery** under a user-approved disposable repository and three fresh Source/Backup/Destination refs. The producer runs the authenticated D383 single-WAL Backup, seven new-key Git blobs, zero-parent candidate, scratch restore and initiating-Vault parity, persists one exact Destination intent in encrypted Windows WAL, waits for **one successful real create-only GitHub Destination POST**, then calls `process.exit(86)` before any readback observation or cleanup hook. The outer runner confirms the terminated child and exact live GitHub ref and **only for the owned synthetic WAL** simulates reviewed Manual Recovery stale-lock quarantine; production never auto-reclaims stale locks. The second Node OS process independently reauthenticates original Source GitHub ciphertext, opens the pending WAL at **generation 21**, invokes production **read-only** `reconcileV4PendingOrphanWithJournalBestEffort`, decrypts and verifies **7 Destination files / 1,048,689 bytes** and persists the destination observation at **generation 22** with **zero GitHub mutations** and `cutoverAuthorized:false`. Live D385 E2E passed with final **EXIT 0** and `LIVE_E2E_PASS`, all three test refs verified absent twice by the parent and three fresh independent read-only checkers, and the isolated test-only WAL root was removed only after successful cleanup. Focused D169 offline recovery tests **6/6** and Desktop WAL stale-lock/symlink/hardlink/slot tests **27/27** also passed. This does **not** prove electrical power-loss durability, installed Obsidian Cutover or automatic lock recovery in Production. See `docs/engineering/d385-live-post-create-process-loss-recovery-2026-11-10.md`.

D386 adds `node scripts/run-github-e2e-disposable.mjs wal-publish-process-loss-negative` as a safer **fail-closed observation-fault** extension of D385: first child performs ONE real create-only Destination POST, exits before its WAL ref observation; parent verifies the owned test GitHub ref/child evidence and simulates reviewed Manual Recovery **only for the isolated test WAL lock**, never for production. A fresh Node OS process reopens generation **21** with exactly one pending destination intent; it injects only **read-only GitHub client observations**, first two-plus consistent missing-ref results, then two-plus wrong-commit ref results. The unmodified production reconciliation rejects BOTH cases and leaves both physical encrypted WAL slots byte-hash unchanged, no ref retry, no GitHub mutation and no Cutover. The *actual GitHub ref remains untouched* and is independently rechecked between injected failures. When authentic reads resume, the same restarted process recovers all **7 new-key Destination files / 1,048,689 bytes**, verifies no mutation, and commits the exact ref observation at generation **22** with `cutoverAuthorized:false`. Focused D386 Live GitHub E2E **PASSED 1/1, EXIT 0** and all three disposable refs were independently verified absent twice by fresh read-only processes after runner cleanup; test local WAL was removed only after successful recovery. Offline D169/D352/D353 focused negatives **9/9 PASS**. This does **not** prove actual remote ref deletion/overwrite, installed OS/editor safety, Settings/Index Cutover or electrical power-loss durability. See `docs/engineering/d386-restarted-wal-negative-ref-observations-2026-11-11.md`.

## Official local release qualification

`pnpm qualify:local` is stricter than an ordinary manual live-E2E invocation because it is release authority for one exact commit.

The qualifier loads `GITHUB_E2E_OWNER`, `GITHUB_E2E_REPO`, `GITHUB_E2E_EXPECTED_REPO_ID`, and `GITHUB_E2E_TOKEN`, but it **does not use the configured manual `GITHUB_E2E_BRANCH`**. Instead it generates a unique branch:

```text
obsidian-sync-e2e/local-<sha12>-<run-id>
```

Only the child live-E2E process receives that branch override; `.env.github-e2e` is not rewritten.

Before the live child starts, official qualification proves:

- the E2E target is not the canonical/current source repository by repository route **or numeric repository ID**,
- the configured route resolves to the pinned numeric `GITHUB_E2E_EXPECTED_REPO_ID`,
- target repository metadata and its actual default Git ref are readable,
- the generated branch is not the target repository's actual default branch.

Credential scopes are separated deliberately. Install/build/test/compile children do not receive `GITHUB_E2E_TOKEN` or standard GitHub source/publication tokens such as `GH_TOKEN` / `GITHUB_TOKEN`. The destructive live-E2E child receives the dedicated `GITHUB_E2E_TOKEN` but has the standard source/publication GitHub token variables stripped.

After the live child returns, **whether the child succeeded or failed**, the qualifier performs bounded out-of-band cleanup restricted to the `obsidian-sync-e2e/local-` namespace:

1. re-prove the pinned target repository identity and readable actual default ref before each delete attempt,
2. read the exact unique qualification branch,
3. delete it if present,
4. re-prove the pinned target identity/default-ref capability again,
5. read the exact qualification branch **after that final proof** and require absence,
6. retry the bounded cleanup/verify sequence when appropriate.

A stale earlier 404 is never accepted as cleanup proof. A qualification receipt cannot be created unless the live child succeeded **and** the final post-proof branch read is absent.

D374 extends this contract to **three owned refs**, not just one: generated Source, SHA-256-derived frozen Backup, and SHA-256-derived new-key Destination. `qualify:local` independently verifies **all three** refs absent twice before starting live E2E, and attempts readback/cleanup for **each** after the child even when the live gate failed. A successful cleanup of Source and Backup does **not** hide a failed Destination cleanup; no qualification tag/receipt may be published when any cleanup cannot be proven. Only synthetic local tests with temporary bare Git repositories were used to validate the qualification contract; this does not authorize running a real `qualify:local` or publishing a tag to the source repository without explicit approval.

A hard process kill, machine loss, or power failure can prevent this outer cleanup from running. Because each official run uses a unique branch, any residue is isolated and the qualifier prints the safe branch identifier for manual inspection.

An already-valid remote qualification receipt for the exact current SHA/version/toolchain/gate contract may short-circuit a later `qualify:local` invocation after source/master/toolchain verification; E2E credentials are needed when creating a new qualification, not to re-prove an existing valid receipt.

## Local-only qualification — no hosted workflows

The only approved qualification workflow is the explicit maintainer-local `pnpm qualify:local` path. It verifies exact source commit SHA, canonical origin, toolchain, pinned disposable E2E repository identity, generated unique branch, real tests, and cleanup. There is no hosted qualification or GitHub Actions runner, and no need to configure GitHub Actions Environments.

Do not dispatch or enable GitHub Actions. The absence of workflow runs is intentional and is not a release blocker.

## Cleanup residue

Hard cancellation can prevent cleanup from running. Residue remains isolated by the run-specific branch.

For official local qualification, use the exact `obsidian-sync-e2e/local-...` branch printed by `qualify:local`.

Cleanup is fail-closed. Before each delete attempt for an official local qualification branch, the tool re-resolves the configured target, requires its numeric repository ID to equal `GITHUB_E2E_EXPECTED_REPO_ID`, rejects canonical/current source repository IDs, rejects the actual default branch, and proves the default Git ref is readable. Success requires another target proof followed by a fresh exact-branch read that is absent; an absence observed before that proof is not sufficient.

Never treat an arbitrary 404/422 as sufficient cleanup proof, and never reuse cleanup guidance against the source repository or a real notes branch.

## Metrics

The main suite prints safe JSON metrics per scenario containing scenario/mode, elapsed time, request/mutation counts, byte totals, retries, pacing/cooldown, unknown outcomes, transient-byte peak, and status classes. It does not log tokens, passphrases, logical file contents, or raw encrypted bytes. Raw branch polling/injection fetches are intentionally outside individual `GitHubClient` transport snapshots, while scenario elapsed time includes the whole scenario.
