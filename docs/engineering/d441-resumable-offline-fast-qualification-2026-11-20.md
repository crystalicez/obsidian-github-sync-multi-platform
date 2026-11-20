# D441 — Resume exact-source Offline Fast qualification

This is a **local-only release-readiness check**, not a GitHub or installed-Obsidian E2E run. It never modifies a remote repository. The child test process inherits OS variables but strips credential-like environment names.

## Why the runner is resumable

The previous D230–239 heavy test cohort included 45 cases, and a D437 source-fingerprinted run exceeded a managed 8-minute task deadline. The plan now divides those 45 literal tests into nine explicitly checked cohorts (D230–236, D238–239), each containing 3–8 cases. A newly added D237 test is **not silently skipped**: discovery rejects it until the coverage plan is deliberately updated.

Use these commands from the active repository worktree:

```sh
node scripts/run-fast-offline-qualified.mjs --plan
node scripts/run-fast-offline-qualified.mjs --task=files-1-of-12
node scripts/run-fast-offline-qualified.mjs --task=D230
node scripts/run-fast-offline-qualified.mjs --task=D239
node scripts/run-fast-offline-qualified.mjs --finalize
```

Repeat `--task=...` for **every** label printed by `--plan`, not just the examples above. The original no-option command still runs all tasks sequentially and qualifies the suite only if all pass with no skips. Each successful task produces a local receipt in `.tmp/offline-fast-receipts/<source SHA-256 fingerprint>/<task label>.json`. Task outputs are verified for Node's complete pass/fail/skip summary; each heavy cohort must also report its exact planned test names.

**Only** `--finalize`, after every task receipt has been validated against the **same current source fingerprint, discovered file inventory, task arguments, file assignments and heavy case names**, emits the full-suite qualification message. A missing, malformed, duplicate, incomplete, stale-source or mismatched receipt fails closed. Merely completing one or several tasks never qualifies the full suite. Local receipts are non-adversarial evidence, not tamper-proof attestations; do not edit or fabricate them.

The source fingerprint covers all source, scripts, tests, docs, package metadata and built output. Changing any of those inputs—including this document, a build artifact, or concurrent work in the same worktree—makes earlier receipts ineligible for finalization. Finish source and build edits **before** collecting receipts. The runner checks source stability before/after each selected task. The receipts directory is under ignored `.tmp` and is not a Git artifact.

Even a complete Offline Fast result does **not** replace native installed Obsidian acceptance with a fully disposable Vault/GitHub test branch, mobile Android/iOS tests, or authorization for production Re-encryption Cutover.
