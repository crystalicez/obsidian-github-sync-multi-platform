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
