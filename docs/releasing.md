# Release runbook

Stable publication is explicit and exact-SHA qualified. A version bump or branch push never creates a public release by itself.

The **official local maintainer path** is currently the supported stable publication authority:

```text
pnpm qualify:local
-> durable exact-SHA qualification tag
-> pnpm release:local -- <version>
```

GitHub Actions live qualification remains available, but **Actions -> Stable Release is still temporarily interlocked** by `.github/workflows/release.yml` until the approved Release Provenance and Versioning implementation replaces the legacy Actions publication path. Do not remove that interlock as part of local-release operation.

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
- Node exactly matching `.node-version` (`v22.11.0` at this writing),
- Corepack pnpm exactly matching `package.json#packageManager` (`9.12.3` at this writing),
- configured Git committer/tagger identity,
- Git authentication able to push qualification tags to the canonical source repository,
- GitHub CLI authenticated on **github.com** with push/Contents-write access to the canonical source repository,
- a dedicated disposable real-GitHub E2E repository, its pinned numeric repository ID, and a token with Contents read/write permission,
- that E2E repository must not be this source repository and must not contain real user notes.

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
- the destructive E2E target is checked against the current/canonical source repository, pinned numeric target repository ID, readable actual default Git ref, and the target repository's actual default branch,
- official qualification overrides the configured branch with `obsidian-sync-e2e/local-<sha12>-<run-id>`,
- after the live child returns, bounded out-of-band cleanup proves that unique branch is absent before qualification can succeed,
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
4. stages release bytes under ignored `.tmp/release/<version>/`,
5. reads `manifest.json` and `styles.css` from exact `HEAD` Git blobs and `main.js` from the just-built output,
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

The current packager emits a minimal deterministic ZIP32 **stored** archive (no compression) for this fixed three-file contract; see `docs/superpowers/specs/2026-08-28-local-release-packaging-amendment.md`.

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

## 7. Configure the disposable live-E2E environment

In repository **Settings -> Environments**, create `github-e2e` with:

```text
Deployment branches and tags -> Selected branches and tags
Allowed branch -> master
Allowed tags -> none

Variable: E2E_OWNER
Variable: E2E_REPO
Variable: E2E_REPO_ID
Secret:   E2E_TOKEN
```

Do not use **Protected branches only** while `master` has no branch-protection rule. `E2E_REPO_ID` is the pinned numeric authority; owner/repository text is routing only. The target must be an initialized dedicated disposable repository, not this source repository and not a real notes repository. The release-qualifying target credential must have mutable scope only to that target repository.

See `docs/github-e2e.md` for branch isolation, target-ID checks, cleanup evidence, and rerun semantics.

## 8. Qualify the exact master SHA

Before dispatching the live workflow, require ordinary CI for the exact current `master` SHA to complete successfully. The current CI attempt must publish the exact release-qualifying artifact:

```text
github-e2e-input-<master-sha>-<ci-run-id>-<ci-current-attempt>
```

Then in **Actions -> GitHub E2E Live -> Run workflow**, select `master` and start the workflow.

The Child-B qualification flow is:

```text
ordinary CI exact master/current attempt succeeds
-> current github-e2e-input artifact exists
-> GitHub E2E Live current attempt consumes and verifies it
-> same-attempt receipt persists before target mutation
-> qualify succeeds
-> cleanup succeeds in the same current attempt
```

A release-qualifying live run requires its **current/latest workflow attempt** to be cohesive:

- source ref is `master` and dispatched `github.sha` is still current `master`,
- newest exact-SHA ordinary CI `push` run is the authoritative producer and its current attempt/`verify` job succeeded,
- the selected CI E2E artifact is unexpired and bound to that producer/source SHA,
- pinned target repository ID differs from the source repository ID and its actual default Git ref is readable,
- same-attempt qualification receipt exists before scenario mutation and binds source, CI producer/artifact, and target identity,
- job **qualify** executes in that attempt and succeeds,
- job **cleanup** executes in that same attempt and succeeds.

If cleanup fails, **Re-run failed jobs** may be used to remove residue safely. That cleanup-only attempt is not release qualification. Use **Re-run all jobs** to create a new cohesive current attempt before release qualification is restored.

If `master` changes after qualification, or ordinary CI is rerun for the same SHA and a newer producer attempt becomes authoritative, the previous live evidence is stale. Run **GitHub E2E Live** again.

## 9. Actions Stable Release is temporarily interlocked

Do **not** dispatch **Stable Release** while only the Live-E2E Safety child is installed. The legacy release gate cannot prove the new same-attempt receipt is bound to the current authoritative CI producer, so the workflow is intentionally fail-closed until the approved **Release Provenance and Versioning (Child A)** implementation replaces it.

The temporary interlock is enforced in `.github/workflows/release.yml` before checkout or repository code execution, and the default workflow token is read-only (`actions: read`, `contents: read`). The interlock must not be removed as a manual workaround.

Child A will replace the legacy release path with the approved flow:

```text
newest exact-SHA/current-attempt CI authority
-> newest exact-SHA/current-attempt cohesive Live E2E authority
-> same-attempt receipt binds the exact current CI producer/artifact
-> promote exact CI-produced release bytes
-> isolated tag/draft/assets/publish state machine
```

Until that implementation lands, version bumps, ordinary CI, Branch Candidate Builds, and GitHub E2E Live qualification remain available, but stable publication is deliberately unavailable.

## 10. Branch candidate builds

`.github/workflows/pre-release.yml` is intentionally an artifact-only **Branch Candidate Build**. It can build/test non-master manifest-version candidates, but it has read-only repository permission and never creates tags or GitHub Releases.

There is no automatic public alpha/beta channel in the current release design.

## 11. Historical Actions partial publication state

The legacy publication steps remain below the temporary interlock only as code to be replaced by Child A; they are unreachable while the interlock is active. If inspecting historical partial publication state from a run before the interlock, remember that tag creation, release creation, and asset upload were not one cross-resource transaction.

```bash
VERSION=1.2.3
gh release view "$VERSION" --repo crystalicez/obsidian-github-sync-multi-platform || true
git ls-remote --tags origin "refs/tags/$VERSION"
```

Do not automatically delete a tag/release just because an older workflow failed. Inspect whether a valid release already exists, then remove only state the maintainer has determined is partial/invalid.

## 12. Deterministic verification before merge/release

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
