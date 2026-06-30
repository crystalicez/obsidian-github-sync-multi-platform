# GitHub Native Sync V3 Design

## Goal
Make sync as fast, correct, robust, and pleasant as possible for both encrypted and plaintext vaults without using the git binary. The v3 design may replace the current remote layout completely; users initialize it with Force Push or Force Pull.

## Chosen Approach
Use GitHub's Git database APIs as the remote coordination layer. The plugin treats the branch head commit as the remote version clock, uses tree/blob APIs for batch writes, and updates refs with CAS semantics so stale devices cannot overwrite newer remote work.

## Remote Model
V3 stores plugin metadata under `.obsidian-github-sync-v3/`. Encrypted sync stores encrypted opaque objects, delta snapshots, pack bases, chunked large objects, and compacted roots. Plaintext sync may store user files directly, but still uses Git tree head SHA and cached path metadata to avoid redundant remote scans and downloads.

## Push Flow
1. Read current branch ref and commit tree SHA.
2. Compare with local sync cache. If unchanged, skip remote tree walks.
3. Build a Git tree overlay containing only changed plugin objects, snapshots, packs, or plaintext files.
4. Create one commit for the whole sync operation.
5. Update the branch ref only if it still points at the commit read in step 1.
6. On stale ref, fetch the new head, merge/re-plan, and retry without overwriting remote changes.

## Encrypted Data Flow
Encrypted sync uses an append-friendly DAG: base packs for large snapshots, loose encrypted deltas for small changes, chunked encrypted objects for GitHub-large files, and periodic compaction. Normal small edits should upload only a small encrypted delta plus a new encrypted snapshot/head commit, not rewrite a full pack.

## Plaintext Data Flow
Plaintext sync uses Git tree entries as the remote manifest. If branch head is unchanged, normal sync avoids getTree entirely. If changed, it compares tree entry SHA/size/path with local cache and downloads only files that need conflict checks or local updates.

## Correctness
All normal push/pull operations perform conflict checks except explicit force operations. Multi-device safety comes from branch ref CAS, snapshot parent IDs, and three-way merge against the cached base head. If a merge cannot be proven safe, the plugin creates conflict copies or asks the user according to conflict policy.

## UX
Status bar phases must be precise: waiting, checking remote head, planning, uploading objects, committing, resolving conflicts, pulling, compacting, done, or failed. Errors must surface the user-actionable reason and never break Obsidian startup/watchers.

## Performance Targets
- 100k files and 5GB must be representable without full remote object rewrites.
- One-file edit in a large encrypted vault should avoid pack rewrite and upload only a delta plus metadata.
- Bulk watcher bursts should be batched into one commit.
- Remote unchanged fast path should not call recursive getTree.
- Real GitHub e2e records elapsed time and request counts for quick/full/random/stress profiles.

## Testing
Tests are TDD-first. Unit tests cover Git API primitives, tree overlays, v3 planner, encrypted DAG merge, plaintext tree cache, and error handling. Real GitHub e2e covers destructive branch reset, random 10-minute workload, pack/delta/chunk behavior, stale-device ref races, and final byte-for-byte verification.