# D42 — repository-wide worktree consolidation audit and restored REST-safe V4 writer

Date: 2026-10-24 Asia/Bangkok. Canonical working candidate: `audit/2026-10-24-d42-restore-rest-safe-8mib-writer`, isolated under `.worktrees/d42-restore-rest-safe-8mib-writer`. Parent D41 pinned `9cc75e0eb931ccc5eb58a429b8eec8015ca06daf`. Never mutate Zed root, personal vaults, original `.tmp`/`.worktrees` snapshots, default Git branch or GitHub Actions.

## Why consolidating branch ancestry is necessary

`git worktree list --porcelain` revealed many preserved detached qualification snapshots and parallel named audit branches, in addition to the D25–D42 linear audit candidate. `git rev-list --count --all --not HEAD` on initial D42 listed **660 commits from other refs not reachable through D41's ancestor chain**. This is a conservative ancestry inventory, **not** a claim that 660 defects or independent features are missing: many branches are old snapshots, overlapping/rebased/cherry-picked implementations, test evidence or expressly isolated PoCs. Blindly merging all such tips would reintroduce stale runtime behavior, obsolete generated artifacts and potentially forbidden native helper code. Do not delete historical worktrees until the user has independently approved archival.

### Confirmed missing implementation: REST-safe writer

Historical `58bfaaa` (2026-10-18) proved GitHub REST rejected 48 MiB encrypted blobs with HTTP 422 and verified **8 MiB** encrypted multipart writer on a real **100,000,000-byte** file through the dedicated disposable GitHub repo. Historical `f8e2f72` additionally separated the new medium-file writer threshold from the old reader threshold. Historical `c7e7120` capped encrypted packs. These commits are **not ancestors of D41**; the earlier integration refactored the part-selection policy back to a 48 MiB candidate. D41 physical 100 MB native runner reproduced HTTP 422 on `POST /git/blobs` with `Assets/payload-100mb.bin`; failure was verified and all disposable branches were double-checked absent.

D42 explicitly restores the **behavior** of that approved implementation, adjusted to the D41 Maximum Strict + actual Encryption/Hashing/Decryption telemetry code:

- `V4_PART_BYTES=48 MiB` stays as legacy reader compatibility; `V4_GITHUB_REST_SAFE_WRITER_BYTES=8 MiB` is the independent conservative limit for new Git REST blobs.
- New whole-buffer and streamed files above 8 MiB write multipart content, with 8 MiB max parts (e.g. a decimal 100 MB file uses 12 parts), rather than waiting for the historic 50 MiB reader threshold.
- The writer part planner respects REST 8 MiB and existing transient resource budget and fails closed when the content mutation headroom is insufficient. It does **not** silently increase the mutation budget or implement retries.
- Encrypted pack group planner caps estimated ciphertext size to 8 MiB; the actual pack codec validates exact archive size before encryption and rejects oversized direct API calls (including sources before opening them). Legacy encrypted packs are still decoded as before.
- Do not claim GitHub publishes a fixed documented REST request limit: 8 MiB is empirically qualified in the historical runs. Requalification is required on the current code.

### Branch/worktree coverage and classification (non-destructive)

| Source group | Evidence | D42 interpretation |
| --- | --- | --- |
| D25–D41 progressive audit branches | D41 is descendant of D40 → D39 → D38 → D37 → D34; staged guards/strict/telemetry source already integrated and tested | **Integrated by D41 ancestry**; original worktrees retained for audit |
| October 18 REST size worktrees | `.tmp/real-github-100mb-clean-*`, `.tmp/rest-medium-clean-*`, `.tmp/rest-safe-pack-clean-*`, Git commits `58bfaaa`, `f8e2f72`, `c7e7120` | **Restored behavior on D42** and pinned with new tests; do not merge obsolete historical source wholesale |
| Historical per-line conflict UI snapshots | `5fb98a1`, `856302f`, `0d8b3b9`, `61a27a1`; not reachable from D41 | **UNRESOLVED/NEEDS PORT**: inspect conflict-model semantics and UI before combining with D41 strict runtime. Must not claim already integrated |
| Historical GitHub GraphQL CAS/cooldown, advanced recovery/transport, UI progress, WIP file tree refs | Many distinct pre-D25 refs not reachable by raw SHA ancestry | **MIXED / NEEDS FEATURE-BY-FEATURE CODE AUDIT**, e.g. current `GitHubClient.updateRef` already contains GraphQL `beforeOid` despite older branch SHA absence. Absence of ancestry does not prove absent functionality |
| Root `work/zed-production-hardening`, detached `.tmp` qualification snapshots | Can include user WIP, old release proofs, PoCs | **PRESERVED**; never merge root's working-tree state or delete snapshots without reviewing differences |
| Native OS Helper research | User explicitly authorized isolated PoC only, no release binaries, deferred Issue #9 | **INTENTIONALLY NOT MERGED**, not a missing production fix |

## Acceptance and no-regression rule

Never declare all historical worktrees fully integrated solely from `git merge`, patch count, or a green test suite. The final consolidation must inventory feature candidates, prove equivalent current implementation, port missing safe features, and obtain approval for conflicting sync semantics. This D42 phase establishes a canonical evolving integration candidate while keeping outstanding items visible. Physical file test fixtures must never exceed **100,000,000 bytes**; no GitHub Actions or default branch merge.
