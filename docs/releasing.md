# Release runbook

Stable publication is explicit and exact-SHA qualified. A version bump or branch push never creates a public release by itself.

There are two independent supported authority paths:

1. **Official local maintainer path:** `pnpm qualify:local` -> durable exact-SHA qualification tag -> `pnpm release:local -- <version>`.
2. **GitHub Actions path:** GitHub E2E Live -> Stable Release workflow.

The local path does not require, wait for, or trust an Actions qualification run. The Actions release path continues to require its own Actions-native qualification evidence.

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
- a dedicated disposable real-GitHub E2E repository and token with Contents read/write permission,
- that E2E repository must not be this source repository and must not contain real user notes.

Create `.env.github-e2e` from `.env.github-e2e.example` or provide the equivalent process environment. The configured manual branch is ignored by official qualification; `qualify:local` generates a unique branch for its own destructive run.

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
- the destructive E2E target is checked against both the current/canonical source repository and the target repository's actual default branch,
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

## 7. GitHub Actions release path

The existing Actions path remains supported and independent.

Configure repository **Settings -> Environments -> `github-e2e`** with:

```text
Variable: E2E_OWNER
Variable: E2E_REPO
Secret:   E2E_TOKEN
```

Then:

1. run **Actions -> GitHub E2E Live** on `master`,
2. require both `qualify` and `cleanup` jobs to succeed for the exact current `master` SHA,
3. run **Actions -> Stable Release** for the exact stable version.

The Actions Stable Release workflow continues to require Actions-native exact-SHA qualification; it does not trust local qualification tags in v1.

## 8. Incidental CI triggered by tags

The local authority path does not depend on GitHub Actions, but the repository's ordinary CI currently listens to unfiltered `push`. Qualification/stable tag creation can therefore trigger incidental CI runs.

Those runs are non-authoritative for the local path and are neither awaited nor used as local qualification evidence. This is not a promise of zero Actions executions.

## 9. Branch candidate builds

`.github/workflows/pre-release.yml` remains an artifact-only **Branch Candidate Build**. It can build/test non-master manifest-version candidates, but it has read-only repository permission and never creates tags or GitHub Releases.

There is no automatic public alpha/beta channel in the current release design.

## 10. Deterministic verification before merge/release

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
