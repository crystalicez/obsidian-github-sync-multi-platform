# GitHub live E2E and remote metadata bounds — 2026-10-17

This is audit-branch evidence, **not release approval**. The destructive target is the maintainer-authorized disposable repository `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` (numeric GitHub ID `1284153873`). Its actual default branch is `main`. The canonical source repository ID is `1282135059`.

## Remote metadata hardening

Untrusted GitHub V4 JSON is checked against the following per-object UTF-8 byte limits **before JSON parsing**:

| Object | Maximum decoded JSON bytes |
| --- | ---: |
| V4 config | 64 KiB |
| Remote head | 256 KiB |
| Index shard | 16 MiB |
| Journal page | 32 MiB |

Encrypted objects may additionally contain the fixed OGS4 AES-GCM payload framing overhead, and are checked before decryption and after decryption. Writer paths check the same decoded JSON limits before publishing V4 config, remote head, shards, and journal pages. Encrypted publication verification also applies the journal byte checks.

Five focused regressions first failed because oversized but well-formed JSON was accepted (config, head, shard, plaintext journal, encrypted journal), then passed after the byte guards. The tests retain small positive decode/read controls and verify that an oversized config cannot be written.

**Residual limitation:** Obsidian `requestUrl` can buffer a remote response before these checks run. These limits bound the decoder's workload and reject unsupported metadata but **do not bound upstream HTTP response memory or guarantee small temporary allocations**. This requires separate transport-level design or explicit release risk acceptance.

## Credentialed live GitHub E2E

The ignored `.env.github-e2e` provided the restricted test credential. It lacked `GITHUB_E2E_EXPECTED_REPO_ID`, so the known pinned ID `1284153873`, source repo ID `1282135059`, and fresh disposable branch were passed as process-only environment overrides. No secret file was modified and no token was printed.

The full live suite used `obsidian-sync-e2e/local-30a0d378010e-oct17-production`, and the source was the previous audit tip `30a0d378010effb55018401bfeefee85399539f1` before this metadata patch. It **FAILED (exit 1)** after roughly 10 minutes: two of the three independent test modules passed; the main module failed in `two-device-delete-recreate-identity-break (encrypted)` when a stale device tried to read a recreated opaque object from the remote published commit. The observed error was `Missing V4 remote object`. Plaintext and several earlier encrypted scenarios had passed. Do not count the full live suite as passing.

The runner's `after` cleanup verified the disposable branch was gone. A separate authenticated **read-only** GitHub API proof established that the pinned repo ID and default branch were unchanged and that the exact branch was absent.

### Focused reproduction and added coverage

The live `two-device-delete-recreate-identity-break` scenario now verifies that the exact newly published immutable commit's Git tree contains the recreated object and that the exact blob is readable before device B fetches it. On a stale-device failure, a bounded diagnostic records only booleans for tree membership, rereadability, path correspondence, and commit state, with no token, note text, or raw encrypted bytes. A named live test runs this scenario by itself for incident reproduction. A deterministic two-device encrypted delete, recreate, and catch-up regression asserts both file bytes and new file identity.

The named live test **passed** separately on unique `obsidian-sync-e2e/local-30a0d378010e-repro1` and `...-repro2` branches (~46 and ~45 seconds). One independent post-test read briefly failed with a network error; a later read-only proof, with bounded retries, confirmed all three branches absent and the pinned target/default branch intact.

**Investigation status: open.** The first failure is real. Later passing runs do not distinguish an intermittent GitHub API/visibility failure from a rare writer/index inconsistency. No speculative production read retry, publication rewrite, or claim of a repaired root cause is justified yet. Any further qualification must rerun the complete three-module live suite on an exact pushed commit, confirm clean branch disposal, and investigate another failure with the new Git tree/blob diagnostics.

## Local deterministic evidence

On the connected Windows workspace, Node v24.11.0 and Corepack pnpm 9.12.3 completed production build, fast suite, 10x fast repeat, recovery, resource, feasibility, metadata/package validators, and GitHub E2E compile-only, all exit 0 for the metadata change. The new two-device encrypted catch-up test was rerun with `node scripts/run-tests.mjs --tier=fast --filter=sync-session.test.ts` and exited 0. The original `tests/v4/github-transport.test.ts` work-in-progress edit was never staged or included.

A separate detached worktree at `.tmp/metadata-bounds-clean-20261017` checked out the **exact pushed source SHA `569e69dc1c50941bbde1f2dacae5d552faac8626`**. From this clean checkout, `corepack pnpm install --frozen-lockfile`, `build`, `test:fast`, `test:recovery`, `test:resource`, `test:feasibility`, `validate:metadata`, `validate:package`, and `test:github-e2e:compile` all completed with exit code 0. The full `test:repeat` gate also passed all 10 rounds with exit 0. A fresh Git check **after** these clean-SHA gates returned exactly `## HEAD (no branch)` with no source modifications. The non-credentialed native Obsidian Desktop visual smoke suite also passed on this same clean checkout (57/57 checks, 14 PNG screenshots, zero observed JavaScript exceptions). The known desktop-emulated 375px Settings popout warning remains: only 175px of plugin content width; no physical mobile claim. A new authorized complete live E2E at this exact SHA is being executed separately; its outcome must be recorded only after the process exits.

The GitHub Actions API reported **zero hosted workflow runs** for this exact pushed audit SHA on 2026-10-17. This is an absence of hosted evidence, not proof of why a workflow did not run. Investigate workflow triggering and Actions permissions before production.

These are not evidence of live release qualification, a physical mobile test, screen-reader acceptance, or a verified 5 GiB encrypted Windows roundtrip. PR #8 remains Draft and `master` must not be changed without maintainer sign-off.
