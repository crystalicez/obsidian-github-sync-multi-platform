# Official Local Qualification and Release Design — Audited V2

## Status

This document is the authoritative design for the local qualification and stable-release work. It supersedes `docs/superpowers/specs/2026-08-26-local-qualification-and-release-design.md`.

It was re-audited against the current repository, current Git behavior, current GitHub CLI behavior, and the current GitHub Actions workflows before implementation began.

## Goal

Provide a first-class maintainer workflow that can qualify and publish a stable release from a trusted local machine **without depending on GitHub Actions for qualification or publication authority**, while preserving exact-SHA release safety and the existing Actions path.

The local path must:

1. qualify exactly the commit that will be released,
2. persist durable, remotely inspectable qualification evidence,
3. fail closed on every observed mismatch or unknown remote state before an authority-changing mutation,
4. isolate destructive real-GitHub E2E work from the source repository and from concurrent local runs,
5. preserve deterministic/package gates and exact release assets,
6. avoid blind retries after ambiguous Git/GitHub mutations,
7. never automatically delete, force-update, or clobber partial stable publication state,
8. work from PowerShell/Windows and POSIX environments,
9. keep GitHub Actions as a separate, independently qualified release path,
10. make recovery state inspectable rather than pretending several remote resources form one transaction.

The local path does **not** promise that GitHub Actions will never run incidentally. The repository's ordinary CI currently triggers on every `push`, so pushing a qualification tag or creating a stable tag may cause a non-authoritative CI run. The local workflow neither waits for nor trusts such a run.

The V4 sync/runtime behavior and real-E2E scenario semantics are outside this feature.

---

# 1. Decision Ledger

This section records the problem, meaningful alternatives, chosen answer, rationale, rejected alternatives, and proof obligation for every material design choice. It is a review artifact, not private reasoning.

## D1. What is local qualification authority?

**Problem:** A terminal log or local JSON file can be lost, edited, or detached from the commit later released.

**Options:**

- local file/log only,
- GitHub commit status/check,
- Git note/custom ref,
- namespaced annotated Git tag.

**Decision:** Use a namespaced annotated Git tag.

**Why:** A tag is durable GitHub-hosted state, fetchable with ordinary Git, directly binds to a Git object, is easy to inspect without Actions, and requires no new service/database. A custom check/status would add API/scoping complexity and would still be a maintainer assertion rather than physical proof that tests ran.

**Proof:** Release verification starts from the remote qualification ref, verifies an annotated tag object, validates its message schema, and requires a direct target commit equal to the release SHA.

## D2. Is peeled commit identity enough?

**Problem:** A qualification ref can be deleted/recreated with a different receipt that still peels to the same commit.

**Options:**

- verify only peeled commit SHA,
- verify the exact remote annotated tag object SHA and its direct commit target.

**Decision:** Snapshot and recheck the exact remote qualification tag-object SHA.

**Why:** The evidence object itself is part of the authority. Same commit does not imply same receipt.

**Proof:** Before release work begins, snapshot `qualificationTagObjectSha`; before stable-ref creation, before draft publication, and in post-publication verification, require the remote qualification ref to still point to that same object SHA.

## D3. Can a qualification tag point to another annotated tag?

**Decision:** No. The qualification tag object must have target type `commit` and target the exact qualified SHA directly.

**Why:** Tag-to-tag chains add ambiguity with no benefit for this receipt format.

## D4. How is the stable version ref claimed under concurrency?

**Problem:** A normal `git push <sha>:refs/tags/<version>` is no-force but is not an invocation-ownership primitive: if the exact same ref/SHA already exists, Git may report it as up to date.

**Options:**

- let `gh release create` implicitly create the tag,
- ordinary no-force Git push,
- GitHub REST **Create a reference** API.

**Decision:** Use GitHub's create-reference API for `refs/tags/<version>`.

**Why:** The endpoint is create-only. A successful create proves this invocation created the ref; a pre-existing same-SHA ref is not silently accepted as this invocation's state. The created ref points directly to the commit, preserving the repository's existing lightweight stable-tag shape.

**Proof:** Zero-exit API create + exact follow-up ref read is required. Any nonzero/transport result stops the state machine after read-only inspection, even if the ref is subsequently observed at the expected SHA.

## D5. Why not publish with one `gh release create ...assets...` command?

**Problem:** Current GitHub CLI stages a non-draft release with assets as a temporary draft and attempts to delete that draft if asset upload or final publish fails.

**Decision:** Use an explicit durable draft and an explicit later publish.

**Why:** Automatic draft deletion contradicts the project's unknown-outcome discipline. Explicit draft state is inspectable and can safely remain for manual recovery.

## D6. What is the stable publication state machine?

**Decision:**

```text
preflight
-> qualification snapshot
-> publication-machine gates
-> deterministic staging
-> final pre-mutation recheck
-> create-only stable ref
-> recheck exact evidence/master
-> explicit draft + asset upload
-> exact remote asset verification
-> final evidence/master/draft recheck
-> explicit draft publish
-> post-publication verification
```

Every arrow may fail closed. No automatic reverse mutation exists for stable publication state.

## D7. How are ambiguous mutations handled?

**Decision:** Inspect; never blindly retry.

- Qualification-tag push may reconcile as success only if the remote ref equals this invocation's unique annotated tag-object SHA.
- Stable-ref creation cannot reconcile ownership after a nonzero/unknown result, because the lightweight ref contains no per-invocation identity; stop for inspection.
- Draft-create/upload ambiguity stops after read-only inspection; do not retry, delete, or clobber.
- Final publish ambiguity may reconcile only when fresh remote state proves the exact intended final published release and byte-identical assets.

## D8. Should a later invocation automatically resume a partial stable tag/draft?

**Decision:** No in v1.

**Why:** A later process cannot safely infer ownership of state created manually or concurrently. A pre-existing requested stable ref or draft/published release is inspection-only and blocks the normal command.

A future explicit recovery command can have a separately designed ownership/reconciliation contract.

## D9. How is destructive local E2E prevented from damaging source repositories?

**Decision:** All destructive local live-E2E invocations reject the target repository when it equals either:

- the GitHub repository represented by the current clone's origin, or
- the canonical source repository `crystalicez/obsidian-github-sync-multi-platform`.

Protected-looking branch names remain rejected, and the target repository's actual default branch is fetched and rejected before mutation.

**Why:** The current runner's branch-name blacklist alone does not prevent deleting a non-default feature branch in the source repository.

## D10. Must manual E2E clones have the canonical origin?

**Decision:** No.

**Why:** Manual E2E is useful from forks and ordinary clones. The live runner needs to identify its source repository to reject destructive self-targeting; it does not need canonical-maintainer authority.

Only `qualify:local` and `release:local` require the canonical source origin.

## D11. How is official qualification E2E isolated from concurrent local runs?

**Decision:** `qualify:local` overrides the configured E2E branch in the child environment with a unique branch:

```text
obsidian-sync-e2e/local-<sha12>-<run-id>
```

The `.env.github-e2e` file is not modified.

**Why:** A static configured branch lets two machines delete/reset each other's test state.

## D12. What happens to the unique E2E branch after failure?

**Options:**

- verify absence only after success,
- perform an out-of-band bounded cleanup after the live command returns, regardless of live success/failure.

**Decision:** Perform bounded cleanup after every returned live run.

**Why:** GitHub Actions already uses an independent `cleanup` job with `if: always()`. The local qualifier should get the same operational property. This cleanup is safe because the branch is unique and the target repository has already passed disposable/source/default-branch guards.

Qualification succeeds only if both the live suite succeeds and cleanup is proven complete. A hard process termination can still leave residue; the branch name is printed for manual cleanup.

## D13. What E2E checks happen before the expensive deterministic suite?

**Decision:** Resolve credentials without printing them, fetch the target repository metadata, prove the repo is readable, reject source repositories, read the real default branch, and reject the selected branch if it equals that default branch.

**Why:** Configuration failures should be caught before running minutes of deterministic tests.

## D14. How strict is the stable version syntax?

**Problem:** A stricter new SemVer policy would diverge from the existing `pnpm ver` helper and Actions workflow, both of which accept `digits.digits.digits`.

**Options:**

- introduce strict canonical SemVer (no leading zeros),
- preserve the repository's existing stable-triple syntax.

**Decision:** Preserve existing syntax:

```regex
^\d+\.\d+\.\d+$
```

No `v` prefix or prerelease suffix is accepted. Numeric ordering uses exact `BigInt` components instead of JavaScript `Number`.

**Why:** This feature should not silently introduce a new versioning policy while the Actions path remains unchanged.

`update-version.js` should use the same exact numeric comparison so the helper and local release do not disagree at very large components.

## D15. Why split metadata validation from package validation?

**Problem:** `validate-package.mjs` requires `main.js`, but `main.js` is ignored and generated by build.

**Decision:** Add metadata-only validation for preflight, then run `build` before the existing/full package validation.

**Qualification order:**

```text
metadata validation
install --frozen-lockfile
build
validate:package
fast tests
repeat tests
recovery tests
resource tests
feasibility tests
E2E compile
live E2E
E2E cleanup verification
```

This prevents a fresh checkout from failing on missing `main.js` and prevents a stale ignored `main.js` from being treated as current build output.

## D16. Is the runtime toolchain part of qualification authority?

**Decision:** Yes for Node/pnpm versions.

- running Node must equal committed `.node-version`, currently `v22.11.0`,
- Corepack pnpm must equal the version in `package.json#packageManager`, currently `9.12.3`.

The receipt records both and release verification requires them to match the declarations of the qualified commit.

Platform/architecture remains audit metadata rather than a release-eligibility requirement.

## D17. How are canonical Git remotes validated?

**Decision:** Official qualify/release require exactly one effective fetch URL and one effective push URL for `origin`, and both must normalize to the canonical GitHub repository.

Inspect both:

```text
git remote get-url --all origin
git remote get-url --push --all origin
```

**Why:** `remote.origin.pushurl` can differ from the fetch URL. Checking only fetch `origin` can allow qualification evidence to be pushed elsewhere.

Credential-bearing raw URLs are never echoed in errors.

## D18. Where do direct-upload static asset bytes come from on Windows?

**Problem:** A clean Git worktree can contain checkout-transformed CRLF bytes while the committed blob contains LF bytes.

**Options:**

- rely on `.gitattributes`,
- upload working-tree bytes,
- stage tracked static assets directly from exact `HEAD` Git blobs.

**Decision:** Stage `manifest.json` and `styles.css` from exact `HEAD` blobs. Stage `main.js` from the just-built generated output.

**Why:** Blob staging is robust against `core.autocrlf`, clean/smudge filters, and existing checkout state. A new `.gitattributes` policy is unnecessary for release correctness and is therefore out of scope.

## D19. How is the ZIP produced cross-platform?

**Options:**

- external `zip` executable,
- hand-written ZIP/CRC32 implementation,
- small pure-JavaScript library.

**Decision:** Pin `fflate@0.8.3` as a development dependency.

The archive uses flat forward-slash entry names, fixed entry order, fixed compression level, fixed `mtime`, fixed `os: 0`, and fixed `attrs: 0`.

**Why:** Windows does not guarantee a `zip` executable, while writing ZIP internals by hand creates unnecessary binary-format risk.

## D20. What is the exact release artifact contract?

For version `<version>`:

```text
main.js
manifest.json
styles.css
obsidian-github-sync-multi-platform-v<version>.zip
```

The ZIP contains exactly these file entries, in this order:

```text
obsidian-github-sync-multi-platform/main.js
obsidian-github-sync-multi-platform/manifest.json
obsidian-github-sync-multi-platform/styles.css
```

The root/ZIP prefix comes from the GitHub repository name, not `package.json.name` or `manifest.id`.

## D21. What proves remote asset integrity?

**Decision:** Exact asset set + `state == "uploaded"` + byte size + SHA-256.

If GitHub returns `digest: sha256:<64-hex>`, compare it directly. A malformed/non-SHA256 digest is an error, not an excuse to downgrade verification.

If the digest is absent/null, download that one asset to a fresh ignored `.tmp` verification directory using `gh release download` and hash the downloaded file locally. Do not capture potentially large binary assets into a synchronous child-process stdout buffer.

## D22. How is draft/published release absence proven?

**Decision:** Use a successful complete paginated release list:

```text
gh api --hostname github.com --paginate --slurp \
  repos/crystalicez/obsidian-github-sync-multi-platform/releases?per_page=100
```

Flatten all pages and search by exact `tag_name`. A successful full list with no match proves absence; command/auth/network/JSON failure is unknown and aborts.

This covers drafts and published releases for the authenticated maintainer without parsing CLI error text as "not found".

## D23. How are release notes kept independent of qualification tags?

**Decision:** Determine the highest numerically lower stable `x.y.z` tag and pass it explicitly as `--notes-start-tag`. Omit the flag when no prior stable tag exists.

**Why:** Qualification tags live in the Git tag namespace and must never accidentally become the generated-notes baseline.

## D24. Which remote host does GitHub CLI target?

**Decision:** Official release commands pin `github.com` explicitly.

- `gh auth status --hostname github.com`,
- `gh api --hostname github.com ...`,
- `gh release ... --repo crystalicez/obsidian-github-sync-multi-platform` with child `GH_HOST=github.com`.

Do not rely on cwd placeholders, `GH_REPO`, or an inherited enterprise host.

## D25. What does "master must not change" realistically mean?

**Problem:** GitHub does not offer an atomic transaction combining `master`, a stable ref, and a release resource.

**Decision:** The command must observe `remote master == qualified HEAD` immediately before each authority-changing/publication mutation and abort on every observed mismatch. All created state explicitly targets the exact qualified SHA.

A concurrent `master` update can occur after a successful final observation. That does not retarget the already-created stable ref/release and therefore does not invalidate exact-SHA publication. The documentation must not claim an impossible cross-ref atomic guarantee.

## D26. Do qualification/stable tags imply zero GitHub Actions executions?

**Decision:** No such promise.

Current CI has `on: push:` with no branch/tag filter. Tag creation may trigger incidental CI. Those runs are non-authoritative and are neither awaited nor required by the local flow. Changing CI triggers is outside v1.

## D27. Where do process-heavy tests live?

**Decision:** `tests/feasibility/`.

The current test classifier has no `release` tier. A new `tests/release/` directory would otherwise fall into the ordinary fast tier and unintentionally slow normal tests.

## D28. Are GitHub Actions workflows modified?

**Decision:** Their YAML files and authority model remain unchanged.

Shared scripts they invoke may gain safety/validation fixes (for example the live runner source-repo guard or shared package metadata validation). That is deliberate hardening, not a change in Actions release authority.

---

# 2. Qualification Receipt Contract

## 2.1 Ref name

```text
refs/tags/qualification/local/v1/<version>/<40-hex-sha>
```

Example:

```text
refs/tags/qualification/local/v1/1.0.8/0123456789abcdef0123456789abcdef01234567
```

## 2.2 Annotated tag object

The tag object must:

- be an annotated Git tag object,
- declare the exact expected tag name without the `refs/tags/` prefix,
- target object type `commit`,
- target the exact qualified commit directly.

The message is deterministic UTF-8 JSON serialization (two-space indentation plus one trailing newline) of:

```json
{
  "schemaVersion": 1,
  "kind": "obsidian-sync-local-qualification",
  "repository": "crystalicez/obsidian-github-sync-multi-platform",
  "commitSha": "<40-hex-sha>",
  "version": "1.0.8",
  "result": "success",
  "qualifiedAt": "2026-08-27T00:00:00.000Z",
  "durationMs": 123456,
  "platform": "win32-x64",
  "nodeVersion": "v22.11.0",
  "pnpmVersion": "9.12.3",
  "e2eSuite": "github-e2e-quick",
  "gates": [
    "metadata-validation",
    "install-frozen",
    "build",
    "package-validation",
    "fast-tests",
    "repeat-tests",
    "recovery-tests",
    "resource-tests",
    "feasibility-tests",
    "github-e2e-compile",
    "github-e2e-live",
    "github-e2e-cleanup-verified"
  ]
}
```

Authority validation requires exact schema/kind/repository/SHA/version/result/toolchain/e2eSuite/gate ordering. Duplicates, omissions, additions, or reorderings fail.

`qualifiedAt`, `durationMs`, and `platform` must be syntactically valid audit fields. They do not require release to run on the same OS.

## 2.3 Creation without authoritative local tag refs

Use `git mktag` to create the annotated tag object in the local object database. Do not create `refs/tags/qualification/...` locally as authority.

The object may be pushed with a refspec whose source is its full object SHA; Git permits an arbitrary SHA expression as refspec source.

## 2.4 Existing remote receipt

After canonical-origin, master, metadata, and toolchain preflight, an already-existing exact qualification ref may short-circuit qualification only if the remote object independently passes the complete receipt/direct-commit validation.

A local same-named tag is irrelevant.

## 2.5 Remote inspection without trusting a local tag

1. `git ls-remote` the exact remote qualification ref and record its object SHA.
2. Fetch that exact remote ref into a random temporary local ref under `refs/local-qualification-inspect/` with `--no-tags`.
3. Require the fetched temporary ref object SHA to equal the SHA observed in step 1. If the remote moved between reads, fail closed.
4. Inspect the exact object with `git cat-file`.
5. Delete only the local temporary inspection ref.

The temporary ref is never authority and may be cleaned locally without violating the no-auto-delete rule, which applies to stable remote publication state.

---

# 3. `pnpm qualify:local`

## 3.1 Cheap preflight

Before long gates:

1. working tree clean including non-ignored untracked files,
2. current branch exactly `master`,
3. resolve full 40-hex `HEAD`,
4. exactly one effective origin fetch URL and one effective origin push URL; both canonical GitHub source repository,
5. remote `refs/heads/master == HEAD`,
6. metadata-only package/manifest/versions validation,
7. running Node exactly equals `.node-version`,
8. Corepack pnpm exactly equals committed package-manager declaration,
9. usable Git committer/tagger identity,
10. exact qualification ref is either absent or already valid,
11. E2E owner/repo/branch/token resolve without printing token,
12. E2E target is neither current source origin nor canonical source repo,
13. E2E target repository metadata is readable,
14. E2E selected/generated branch is not the target repository's actual default branch.

If an already-valid qualification receipt is found after these source/toolchain checks, report `already qualified` and exit without rerunning gates.

## 3.2 Official E2E branch

Ignore the configured branch for the official qualification run and set only the child process environment:

```text
GITHUB_E2E_BRANCH=obsidian-sync-e2e/local-<sha12>-<run-id>
```

Print the branch name, never the token.

## 3.3 Gate order

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

The Corepack commands are fixed allowlisted commands. On Windows, `.cmd` invocation is routed through `cmd.exe` only for these static strings; dynamic values stay in environment/argv data and are never concatenated into shell commands.

## 3.4 Out-of-band E2E cleanup

After the live child process returns, whether it returned success or failure:

- GET the unique branch ref,
- if absent: cleanup succeeds,
- if present: DELETE it, then GET again,
- retry this bounded cleanup/verify sequence up to three times with bounded delay,
- any auth/network/unknown state is cleanup failure.

Qualification success requires live exit zero **and** verified branch absence.

If live failed and cleanup also failed, surface both facts and the safe branch identifier.

A hard kill/power loss can bypass this cleanup; the unique branch makes residue isolated and manually inspectable.

## 3.5 Post-gate revalidation

Before creating the receipt:

- clean source tree invariant,
- `HEAD` unchanged,
- origin fetch/push identities unchanged/canonical,
- remote master still `HEAD`,
- metadata/toolchain still exact,
- qualification ref still absent.

## 3.6 Receipt publication

Create one annotated tag object and push that object SHA to the exact remote qualification ref without force.

Result handling:

- zero exit -> remote exact ref must equal this tag-object SHA and receipt must validate,
- explicit existing-ref rejection -> validate remote state; success is allowed only if the remote receipt independently satisfies the existing-receipt rule,
- transport/unknown -> inspect; success only if the remote ref is exactly this invocation's tag-object SHA.

Never blindly retry the push.

---

# 4. `pnpm release:local -- <version>`

## 4.1 Preflight

1. exactly one repository-compatible stable triple argument (`^\d+\.\d+\.\d+$`),
2. clean source tree,
3. branch `master`,
4. one effective origin fetch URL and one effective origin push URL, both canonical,
5. exact `HEAD == remote master`,
6. package/manifest/requested versions equal,
7. `versions.json[version] == manifest.minAppVersion`,
8. exact committed Node/pnpm toolchain is running,
9. GitHub CLI authenticated on `github.com`,
10. authenticated canonical repository access reports push/write capability,
11. enumerate all remote stable tags and require requested version numerically greater than every existing stable triple,
12. requested stable ref absent,
13. complete GitHub release list proves no draft/published release for requested tag,
14. exact remote qualification receipt for `(version, HEAD)` validates,
15. snapshot `qualificationTagObjectSha`.

A pre-existing requested stable ref or release is partial/concurrent/manual state and blocks v1 normal release.

## 4.2 Publication-machine gates

Do not rerun the expensive qualification-only gates. Run:

```text
install-frozen
build
package-validation
fast-tests
github-e2e-compile
```

Then re-read metadata/source/master/evidence before staging.

## 4.3 Deterministic staging

Create a fresh ignored directory:

```text
.tmp/release/<version>/
```

Stage:

- `main.js` from current post-build raw bytes,
- `manifest.json` from exact `HEAD:manifest.json` Git blob,
- `styles.css` from exact `HEAD:styles.css` Git blob.

Build the ZIP from those staged bytes using the exact contract in D20.

Create an in-memory artifact manifest for the four staged upload files:

```text
name
absolute/local path
byte size
lowercase SHA-256
```

Only staged paths are supplied to GitHub CLI; root working-tree static files are not uploaded.

## 4.4 ZIP determinism

Use `fflate@0.8.3` with:

- flat forward-slash keys,
- fixed insertion order `main.js`, `manifest.json`, `styles.css`,
- fixed compression level,
- `mtime = local 1980-01-01 00:00:00`,
- `os: 0`,
- `attrs: 0`.

A regression must create the archive under at least `TZ=UTC` and `TZ=Asia/Bangkok` child environments and require byte-identical ZIP output.

## 4.5 Final pre-mutation recheck

Immediately before stable-ref creation:

- source tree/HEAD unchanged,
- origin fetch/push identities unchanged,
- remote master is still HEAD,
- metadata/toolchain still exact,
- qualification remote object SHA still equals snapshotted object and receipt/direct target still valid,
- requested stable ref absent,
- complete release list still proves requested release absent,
- staged local artifact manifest still matches staged files.

## 4.6 Create-only stable ref

Use:

```text
gh api --hostname github.com --method POST \
  repos/crystalicez/obsidian-github-sync-multi-platform/git/refs \
  -f ref=refs/tags/<version> \
  -f sha=<exact-qualified-sha>
```

The actual implementation uses argv, not shell interpolation.

Only a successful create followed by an exact ref read may advance. Any nonzero/unknown result is inspected and then stops; a same-SHA ref observed afterward is still ambiguous/partial state.

## 4.7 Recheck before draft creation

After stable-ref claim and before another remote mutation, recheck:

- remote master == HEAD,
- qualification object identity unchanged and valid,
- stable ref == HEAD,
- requested release still absent.

This avoids creating a draft when a race is already observable.

## 4.8 Explicit draft

Create the draft using only staged asset paths:

```text
gh release create <version>
  --repo crystalicez/obsidian-github-sync-multi-platform
  --verify-tag
  --draft
  --title <version>
  --generate-notes
  [--notes-start-tag <highest-lower-stable-tag>]
  <staged-main.js>
  <staged-manifest.json>
  <staged-styles.css>
  <staged-zip>
```

Run with `GH_HOST=github.com`.

Do not use `--clobber`. Do not use the one-shot non-draft asset path. On error/unknown outcome, perform read-only inspection and stop.

## 4.9 Draft verification

Require one exact matching draft:

- exact `tag_name`,
- `draft == true`,
- `prerelease == false`,
- stable ref still exact HEAD,
- exactly four expected assets, no extras/duplicates,
- each asset `state == "uploaded"`,
- exact byte size,
- exact SHA-256 through GitHub digest or fallback download/hash.

The release `target_commitish` field is audit metadata, not SHA authority when a pre-existing stable tag is used. The stable Git ref is authoritative.

## 4.10 Final check before public publication

Immediately before `draft=false`:

- local HEAD/source/metadata/toolchain invariant,
- remote master observed equal HEAD,
- qualification object identity unchanged and valid,
- stable ref equals HEAD,
- draft flags still exact,
- exact asset manifest still matches remote bytes.

## 4.11 Publish

```text
gh release edit <version>
  --repo crystalicez/obsidian-github-sync-multi-platform
  --draft=false
```

Run with `GH_HOST=github.com`.

For a nonzero/unknown result, fresh remote state may reconcile success only if it proves the intended non-draft/non-prerelease release, exact stable ref, unchanged qualification object, and exact asset bytes.

Otherwise fail closed and leave state untouched.

## 4.12 Post-publication verification

Even after CLI exit zero, re-read and require:

- qualification object unchanged,
- stable ref equals exact qualified SHA,
- release exact tag,
- non-draft/non-prerelease,
- exact four assets and byte digests.

Also report whether remote master still equals the released SHA as audit information. A master advance that occurs after the final pre-publication observation does not retarget or invalidate the already exact-SHA release.

---

# 5. GitHub CLI and Authentication Contract

Official release commands must never inherit an unintended GitHub Enterprise host.

Preflight:

```text
gh auth status --hostname github.com
```

All `gh api` mutations/reads include `--hostname github.com`. All `gh release` commands use explicit canonical `--repo` and child `GH_HOST=github.com`.

The maintainer credential must have repository Contents write permission. GitHub may additionally require OAuth `workflow` scope for release operations involving commits that change workflow files; if GitHub CLI reports that condition, stop and show its safe remediation guidance. Do not compensate by deleting already-created remote state.

---

# 6. Manual Live-E2E Safety Contract

`pnpm test:github-e2e:quick` remains usable from non-canonical GitHub clones/forks.

For live mode it must:

1. parse origin as a GitHub `owner/repo` without requiring canonical owner,
2. load env with existing shell-env-wins behavior,
3. reject missing owner/repo/branch/token,
4. reject protected-looking branch names,
5. reject E2E target equal to current origin repo,
6. reject E2E target equal to canonical source repo,
7. read target repository metadata and actual default branch before mutation,
8. reject target branch equal to actual default branch.

`--compile-only` stays credential-free and does not require a Git repository origin.

---

# 7. Test Strategy

All new process-heavy tests live under `tests/feasibility/`.

Required test groups:

## 7.1 Metadata/version

- current `digits.digits.digits` syntax accepted,
- `v1.2.3`, prerelease suffixes, malformed triples rejected,
- BigInt ordering at values beyond `Number.MAX_SAFE_INTEGER`,
- package/manifest/versions consistency,
- `update-version.js` comparison/bump behavior remains compatible with stable-triple syntax.

## 7.2 Origin/repository safety

- canonical HTTPS/scp-SSH/ssh:// forms,
- credential-bearing/lookalike hosts rejected without echo,
- official fetch URL and push URL both required canonical,
- divergent `pushurl` rejected,
- manual fork origin accepted for E2E source detection,
- current-origin and canonical-source E2E targets both rejected.

## 7.3 E2E remote preflight/cleanup

- unreadable repo fails before long gates,
- actual default branch rejected,
- unique branch generation does not collide,
- live success + cleanup success qualifies,
- live failure + cleanup success reports live failure,
- live success + cleanup failure does not qualify,
- live failure + cleanup failure reports both,
- bounded cleanup retries and verifies final 404/absence.

## 7.4 Qualification Git objects

- `git mktag` direct commit object,
- nested tag rejected,
- remote object observed/fetched identity race detected,
- local same-named tag irrelevant,
- arbitrary object SHA refspec push works in temporary bare Git fixture,
- ambiguous qualification push only reconciles exact invocation tag-object SHA.

## 7.5 Packaging

- static staged bytes equal exact Git blobs despite CRLF working-tree copies,
- exact four assets,
- exact ZIP paths/order,
- unrelated files excluded,
- output only in known `.tmp` path,
- exact local size/SHA256 manifest,
- ZIP byte-identical across repeated runs and at least UTC/Bangkok TZ.

## 7.6 GitHub publication helpers

- create-reference zero success,
- pre-existing/same-SHA 422 is not ownership,
- transport error + later same-SHA ref stops,
- complete paginated release-list absence/presence,
- malformed JSON/HTTP/command error is unknown,
- exact draft flags,
- asset missing/extra/duplicate/wrong state/size/digest rejected,
- null digest fallback downloads exact asset to fresh `.tmp` file and hashes it,
- malformed/non-SHA256 digest fails rather than falling back,
- gh host/repo pinning is present in every command.

## 7.7 Release state machine

- no publish before all previous phases,
- pre-existing partial state blocks,
- master/evidence race before stable-ref creation blocks,
- race after stable-ref claim blocks draft creation,
- race before draft publish blocks publication,
- draft-create ambiguity never retries/deletes,
- publish ambiguity reconciles only complete exact final state,
- post-verification mandatory after zero exit.

## 7.8 Native Windows verification

Injected `platform="win32"` tests prove command construction everywhere, but first production Windows use also requires the focused deterministic suite to be executed natively on Windows. This is documented evidence, not a GitHub Actions dependency.

---

# 8. Documentation and UX

Update:

- `docs/releasing.md`,
- `docs/github-e2e.md`,
- `.env.github-e2e.example`.

Public output prints safe values only:

- version,
- source SHA,
- qualification ref and tag-object SHA,
- unique E2E branch name,
- current phase/gate,
- stable publication phase,
- final release SHA/state,
- read-only inspection commands after ambiguous/partial outcomes.

Never print tokens, `.env` contents, raw credential-bearing remotes, or authorization headers.

Error categories must distinguish:

- preflight/configuration,
- deterministic gate,
- live E2E,
- E2E cleanup,
- remote race,
- unknown mutation outcome,
- partial stable publication,
- remote asset integrity failure.

---

# 9. GitHub Actions Coexistence

The following YAML files retain their authority model and are not modified by this feature:

- `.github/workflows/github-e2e-live.yml`,
- `.github/workflows/release.yml`.

Actions stable release continues to trust Actions-native exact-SHA E2E qualification. Local stable release trusts the local annotated qualification receipt. Neither evidence type automatically satisfies the other path.

Shared script hardening may affect both paths where they invoke the same scripts, but no Actions run becomes required by local authority.

Existing `ci.yml` remains unchanged. Because it listens to unfiltered `push` events, qualification/stable tag creation may trigger incidental CI; those runs are not release authority.

---

# 10. Rollout

The current baseline `master` SHA is `35e98cea924702293bde62d064a83d52eca6d898`; the already-qualified runtime/E2E fix branch remains preserved.

Before the first real local release:

1. implement this design with the authoritative v2 implementation plan,
2. verify deterministic/focused tests,
3. review branch against all acceptance criteria,
4. merge implementation to `master`,
5. allow ordinary deterministic CI to pass as normal repository hygiene, but do not use it as local qualification authority,
6. on exact final `master`, run `pnpm qualify:local`,
7. inspect the remote qualification ref/object binding,
8. run `pnpm release:local -- <version>`,
9. independently inspect final stable ref/release/assets.

Any merge changes the commit SHA; earlier qualification evidence never qualifies the new final commit.

---

# Non-goals

- No V4 runtime/sync behavior changes.
- No automatic release on source push/version bump.
- No automatic deletion/clobber of partial stable publication state.
- No implicit recovery/resume mode in v1.
- No GPG/SSH tag-signing requirement in v1.
- No secret persistence in qualification receipts.
- No custom ZIP implementation.
- No new repository-wide line-ending policy.
- No new strict SemVer policy beyond the repository's existing stable-triple syntax.
- No CI trigger redesign solely to suppress incidental tag-triggered Actions runs.
- No change to the authority rules of the existing Actions release path.

---

# Acceptance Criteria

Implementation is complete only when all are true:

1. local qualification/release CLIs are shell-independent at their public interface and support PowerShell/Windows and POSIX environments,
2. official qualify/release require canonical source fetch **and push** origin identities,
3. manual live E2E remains usable from GitHub forks while rejecting both current-origin and canonical-source destructive targets,
4. target E2E repo metadata/default branch are validated before destructive work,
5. official qualification uses a unique run-specific branch and bounded out-of-band cleanup after every returned live run,
6. qualification receipt cannot be published unless every required gate plus cleanup verification and post-gate master/evidence checks pass,
7. fresh checkout with no ignored `main.js` succeeds through build-before-package-validation ordering,
8. receipt is one exact remote annotated tag object that directly targets the exact qualified commit and validates the exact v1 schema/gates/toolchain,
9. remote receipt inspection cannot be overridden by a local same-named tag and detects remote ref movement during inspection,
10. stable version syntax remains compatible with current repository `digits.digits.digits` semantics and numeric comparison is exact,
11. static release asset bytes come from exact Git blobs while generated `main.js` comes from the current build,
12. ZIP/artifact contract exactly matches current repository-name-based release layout and deterministic metadata,
13. stable ref ownership uses GitHub create-reference semantics; a pre-existing same-SHA ref never counts as this invocation's successful claim,
14. release publication never uses the GitHub CLI one-shot non-draft asset path that may auto-delete temporary draft state,
15. draft/published absence is proven by a successful complete release listing, not generic nonzero command status,
16. draft and final release assets are verified by exact name set, `uploaded` state, size, and SHA-256 bytes,
17. missing remote digest falls back to file download/hash without buffering arbitrary asset bytes in sync stdout,
18. every GitHub CLI operation is pinned to `github.com` and explicit canonical repository context,
19. qualification-object identity, stable ref, remote master observation, metadata, and asset bytes are rechecked immediately before public draft publication,
20. ambiguous qualification/stable-ref/draft/publish outcomes follow their documented reconcile-or-stop rules with no blind retry,
21. post-publication verification is mandatory even after command success,
22. process-heavy tests use the existing feasibility tier and include real temporary-Git object/ref fixtures,
23. Actions YAML authority remains unchanged and local authority never requires an Actions run,
24. docs explicitly explain incidental tag-triggered CI, partial-state inspection, and the realistic non-atomic `master` observation boundary,
25. native Windows focused verification is recorded before first real Windows publication.