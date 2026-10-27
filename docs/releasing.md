# Release runbook

Stable publication is explicit and exact-SHA qualified. A version bump or branch push never creates a public release by itself.

The **official local maintainer path** is currently the supported stable publication authority:

```text
pnpm qualify:local
-> durable exact-SHA qualification tag
-> pnpm release:local -- <version>
```

**Maintainer policy (2026-10-21): GitHub Actions must not be used, configured, dispatched, relied on, or required at any time.** This repository's supported release path is local-only. No workflow YAML files may be shipped in `.github/workflows/`. The local `qualify:local` / `release:local` exact-SHA safety checks and verified remote E2E cleanup remain mandatory; neither command is authorized to run automatically or without maintainer release approval.

## First public release: mandatory Re-encryption Wizard gate

**BLOCKED pending implementation and qualification.** The owner explicitly requires the Re-encryption Wizard before the first public release. `scripts/local-release.mjs` checks the tracked `docs/release-gates/reencryption-wizard.json` state **before any remote publication mutation** and refuses to proceed unless every reviewed acceptance check is marked `passed` and the gate is `qualified`. Never change the gate to `qualified` merely to bypass a failure. The maintainer must review the actual tests and evidence in [D66's Wizard contract](engineering/d66-reencryption-wizard-pre-release-contract-2026-10-24.md), including exact-source native encrypted migration, interrupted recovery and second-device cutover. Qualification alone cannot override this blocker. GitHub Actions remain prohibited.

**D74 owner decision (2026-10-24):** The destination topology is now approved as **Option A: a new orphan-root Git branch in the same repository, with no shared commit ancestry**. Only `ownerApprovedMigrationTopology` is marked `passed`; six other acceptance checks remain `pending`, and the overall gate is still `blocked`. The source branch must remain intact for recovery; destination data must be fully re-encrypted and verified on an independent second device before other devices switch. See [D74's approved migration contract](engineering/d74-approved-orphan-branch-migration-2026-10-24.md).

**D107 double-pass initiating-vault SHA-256 (2026-10-27):** D105/D106 now reread+SHA-256 **every physical scoped file a second time** with physical inventory and live guard observations between passes, because a local file can change after its first SHA while later files are hashed without size/mtime drift. Both mock and disposable Windows filesystem regressions confirm the second pass catches such modifications. This does **not** establish an atomic filesystem lock or approve local Cutover; doubles parity hashing time and still requires performance acceptance. See [D107 evidence](engineering/d107-double-pass-initiator-parity-2026-10-27.md). Windows Node-only WAL `fsync EPERM` and installed cross-device acceptance continue blocking release.

**D106 physical desktop initiating-vault read-only adapter (2026-10-27):** V4 Runtime can now create a real Node filesystem-backed reader that inventories every file physically on disk, rather than trusting stale Obsidian `getFiles()` cache, and binds D105 SHA-256 parity to actual Obsidian Sync/Editor/connection guards. It refuses symlinks/junctions/hardlinks, unsafe paths and detectable in-flight file changes; tests use disposable Windows filesystem and runtime fixtures. It is **not** a cross-process snapshot/write fence, durability certification, Wizard execution or local cutover. Node-only Windows WAL directory `fsync EPERM` remains a hard release block. See [D106 engineering evidence](engineering/d106-desktop-physical-initiator-reader-2026-10-27.md).

**D105 initiating-device local-vault parity (2026-10-27):** Before any new Destination ref, the internal D100/D102 publication path now requires exact full-vault read-only SHA-256 parity to the pinned authenticated Source, repeated across mutation barriers. It rejects unsynced local additions/deletions, open editors, settings/scope drift, queued Sync and same-size/same-mtime edits. It still uses an injected reader, not an audited atomic real Obsidian filesystem fence, and never authorizes local cutover. See [D105 evidence](engineering/d105-initiator-full-vault-parity-gate-2026-10-27.md). Node-only Windows WAL directory fsync EPERM and native installed cross-device tests still block release.

**D104 one-shot Staging after verified Backup (2026-10-27):** A newly encrypted, generation-CAS one-shot WAL marker now records the precise **Backup → Staging** phase boundary before the first Git Blob upload, including empty vaults. Starting Staging a second time after an interrupted process no longer succeeds merely because the WAL has no Blob receipts; D102 Destination publication and D103 read-only restart reconciliation require this marker. This is not power-cut proof: Windows Node.js directory `fsync EPERM` and safe initiating-device cutover still block release. See [D104 tests and limits](engineering/d104-one-shot-staging-handoff-2026-10-27.md). No real GitHub migration or installed Obsidian two-device proof this stage.

**D101–D103 encrypted ref-intent WAL/restart (2026-10-27):** Backup and Destination Git ref intents, exact SHA/tree and verified readback observations are now recorded inside the existing encrypted two-slot WAL. D102 binds the D99/D100 create-only primitives and staged Blob receipts to healthy WAL generation, exclusive lease and crash-durability checks, while D103 read-only recovery can revalidate lost GitHub responses after restart without repeating branch mutations. An actual Windows filesystem WAL lock-release/reopen readback test passes but **does not establish power-loss durability** (D86 directory fsync `EPERM` still blocks real publication). [D101–D103 evidence](engineering/d101-d103-encrypted-ref-intent-wal-recovery-2026-10-27.md). Preview-only Re-encryption release remains blocked.

**D99–D100 three-branch guarded publication (2026-10-26):** New internal Backup create/ref/old-key complete readback combines with D85 isolated Scratch Restore evidence and D98 encrypted Destination verification. Cross-run SHA/tree/repo/count/size, initiator-edit and WAL/lease guards must pass before Destination publication. A fresh read-only Backup ref/commit/physical identity/default-branch verification runs repeatedly around the destination mutation so a lost or retargeted frozen backup fails closed. Neither callbacks nor structural reports are proof of Windows power-loss durability; current D86 Node-only directory `fsync EPERM` still forbids production migration. Both backup/destination definitively rejected HTTP 422s now fail closed rather than being misclassified as lost successful create. See [D99–D100 evidence](engineering/d99-d100-three-branch-gated-publication-2026-10-26.md). Release stays `blocked`; Wizard is preview-only.

**D97–D98 orphan publication recovery (2026-10-26):** The backend now reconciles a lost/ambiguous destination `createGitRef` response with **GET-only**, exact-commit, new-key full ciphertext authentication; an internal wrapper can do one create-ref then mandatory remote full readback, but never automatically retries or permits initiating-device cutover. The external durable intent callback has not been integrated with a proven Windows WAL. The real GitHub E2E scenario includes D97 readback but the live run stopped at preflight because `GITHUB_E2E_EXPECTED_REPO_ID` was missing; no remote mutations occurred. See [D97–D98 evidence](engineering/d97-d98-orphan-publication-reconciliation-2026-10-26.md). Re-encryption Wizard remains preview-only and release-gated.

**D96 orphan writer, readback and scratch restore (2026-10-26):** New backend creates encrypted V4 metadata, immutable Git root tree without `base_tree`, and zero-parent orphan commit; a separate create-only ref helper requires an externally durable publication-intent gate and refuses ambiguous retry. Simulated real V4-crypto roundtrip validates new passphrase decryption. Frozen backup scratch restore can use the pinned immutable snapshot despite old-branch HEAD advancement. **NOT wired to Wizard**, no live GitHub migration or native Obsidian test, and Windows WAL power-loss durability remains blocked. See [D96 implementation evidence](engineering/d96-orphan-root-writer-and-immutable-backup-restore-2026-10-26.md).

**D95 pinned-snapshot and backup-reconciliation follow-up (2026-10-26):** New opt-in read-only fork-source verification tolerates other devices advancing old source HEAD after the immutable snapshot pin, while normal strict readers retain their stable-head checks. Wizard source preflight rechecks physical repo identity/default branch. A new **read-only** ambiguous backup creation recovery helper can classify absent/conflicting/matching refs and fully read back matching encrypted backup contents, but cannot retry/create/publish/cut over. See [D95 evidence](engineering/d95-immutable-fork-snapshot-and-backup-ambiguity-2026-10-26.md). Release still blocked.

**D94 D90-consistency repair (2026-10-26):** Frozen backup readback authenticates the pinned snapshot SHA/tree even if normal devices have since advanced the old source branch; ordinary old-branch Sync must NOT be blocked for that reason. The backup ref must still point exactly at the snapshot. In addition to the **pointer-only** inspector, a separate **full authenticated backup-content readback** now uses the frozen branch's immutable SHA to decrypt and verify every live file. Neither proof establishes writer provenance, durable restore, or authorization to re-encrypt/publish/cut over. Release remains blocked.

**D92–D93 first implementation (2026-10-26):** Settings now offers a **Preview wizard**. It does read-only authenticated source verification, creates a sanitized 3-branch proposal, checks candidate ref absence, and previews blocked run/cutover stages. A separate guarded create-only backup-ref helper exists but is not wired to the Wizard. **No live re-encryption, backup ref publication, or device switch is enabled.** See [D92–D93 engineering evidence](engineering/d92-d93-readonly-wizard-and-frozen-backup-ref-2026-10-26.md).

**D91 owner-approved Wizard UX (2026-10-26):** **Mandatory 3-branch** source (still Syncable), pinned frozen backup, freshly encrypted orphan destination, all in the same physical GitHub repository; 5-step Wizard, initiating-device-only verified switch, other devices optional/manual. See [D91 approved Wizard UX](engineering/d91-owner-approved-reencryption-wizard-ux-2026-10-26.md). UI and production migration remain unimplemented / blocked. **D90/D91 supersede earlier D74–D89 statements about fleet-wide stale-client fencing or mandatory old-device cutover; those older statements are historical, not current release requirements.**

**D90 owner fork policy (2026-10-26):** Re-encryption creates a NEW independently encrypted orphan branch from one pinned immutable source snapshot. All other clients MAY continue to Sync the old source branch and only switch manually if desired; no global device acknowledgement, central migration marker, or forced source-branch Sync blocking. The initiating device may switch to the destination only after verified completion. The Wizard remains blocked. See [D90 final fork policy](engineering/d90-owner-independent-reencryption-fork-policy-2026-10-26.md).

**D88 owner backup policy (2026-10-26):** The owner knowingly accepted a **verified backup branch in the SAME GitHub repository** as sufficient backup *location* for first-release Re-encryption (shared repository/account failure risk accepted). It is **not** an independently stored copy. `backupPolicy` in the release manifest pins this choice; the release checker enforces it. **No backup proof has passed**: `safePreviewAndBackup` and all other unfinished checks remain pending, and `status` stays `blocked`. An actual safe backup-ref writer, authenticated full readback/restore, source/stale-client fencing, Node.js WAL durability and independent second-device migration acceptance are still required. See [D88's explicit backup acceptance contract](engineering/d88-owner-verified-same-repository-backup-policy-2026-10-26.md).

## 1. Bump release metadata

Use the repository helper so `package.json`, `manifest.json`, and `versions.json` move together:

```bash
pnpm ver -- patch
# or: pnpm ver -- minor
# or: pnpm ver -- major
# or: pnpm ver -- 1.2.3
```

The helper rejects inconsistent current metadata, malformed/non-increasing targets, and a target already present in `versions.json`. Version arithmetic/comparison is exact even for numeric components larger than JavaScript's safe integer range.

Commit/merge the version and source changes to `master`. The release commands require the exact current `master` SHA; qualification evidence for an earlier SHA cannot qualify a later commit even when the version is unchanged.

## 2. Local maintainer prerequisites

Before the official local flow, require:

- clean checkout on branch `master`,
- exactly one effective `origin` fetch URL and one effective `origin` push URL, both resolving to `crystalicez/obsidian-github-sync-multi-platform`,
- Node exactly matching `.node-version` (`v24.11.0` at this writing),
- Corepack pnpm exactly matching `package.json#packageManager` (`9.12.3` at this writing),
- configured Git committer/tagger identity,
- Git authentication able to push qualification tags to the canonical source repository,
- GitHub CLI authenticated on **github.com** with push/Contents-write access to the canonical source repository,
- a dedicated disposable real-GitHub E2E repository, its pinned numeric repository ID, and a token with Contents read/write permission,
- that E2E repository must not be this source repository by route/name **or numeric repository ID** and must not contain real user notes.

Create `.env.github-e2e` from `.env.github-e2e.example` or provide the equivalent process environment, including `GITHUB_E2E_EXPECTED_REPO_ID`. The configured manual branch is ignored by official qualification; `qualify:local` generates a unique branch for its own destructive run.

The local release path pins GitHub CLI operations to `github.com`; an inherited `GH_HOST`/enterprise host or `GH_REPO` does not redirect publication.

## 3. Official local exact-SHA qualification

### POSIX shell

```bash
corepack pnpm install --frozen-lockfile
pnpm qualify:local
```

### PowerShell

```powershell
corepack pnpm install --frozen-lockfile
pnpm qualify:local
```

`qualify:local` performs cheap source/toolchain/remote checks first, then runs these gates in authority order:

```text
metadata-validation
install-frozen
build
package-validation
fast-tests
repeat-tests
recovery-tests
resource-tests
feasibility-tests
github-e2e-compile
github-e2e-live
github-e2e-cleanup-verified
```

Important qualification behavior:

- build runs before full package validation because `validate:package` requires generated `main.js`,
- the destructive E2E target is checked against the current/canonical source repository by route/name and numeric ID, the pinned numeric target repository ID, readable actual default Git ref, and the target repository's actual default branch,
- non-live qualification gates receive neither the E2E target token nor standard GitHub source/publication tokens; the live child receives the dedicated E2E token but not the standard source/publication token variables,
- official qualification overrides the configured branch with `obsidian-sync-e2e/local-<sha12>-<run-id>`,
- cleanup is restricted to the local-qualification namespace, re-proves target identity/default-ref capability before delete attempts, and only accepts branch absence when a fresh exact-branch read occurs **after** the final target proof,
- source `HEAD`, canonical fetch/push origins, metadata/toolchain, remote `master`, and qualification-ref absence are rechecked after the long gates,
- only then is one annotated qualification tag object pushed to:

```text
refs/tags/qualification/local/v1/<version>/<full-sha>
```

The annotated tag contains the validated JSON receipt and points directly to that commit. A local same-named tag is not authority.

If the exact remote receipt already exists and independently validates for the exact current SHA/version/toolchain/gate contract, `qualify:local` reports it as already qualified instead of rerunning expensive gates.

## 4. Inspect local qualification evidence

Before first publication, record the source SHA printed by `qualify:local` and inspect the remote qualification ref. For example:

```bash
VERSION=1.0.8
SHA=<full-qualified-sha>
git ls-remote origin "refs/tags/qualification/local/v1/$VERSION/$SHA"
```

PowerShell equivalent:

```powershell
$Version = "1.0.8"
$Sha = "<full-qualified-sha>"
git ls-remote origin "refs/tags/qualification/local/v1/$Version/$Sha"
```

The release command performs the complete annotated-tag-object and receipt validation itself; this manual inspection is an additional maintainer audit step.

## 5. Official local stable release

Run release from the same exact qualified `master` commit.

### POSIX shell

```bash
pnpm release:local -- 1.0.8
```

### PowerShell

```powershell
pnpm release:local -- 1.0.8
```

The release command:

1. proves clean canonical `master == remote master`, exact metadata/toolchain, GitHub auth, monotonic version, requested stable-ref absence, requested draft/published release absence, and exact remote qualification evidence,
2. snapshots the remote qualification **tag-object SHA**,
3. reruns publication-machine gates: frozen install, build, package validation, fast tests, and GitHub-E2E compile,
4. stages release bytes under ignored `.tmp/release/<version>/` only after proving the staging ancestors are real directories rather than symlinks,
5. requires release-authority metadata, the generated `main.js`, the canonical lockfile, and staged upload assets to be real regular files; reads `manifest.json` and `styles.css` from exact `HEAD` Git blobs and `main.js` from the just-built output,
6. creates the deterministic repository-rooted ZIP and computes size/SHA-256 for all four assets,
7. rechecks source/master/origin/evidence/publication absence immediately before mutation,
8. atomically claims the lightweight stable `x.y.z` ref with GitHub's create-reference API,
9. rechecks master/evidence/stable-ref/release state,
10. creates an explicit **draft** release with `--verify-tag` and uploads the four staged assets,
11. verifies the exact remote asset name set, uploaded state, byte sizes, and SHA-256 digests,
12. rechecks master, exact qualification tag-object identity, stable ref, draft flags, metadata, and asset bytes immediately before publication,
13. publishes only by changing the verified draft to `draft=false`,
14. post-verifies stable ref, qualification object, final release flags/tag, and all four remote asset bytes.

The ZIP asset is named:

```text
obsidian-github-sync-multi-platform-v<version>.zip
```

and contains exactly:

```text
obsidian-github-sync-multi-platform/main.js
obsidian-github-sync-multi-platform/manifest.json
obsidian-github-sync-multi-platform/styles.css
```

The current packager emits a minimal deterministic ZIP32 **stored** archive (no compression) for this fixed three-file contract. ZIP entry names reject absolute, empty-segment, `.`, `..`, and backslash traversal shapes; see `docs/superpowers/specs/2026-08-28-local-release-packaging-amendment.md`.

## 6. Partial/ambiguous publication state

Stable tag creation, draft creation/upload, and draft publication are not one cross-resource transaction. The local tool therefore never automatically deletes, force-updates, clobbers, or implicitly resumes pre-existing stable publication state.

State model:

```text
qualification receipt
-> create-only stable ref
-> explicit draft
-> verified draft assets
-> published release
-> post-verification
```

If a command reports ambiguous/partial state:

- do **not** rerun blindly,
- do **not** force-update the stable tag,
- do **not** use `gh release upload --clobber`,
- do **not** automatically delete the stable tag/draft/release.

Inspect first:

```bash
VERSION=1.0.8
git ls-remote --tags origin "refs/tags/$VERSION"
gh release view "$VERSION" --repo crystalicez/obsidian-github-sync-multi-platform
```

PowerShell:

```powershell
$Version = "1.0.8"
git ls-remote --tags origin "refs/tags/$Version"
gh release view $Version --repo crystalicez/obsidian-github-sync-multi-platform
```

Version 1 intentionally treats a stable ref/draft left by a previous invocation as inspection-only state rather than silently claiming ownership and resuming it. Manual remediation/completion is a maintainer decision.

A failed publish command may still reconcile as success only when a fresh read proves the exact final non-draft/non-prerelease release, exact stable SHA, unchanged qualification tag object, and byte-matching four-asset set.

## 7. Local-only real GitHub E2E qualification

Use the pinned disposable repository credentials in the untracked `.env.github-e2e` file, with `GITHUB_E2E_EXPECTED_REPO_ID` set to its numeric ID. Only the local `pnpm qualify:local` command on a clean exact current `master` commit may create a qualification receipt. It generates a unique `obsidian-sync-e2e/local-...` branch, validates repository identity and default ref, runs tests with the dedicated E2E token, then verifies remote branch absence after cleanup. It must not be invoked casually on an audit branch.

No GitHub Actions / hosted workflow dispatch, CI artifacts, Environment secrets, or workflow-run status is a qualification or release prerequisite. Do not recreate or enable workflow files.

## 8. Deterministic verification before merge/release

Before merging release-tooling changes, run:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm validate:package
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
```

Do not run `pnpm qualify:local` or `pnpm release:local` merely as implementation tests: those commands intentionally mutate real remote qualification/publication state when their preconditions are satisfied.

Before the first production publication from Windows, also run the focused release safety tests natively on Windows with the committed Node/pnpm versions. Injected `win32` command-construction tests are not a substitute for that first native verification.
