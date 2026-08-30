# Release runbook

Stable publication is explicit and exact-SHA qualified. A version bump or branch push never creates a public release by itself.

## 1. Bump release metadata

Use the repository helper so `package.json`, `manifest.json`, and `versions.json` move together:

```bash
pnpm ver -- patch
# or: pnpm ver -- minor
# or: pnpm ver -- major
# or: pnpm ver -- 1.2.3
```

The helper rejects inconsistent current metadata, malformed/non-increasing targets, and a target already present in `versions.json`.

Commit/merge the version and source changes to `master`, then require ordinary deterministic CI to pass.

## 2. Configure the disposable live-E2E environment

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

## 3. Qualify the exact master SHA

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

## 4. Create a stable release

In **Actions -> Stable Release -> Run workflow**, select `master` and enter the exact stable `x.y.z` version already present in `package.json`/`manifest.json`.

Before publication the current Stable Release workflow verifies:

- requested version/compatibility metadata are consistent,
- requested stable version is monotonic and its tag/release does not already exist,
- target SHA is current `master`,
- a successful **GitHub E2E Live** run exists for that exact SHA with successful `qualify` and `cleanup` jobs,
- frozen pnpm install, build, fast/repeat/recovery/resource/feasibility tests, GitHub-E2E compile gate, and package validation all pass,
- `master` still points to the same SHA immediately before publication.

Only then does the workflow call `gh release create` for the exact qualified SHA and upload:

- `main.js`,
- `manifest.json`,
- `styles.css`,
- packaged plugin ZIP.

The Stable Release publication implementation itself is not redesigned by the live-E2E safety work described above; publication hardening belongs to the separate release child design.

## Branch candidate builds

`.github/workflows/pre-release.yml` is intentionally an artifact-only **Branch Candidate Build**. It can build/test non-master manifest-version candidates, but it has read-only repository permission and never creates tags or GitHub Releases.

There is no automatic public alpha/beta channel in the current release design.

## Partial publication failure

Tag creation, release creation, and asset upload are not one cross-resource transaction. If the final publication command fails after mutation starts, inspect actual GitHub state before retrying or deleting anything.

```bash
VERSION=1.2.3
gh release view "$VERSION" --repo crystalicez/obsidian-github-sync-multi-platform || true
git ls-remote --tags origin "refs/tags/$VERSION"
```

Do not automatically delete a tag/release just because the workflow failed. Inspect whether a valid release already exists, then remove only state the maintainer has determined is partial/invalid. The Stable Release workflow remains fail-closed while a conflicting tag or release exists.

## Local deterministic verification

Before dispatching qualification/release, the equivalent local gate is:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test
corepack pnpm test:repeat
corepack pnpm test:recovery
corepack pnpm test:resource
corepack pnpm test:feasibility
corepack pnpm test:github-e2e:compile
corepack pnpm validate:package
```

The live GitHub REST suite is a separate credentialed qualification and does not replace physical Windows/Android or multi-gigabyte qualification evidence.
