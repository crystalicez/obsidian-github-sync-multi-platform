# D51 — multi-Pull WAL pre-stage invariant regression

Date: 2026-10-24 (Asia/Bangkok). Ledger-owned isolated checkout `.worktrees/d51-multi-pull-wal-atomicity`, audit branch `audit/2026-10-24-d51-multi-pull-wal-atomicity`, direct child of clean/pushed D50 docs SHA `0cc9d46d1bc8101731c2446c1f967f3fd6c29b48`.

**No production source change**: untouched `src/**`, Git transport, cryptography, CAS, publication, recovery choice, conflict/delete semantics, wire format, Node-native hashing and 8 MiB REST writer part-size policy. No personal vault, source/default branch, GitHub Actions or pre-existing worktree cleaned or modified. Physical file-test cap remains 100,000,000 bytes.

## Why this test matters

D50 credentialed test intentionally triggered a missing immutable object after an earlier remote delete. In the synthetic **no-WAL MemoryVault** run (SHA `1a2b400`), a local note at the old path was absent because the fallback applied the delete before the subsequent failed download, and the mock `trash()` deletes from memory immediately. With a minimal production-like recovery/staging fixture (SHA `29f91c2`) the original user bytes survived, and both staging cleanup and immutable evidence were proven on the approved GitHub test repository. D38 intermittent `Missing V4 remote object` remains open and D45 REST branch-ref head-null remains open.

The D50 fixture established only the **one file replacement** read failure after a delete. D51 adds a stronger fully offline and reproducible regression that covers **multiple independent Pull mutations**, including a **completed good stage** that has to be discarded when a **later** immutable object cannot be retrieved.

## New deterministic test

Added `D51 WAL pre-stages every Pull before a delete: later missing immutable object aborts all local mutations` to `tests/v4/sync-session.test.ts`, reusing the existing actual V4SyncSession, in-memory Git publication and bounded V4StagingStore implementation. It:

1. Publishes three original plaintext files; a second synthetic device Force Pulls and persists its original local bytes and index.
2. Publishes a new Git commit that deletes `A-remove.md`, modifies `B-replace.md` and modifies `C-last.md`. The source's new commit and object remain present on the in-memory Git server.
3. On the stale peer, simulates exactly one commit-SHA-pinned missing read for `C-last.md` while `B-replace.md` is readable. The peer is configured with a recoveryStore; any attempted `save` before all stages finish fails the test. The actual production pre-stage and cleanup logic executes.
4. Verifies original typed `V4RemoteObjectMissingError` with exact file ID, immutable commit and path; **two** stage begins, **one** successfully completed stage, **one** incomplete stage abort and **one** cleanup of the earlier completed stage.
5. Verifies that no recovery WAL save was attempted, all original local bytes and mtimes remain unchanged (including the file targeted for delete and the successfully staged replacement), **no local trash/write/stage-commit/delete** happened, local index/base is unchanged, and no Git publication was added.

This tests ordering of *all* attempted Pulls before local mutations. It does **not** prove crash durability, disk flush semantics, physical Obsidian Trash recovery, macOS/Linux/mobile behavior, real GitHub eventual consistency, or correctness of later WAL mutation replay. No fallback-policy change was made.

## Validation

- New test in existing focused suite: **89/89 PASS**, including D51 case.
- Full fast tier **587/587 PASS**.
- Maximum Strict TypeScript **zero errors**, production build PASS, GitHub E2E **3 bundle compile PASS**.
- Recovery **79/79**, resource **11/11**, feasibility **134/134**, bounded virtual 100,000,000-byte soak **1/1**, release metadata and package validators PASS.
- Repeat fast tier **10 × 587/587 PASS / exit 0**, independently checked ten repeat-round markers and ten separate 587-pass summaries.
- No credentialed GitHub mutation E2E and no real native Obsidian run were performed at D51 because production source and live runner were not changed; D50 exact-SHA focused live tests and D46 exact-production-source native encrypted 100 MB remain the last such evidence.

## Outstanding decisions and release gates

**Do not silently choose** the user's still-unanswered no-WAL policy. Option A: fail closed on mutating Pull if recoveryStore is unavailable. Option B: retain fallback but redesign it to pre-verify and stage all required remote bytes within bounded resource and mobile constraints. The exported `V4SyncSession` currently accepts no-WAL synthetic callers, and D50 already demonstrates risky partial state for that mode. Choosing A or B requires explicit user approval; D51 does not implement either.

D38 intermittently missing remote object P0 and D45 intermittent head-null are still unresolved. Cross-platform physical acceptance, independent security/C2 review and validated manual line-merge UX remain release gates. No production-ready declaration, default merge or release.
