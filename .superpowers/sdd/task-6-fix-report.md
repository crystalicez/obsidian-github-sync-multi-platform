# Task 6 Final-Review Fix Report

Base: `99371744a2fb2f521440e3222a94c53228f01e64`

Branch: `codex/detailed-sync-progress`

## Commits

- `776c8d227b6134584cec7453e8f6963153763c9f` — `fix: stabilize V4 upload failure progress`
- `1c2b7d6c0b1ef4ef41c38e38a9e52583dd5f5a02` — `fix: finalize V4 conflict progress before transfer`

No push or merge was performed.

## RED Evidence

All regression tests were added before production changes.

### Stable upload-failure boundary

Bundle command:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/git-tree-writer.test.ts' --bundle --platform=node --format=esm --target=node22 --outfile='.tmp/red-git-tree-writer.mjs'
```

Output:

```text
.tmp\red-git-tree-writer.mjs  11.3kb
Done in 3ms
```

Test command:

```powershell
node --test '.tmp/red-git-tree-writer.mjs'
```

Output:

```text
tests 6
pass 5
fail 1

V4 tree writer settles already-started uploads before rejecting the first failure
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
0 !== 3
```

The three deferred successful uploads invoked no completion callbacks before the writer had already rejected, proving the unstable rejection boundary.

### Resolve effective plan before transfer and account for conflict copies

Bundle command:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/sync-session.test.ts' --bundle --platform=node --format=esm --target=node22 --outfile='.tmp/red-sync-session.mjs'
```

Output:

```text
.tmp\red-sync-session.mjs  209.8kb
Done in 43ms
```

Test command:

```powershell
node --test --test-name-pattern='resolves every conflict|keep-local-copy-remote|defers a merged local write' '.tmp/red-sync-session.mjs'
```

Output:

```text
tests 4
pass 0
fail 4

v4 resolves every conflict and exact total before an ordinary pull mutates the vault
actual: [ 'write:ordinary.md' ]
expected: []

v4 keep-local-copy-remote counts the cached conflict copy as one pull and two pushes
AssertionError [ERR_ASSERTION]: exact=-1, write=8, completion=-1

v4 keep-local-copy-remote leaves pull incomplete with applying context when the copy write fails
actual: 'resolving-conflicts'
expected: 'applying'

v4 defers a merged local write until every conflict decision and exact total are final
actual: [ 'A.md' ]
expected: []
```

These failures proved that an ordinary pull mutated the vault before the prompt resolved, the conflict copy had no pull accounting, copy-write failure retained the wrong phase, and a merged write occurred before the second conflict decision.

### Runtime terminal snapshot stability

Bundle command:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/settings-secrets.test.ts' --bundle --platform=node --format=esm --target=node22 --alias:obsidian='./tests/stubs/obsidian.ts' --outfile='.tmp/red-settings-secrets.mjs'
```

Output:

```text
.tmp\red-settings-secrets.mjs  159.8kb
Done in 44ms
```

Test command:

```powershell
node --test --test-name-pattern='terminal upload failure snapshot' '.tmp/red-settings-secrets.mjs'
```

Output:

```text
tests 1
pass 0
fail 1

v4 runtime terminal upload failure snapshot cannot mutate after delayed workers settle
push.completed actual: 3
push.completed expected: 0
```

The failed terminal snapshot changed from push `0/4` to `3/4` after delayed uploads settled.

## GREEN Evidence

### Focused writer and runtime

Commands:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/git-tree-writer.test.ts' --bundle --platform=node --format=esm --target=node22 --outfile='.tmp/green-git-tree-writer.mjs'
node --test '.tmp/green-git-tree-writer.mjs'
```

Output:

```text
tests 6
pass 6
fail 0
```

Commands:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/settings-secrets.test.ts' --bundle --platform=node --format=esm --target=node22 --alias:obsidian='./tests/stubs/obsidian.ts' --outfile='.tmp/green-settings-secrets.mjs'
node --test --test-name-pattern='terminal upload failure snapshot' '.tmp/green-settings-secrets.mjs'
```

Output:

```text
tests 1
pass 1
fail 0
```

### Focused and complete sync-session

Commands:

```powershell
& '.\node_modules\.bin\esbuild.cmd' 'tests/v4/sync-session.test.ts' --bundle --platform=node --format=esm --target=node22 --outfile='.tmp/green-sync-session.mjs'
node --test --test-name-pattern='resolves every conflict|keep-local-copy-remote|defers a merged local write' '.tmp/green-sync-session.mjs'
```

Output:

```text
tests 4
pass 4
fail 0
```

Command:

```powershell
node --test '.tmp/green-sync-session.mjs'
```

Output:

```text
tests 73
pass 73
fail 0
```

### Full gates

Command:

```powershell
npm test
```

Output:

```text
tests 221
pass 221
fail 0
cancelled 0
skipped 0
todo 0
```

Command:

```powershell
npm run build
```

Output:

```text
> tsc -noEmit -skipLibCheck && node esbuild.config.mjs production
Exit code: 0
```

Command:

```powershell
git diff --check
```

Output: empty; exit code `0`.

## Changed Files

- `src/lib/v4/git-tree-writer.ts`
- `src/lib/v4/sync-session.ts`
- `tests/v4/git-tree-writer.test.ts`
- `tests/v4/settings-secrets.test.ts`
- `tests/v4/sync-session.test.ts`
- `.superpowers/sdd/task-6-fix-report.md`

## Runtime Decisions

- `mapWithConcurrency` retains concurrency `4`, records the first thrown value without wrapping it, stops workers from claiming new items after the first failure, waits for every already-started mapper, and then throws that same first value.
- Progress callback exceptions remain observational through the existing callback isolation. A failed write does not invoke `onUploadsComplete`, create a tree or commit, or update/create a ref.
- Conflict resolution is now a decision-only planning pass. It may read local, remote, and base bytes while reporting `resolving-conflicts`, but it does not mutate the vault.
- Ordinary pulls and conflict-derived pulls are collected into one effective pull list. Exact pull and push totals are published after the final conflict decision and before the first transfer or local apply.
- Cached remote bytes used for `use-remote` and `keep-local-copy-remote` skip a fabricated `downloading` phase and are applied directly with the correct logical path.
- `keep-local-copy-remote` contributes one cached pull/local apply for the conflict-copy path, one push for that copy, and one push for the original local version. Pull completion increments only after the copy write succeeds.
- Merged bytes are deferred until all conflict decisions and totals are final, then applied before the final local scan and push preparation. The final local scan and local read cache preserve the merged content that is published.
- Existing pull-before-push order, conflict policies, compare-and-swap behavior, journals, repository identity checks, encryption, history, and index replacement paths were left intact.

## Self-Review

- Mixed conflicts: the two-conflict regression pauses on the second decision and proves the first merged write has not happened; exact totals precede the later write.
- Conflict-copy write failure: the regression proves phase `applying`, the generated copy path, pull direction, and pull `0/1` remain at failure.
- Merged final content: the regression checks both the local vault and published GitHub bytes equal the deferred merged content.
- Writer first-error identity: the regression checks strict object identity for the first error after all three already-started successful uploads report completion.
- Assignment boundary: the runtime fixture contains four logical content blobs plus later metadata; the final assertion proves only the four already-started blob calls occurred after the failure latch.
- Publication boundary: the runtime regression observes every failed snapshot through the 400 ms throttle window and proves the first failed snapshot remains unchanged.
- No callback, concurrency, CAS, encryption, journal, history, identity, or persistence interfaces were expanded.

## Concerns

- No known functional concerns remain.
- The runtime regression intentionally waits 450 ms to cross the production 400 ms progress throttle boundary.
- Live GitHub E2E was not rerun in this fix wave; the exact fix brief required focused RED/GREEN plus `npm test`, `npm run build`, and `git diff --check`, all of which passed.
