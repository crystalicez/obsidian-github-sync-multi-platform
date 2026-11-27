# D531 — Activation artifact race (2026-11-27)

Starting HEAD 4eba5e2. Physical activation fixture now injects three cases: selector appearing during mkdir, active-route appearing during mkdir, and nonboolean active-route presence. RED 57db5215-ce1a-4878-ab1d-479ff8cabcbe: first case unexpectedly succeeded. Existing activation sampled parent and active route before mkdir, then unconditionally wrote selector; a new artifact could be overwritten. Strict boolean existence check with owner revalidation now guards activation paths, both artifacts are rechecked after mkdir, and the active route is checked after final selector readback immediately before writing. Preserve unexpected files and do not grant activation. This is a cooperative sampled guard, not atomic exclusive create or proof against arbitrary external writes.

Validation:
- RED above exit 1. Exact selector test rerun after fix was blocked by tool safety checks; no workaround attempted. All three new injected scenarios and prior cases in this file still require green verification.
- Separate installed rehearsal ba1d6ea9-1956-4edc-b54a-52168bba6d3d: 6/6 pass, real isolated filesystem and mock GitHub. Does not substitute for blocked fault test.
- Maximum strict edd69e61, build 06c29097, metadata 72d8be51, package 3da4efa7 all exit 0.
- Android read-only probe c107e8ed: one connected SM_N770F. pidof 31583273 exit 1, no Obsidian PID; forward list 14b3ac12 contains pre-existing tcp:53429->tcp:53329. Left untouched. Exact disposable Vault not verified; no mobile writes, no app launch.
- No personal Vault/default branch/tag/release changes. Public Execute and native acceptance remain gated. Full Fast current source and D528 blocked race validation remain pending. Preserve local HANDOFF work.
