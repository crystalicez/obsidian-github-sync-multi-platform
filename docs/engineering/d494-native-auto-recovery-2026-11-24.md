# D494 — Native Auto Sync and partial-pull recovery

## Actual installed Windows Obsidian / live GitHub
Clean detached qualification worktree; production builds at ba30f78 and 5b3d83a. Pinned disposable repository ID 1284153873. New opt-in --auto-journey uses actual Vault create/modify events, actual Settings Save and normal Sync, real GitHub and exact path/size/SHA-256 comparison across both installed instances. It explicitly verifies the open-editor guard and the user recovery workflow (no Force Pull after conflict).

| Tested source | Result |
| --- | --- |
| ba30f78a83b66606f69c77b74227c390d391b6dd | Native Auto Sync PASS (19 requests, 0 failures, queue 0, published HEAD), source conflict unexpectedly no-change. Overall FAIL; branch absent verified. |
| fdbcbad4c526ff166ce00f0c12473a0e8ba42154 | Native Auto Sync PASS (19 requests, 0 failures), source conflict preserved both versions and no-op passed after explicit peer HEAD visibility and disk preconditions. Peer catch-up failed. Overall FAIL; branch absent verified. |
| e12a3ebb0bf1fd021dd74e3cc7bc8fa8b28e239c | Native Auto Sync PASS (19 requests, 0 failures). Source conflict and no-op PASS. Actual open-editor guard, preserved bytes, recovery guidance and paused automatic Sync verified. Normal retry after close failed with V4 path collision on the recovered conflict copy. Overall FAIL; branch absent verified. |
| 5b3d83a29ef10db00f6c269fee0fcdf44d40cbfe | Production build PASS; native Auto Sync PASS (20 requests, 0 failures), peer edit publication failed before exercising the fix. Overall FAIL, cleanup failed on GitHub repository lookup network error. Cannot attribute peer publication failure to network without detailed error. |

Latest branch `obsidian-sync-e2e/local-5b3d83a29ef1-a6d50913c3cea459`: absent-first verified, later read-only absence checker confirmed still present. Cleanup retry with exact pinned target/branch via existing cleanup helper blocked by explicit tool confirmation for inline JavaScript. **Outstanding: remove this one disposable branch and independently confirm absence twice before claiming cleanup.** Previous three branches absent verified. No personal Vault, source/default branch writes, or release.

## Actual product defect reproduced and corrected
A pull interrupted by the deliberate open-editor guard can persist the remote conflict copy while the old index does not yet know its file ID. WAL replay completes local writes, then replans against the stale index. The recovered file gets a fresh local identity and collides with the remote file at the same path.

Fix in 5b3d83a: pass reconciled WAL snapshot to sync session. Normal Sync only, known base, exact verified current remote commit, no layout migration, only modify/rescan changes. Use completed pull stage-write receipt for an absent-before target, exact path/file ID/size/SHA-256 matching current verified remote metadata and independently scanned local bytes; no pre-existing base path or ID or duplicate local ID. Force a full scan for candidates. Preserve collision rejection for modified content/unrelated files. No weakening open-editor protection. No format change.

D494 regression reproduced exact path collision before fix (77/78 Settings/Secrets); after fix 78/78 pass with matching and edited-copy cases, including exact bytes, no extra commit, no-op, and preservation of edited copy without remote mutation. Runtime dirty-editor 4/4; maximum strict TypeScript and clean production build pass. Scope: focused regression only, **native final post-fix convergence not yet proven**.

Next: verified cleanup of exact branch, add sanitized peer publication diagnostics, rerun clean native encrypted Auto Sync/guard/recovery/final convergence. Actual network interruption not qualified: Obsidian requestUrl may bypass renderer CDP offline; no global network changes. Android/iOS and full release qualification remain open.
