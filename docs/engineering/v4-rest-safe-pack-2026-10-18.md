# GitHub REST-safe encrypted V4 pack writer — 2026-10-18

## Problem and scope

The new V4 file writer already restricts individual encrypted blob parts to an empirically tested **8 MiB**. However, `planV4PackGroups` had a separate **32 MiB plaintext** maximum and used only memory/transport-budget checks. A group of small files could produce an encrypted JSON/Base64 pack exceeding 8 MiB, inviting the same GitHub Create Git Blob HTTP 422 that originally occurred for 48 MiB parts.

**The fix changes new pack writes only.** Historical reader metadata bounds and V4 pack format version 1 are unchanged. Do not infer that 8 MiB is a formally published GitHub API hard limit; it is a conservative bound proven for encrypted part uploads on the disposable test target. No tests in this work use more than 100,000,000 bytes.

## Code

- `src/lib/v4/pack-planner.ts`: in addition to existing plaintext/resident/transport budgets, `withinBudgets` now requires the **estimated final encrypted pack blob**, including 33 bytes of AES-GCM transport overhead, to be at most `V4_GITHUB_REST_SAFE_WRITER_BYTES` (**8,388,608 bytes**). Existing 32 MiB legacy pack bounds are retained as historical decode metadata, not the effective new writer default.
- `src/lib/v4/storage-codec.ts`: both streamed `preparePackFromSources` and direct buffered `preparePack` reject oversized estimated pack archives **before reading content, serializing large JSON, or encrypting**. The finalized archive is also checked before encryption. The reader `readPackRecords` remains unchanged and accepts old valid larger-format packs.
- Eligible candidates that no longer fit a safe pack group are emitted in smaller ordered groups; ineligible entries take the normal V4 individual upload path.

## Regression evidence

- **RED**: the planner allowed an oversized pack when given 96 files of 512 KiB and ample memory/transport budgets; the new targeted test failed until the encrypted-blob cap was introduced.
- **GREEN**: planner tests **5/5**; direct pack-source path refuses aggregate 8 MiB of plaintext where JSON/Base64 expands ciphertext past 8 MiB, before opening any source.
- A separate real codec test constructs and publishes pack blobs for **96 files × 512 KiB** (**50,331,648 logical bytes**), verifies every encrypted pack is ≤8 MiB, uses the production `readPackRecords` decoder, and checks recovered bytes for **all 96 files**. No GitHub network was used.
- A synthetic **historical encrypted pack larger than 8 MiB** decrypts via the unchanged reader despite the new writer cap, proving that the creation restriction does not delete old pack read capability.
- On the working tree: `pnpm build`, fast **667/667**, resource **18/18**, soak **6/6**, feasibility **139/139** and standard GitHub E2E compilation passed. `pnpm test:repeat` passed **10 consecutive runs of 667/667**.

## Detached clean-SHA qualification note

A detached Windows worktree at audit code SHA `c7e7120` passed frozen dependency install, build, fast **667/667**, resource **18/18**, soak **6/6**, recovery **50/50**, repeat **10 × 667/667**, and standard GitHub E2E compilation. The first **concurrent** Feasibility run yielded **138/139** due to an existing *test harness bug*: `tests/feasibility/local-release.test.mjs` called asynchronous `writeFile` to simulate a tampered release asset from a **synchronous** injected hook without awaiting it, so validation raced the artificial tamper.

The fixture was corrected to perform **synchronous** `writeFileSync` inside that synchronous hook. No production release validation logic was weakened. Focused release tests then passed **37/37**, and the full feasibility suite **139/139**. The clean exact-SHA qualification of the corrected follow-up commit is recorded in the next section. The original failed run is retained as evidence, not silently counted as success.

## Independent clean exact-code-SHA qualification — completed

The final audit code/test commit `fc414808fd94414c13c807ce306cc396681f9d8c` was pushed to `origin/audit/2026-09-26-production-hardening`. Detached Windows checkout `.tmp/rest-safe-pack-final-20261018` matched that exact SHA, and `git status --short --branch` remained `## HEAD (no branch)` after validation. Frozen `pnpm install --frozen-lockfile` succeeded.

At that pinned SHA, **all** commands below exited **0**, including concurrently launched deterministic suites:

- Production `pnpm build`
- `pnpm test:repeat`: **10 consecutive fast runs of 667/667**, including the updated pack planner tests
- `pnpm test:resource`: **18/18**, including 96-file (50,331,648 bytes total) REST-safe encrypted pack writer/decryption and historical >8 MiB pack read
- `pnpm test:soak`: **6/6** with no generated file exceeding 100 MB
- `pnpm test:feasibility`: **139/139**, including deterministic synchronous release-asset tamper hook
- `pnpm test:recovery`: **50/50**
- `pnpm test:github-e2e:compile` (three bundles, **compile only**)
- `pnpm validate:metadata` and `pnpm validate:package`

This exact-code-SHA clean checkout supersedes the first c7e7120 concurrent feasibility failure described above. **Do not claim** hosted CI, native Obsidian physical UI, credentialed GitHub *pack* upload or cross-version client rollout qualification from these local results. Existing user WIP `tests/v4/github-transport.test.ts` was excluded from both pushed code commits.

## Outstanding validation and release gating

This work does **not** qualify a credentialed GitHub live many-file pack, native Obsidian Desktop, hosted CI at the committed SHA, mobile acceptance, or older V4 clients reading the *separate new 8–50 MiB individual-file chunk format*. Coordinate cross-version rollout before any release. Keep Draft PR #8 unmerged. Do not modify the original unstaged `tests/v4/github-transport.test.ts`.

See `docs/engineering/v4-rest-safe-medium-writer-2026-10-18.md` for the related single-file REST bound and the previous 100 MB live evidence.
