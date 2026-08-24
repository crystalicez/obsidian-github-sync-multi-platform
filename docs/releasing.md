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
Variable: E2E_OWNER
Variable: E2E_REPO
Secret:   E2E_TOKEN
```

The target must be a dedicated disposable repository, not this source repository and not a real notes repository. Prefer a fine-grained token scoped only to the disposable repository with repository Contents read/write permission.

See `docs/github-e2e.md` for branch isolation and cleanup details.

## 3. Qualify the exact master SHA

In **Actions -> GitHub E2E Live -> Run workflow**, select `master` and start the workflow.

A qualifying run requires:

- source ref is `master`,
- dispatched `github.sha` is still the current `master` SHA,
- target E2E repository is not the source repository,
- job **qualify** succeeds,
- job **cleanup** succeeds.

The audit artifact is optional evidence. Stable release trusts exact-SHA workflow/job metadata, not artifact retention.

If `master` changes after qualification, the old run cannot qualify the new tip. Run GitHub E2E Live again.

## 4. Create a stable release

In **Actions -> Stable Release -> Run workflow**, select `master` and enter the exact stable `x.y.z` version already present in `package.json`/`manifest.json`.

Before publication the workflow verifies:

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
GITHUB_E2E_COMPILE_ONLY=1 corepack pnpm test:github-e2e:quick
corepack pnpm validate:package
```

The live GitHub REST suite is a separate credentialed qualification and does not replace physical Windows/Android or multi-gigabyte qualification evidence.
