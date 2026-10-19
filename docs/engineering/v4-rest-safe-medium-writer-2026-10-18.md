# REST-safe medium-file V4 writer threshold — 2026-10-18

## Decision and implementation

Maintainer approved applying the 8 MiB GitHub REST-safe writer limit to files previously uploaded as single blobs. The new V4 writer uses `shouldWriteV4Parts` for every new logical file **larger than 8 MiB**, with a maximum new part of **8 MiB (8,388,608 bytes)**; the 8 MiB exact boundary remains one object. This prevents new 16/32/50 MB files from being sent as an oversized single Git blob. Existing `shouldUseV4Parts` remains the *historical format-reader validation rule*, preserving legacy 50 MiB single objects and old 48 MiB parts. Direct buffered `V4StorageCodec.prepare`, streamed `prepareFromSource`, and the production `V4SyncSession` upload selector were aligned. Remote descriptor validation accepts both legacy singles and new medium chunked records.

The permanent **100 MB decimal maximum applies to test workloads** and release claims; the protocol's historical reader capacities were not removed. New writer selection must still fail closed if its memory or GitHub mutation budget cannot fit.

## Evidence (working tree before a new exact-code-SHA qualification)

- RED test showed missing new writer predicate; GREEN protocol contract **6/6**: 8 MiB boundary and 16/32/50/100 MB virtual object planning, old single descriptor sizes up to 50 MiB, and historical 48 MiB part descriptors. Explicit 8 MiB writer cap already has isolated writer-policy tests.
- `pnpm test:fast` **666/666**, `pnpm test:resource` **15/15** and `pnpm build` exit 0 after changes.
- `pnpm test:soak` **4/4**: 100 MB cryptographic stream; real encrypted legacy **32 MB single-blob decode** and hash; actual Windows disk-backed V4 encrypted Push → No-op → Pull and SHA-256 for **16 MB (2 parts), 32 MB (4 parts), 50 MB (6 parts)**; and **100 MB (12 parts)** including failed staged append with successful recovery. The smaller sizes use a safe whole-buffer local *write* if within the existing 32 MiB local memory ceiling. No scenario exceeds 100 MB.
- Previously, live GitHub REST **100 MB** encrypted round-trip passed using 8 MiB production parts on an independently pinned disposable repository, and branch cleanup was verified (see `real-github-100mb-rest-e2e-2026-10-18.md`). This is valid evidence for the 100 MB path, not proof of 16/32/50 MB live REST.
- A **16 MB live GitHub** test reached Force Push/No-op and failed at the *test fixture*, because the fixture mistakenly rejected V4's valid bounded whole-buffer pull write for a file under 32 MiB. The disposable branch cleanup was verified. The fixture was corrected and offline 16/32/50 MB cases passed; a further live GitHub attempt could not be launched due to host safety checks. **Do not report 16 MB live GitHub Force Pull as passed.**

## Risk and compatibility

* **Read compatibility:** current readers still accept legacy 50 MiB-era single blobs and 48 MiB parts; old encrypted single 32 MB was decrypted in the new code path.
* **Older client forward compatibility:** older V4 clients whose validator demands chunked records above the old 50 MiB threshold will **fail closed** on newly written chunked records between 8 and 50 MiB. This requires an explicit coordinated client-upgrade or protocol/capability/version rollout decision before a production release. Do not claim existing installed old clients can read new medium chunks.
* **Unqualified work:** native Obsidian Desktop UI/device acceptance; single Git blob at exact 8 MiB boundary through live GitHub REST; medium live GitHub Force Pull from 16 MB; hosted CI at the new commit SHA; independent review. Pack uploads have separate REST request sizing and are not covered by the medium chunk writer change.
* All tests use isolated synthetic vaults/repositories; user notes, real/default branches, and the pre-existing uncommitted `tests/v4/github-transport.test.ts` were not modified. No merge/release.

## Independent clean exact-code-SHA qualification (completed)

The audit code commit `f8e2f724af11774a223952262b2b7d803a9be273` was pushed to `origin/audit/2026-09-26-production-hardening`, without the original unstaged `tests/v4/github-transport.test.ts` user work. Detached checkout `.tmp/rest-medium-clean-20261018` returned that exact code SHA and remained `## HEAD (no branch)` after the checks.

Within the detached checkout, all completed with exit code **0**:

- `corepack pnpm install --frozen-lockfile`
- `corepack pnpm build`
- `corepack pnpm test:fast` **666/666**
- `corepack pnpm test:repeat` **10 consecutive green runs of 666 tests**
- `corepack pnpm test:resource` **15/15**
- `corepack pnpm test:soak` **4/4**, including real-file 16/32/50/100 MB cases and 32 MB legacy single decrypt
- `corepack pnpm test:recovery`, `test:feasibility`, `validate:metadata`, `validate:package`, `test:github-e2e:compile` (three standard E2E bundles)
- Standalone compile of the variable-size 16/32/50/100 MB live GitHub E2E bundle (compile only, **no network**)

**Not qualified on this exact SHA:** credentialed GitHub 16 MB live Force Pull after fixing the <=32 MiB fixture, hosted CI, native Obsidian Desktop physical/UI testing, coordinated old-client roll-out. Earlier real GitHub **100 MB** test passed with 8 MiB new parts on a prior audit code SHA; it does not qualify this SHA or the new medium writer branch.

## Additional exact-size encrypted legacy compatibility proof

After the clean-code-SHA qualification above, the soak suite gained two more **offline** regression cases (both at or below the permanent 100 MB test limit):

- A manually built **historical 48 MiB encrypted part** plus the remaining bytes of a logical **50 MiB + 1 byte** file. The current V4 remote descriptor validator accepts the old chunk count; the production codec reads the two encrypted parts into a bounded sink, verifies the **full-file SHA-256**, and rejects ciphertext tampering.
- An encrypted **8 MiB + 1 byte** input supplied to the non-streaming `V4StorageCodec.prepare` method. The current writer emits **two REST-safe parts**, and the reader restores exactly the original bytes.

These validate the real cryptographic formats, beyond descriptor-only or virtual planner tests. `pnpm test:soak` then passed **6/6**. These are not GitHub API or native Obsidian results; the older-client **forward-compatibility rollout decision remains unresolved**.

## Independent c934380 code-SHA confirmation

The exact test/code commit **`c93438002cb70c48503ec3d4929620abc5890e03`** was verified from a fresh detached worktree `.tmp/rest-legacy-48m-clean-20261018`; `git status --short --branch` remained `## HEAD (no branch)` after testing. Frozen dependency install, build, fast **666/666**, resource **15/15**, cryptographic/real-file soak **6/6**, repeat **10 consecutive runs of 666**, recovery, feasibility **138/138**, release metadata/package checks and standard GitHub E2E compilation all completed with exit code 0.

An *initial concurrent* run of `test:feasibility` while `test:repeat` was running failed with `ENOTEMPTY` when both runners attempted to recreate their **shared `.tmp/tests`** bundle directory. After repeat completed, **sequential feasibility passed 138/138**. This is a real test-infrastructure concurrency bug, not a sync engine assertion failure, and must be fixed before considering parallel local/CI qualification reliable. Do not report the simultaneous run as a pass. It remains separate from the native Obsidian Desktop and live 16 MB GitHub E2E release gates.

## Commands

```sh
pnpm build
pnpm test:fast
pnpm test:resource
pnpm test:soak
pnpm test:recovery
pnpm test:repeat
pnpm test:feasibility
pnpm validate:metadata
pnpm validate:package
pnpm test:github-e2e:compile
```
