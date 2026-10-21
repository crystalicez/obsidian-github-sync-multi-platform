# Platform-independent production audit — 2026-10-21

## Scope and authority

- Candidate base: `04b284d8e73ba944615fd2b710f034a4e5ca59b4` (branch `audit/2026-10-21-local-only-no-actions`), continued in isolated `audit/2026-10-21-cross-cutting-production`; this is NOT production `master`. All changes reviewed here are portable TypeScript / protocol / HTTP / release logic; physical operating-system, mobile suspension, GUI/browser and platform-native scheduling qualifications are deliberately excluded.
- User policy: **never run or require GitHub Actions**. There are no tracked `.github/workflows` files on this candidate; `origin/master` is independently at `6c67c8a6d77cd03ab66fdd4b7654c5a5afd23ade` with only the approved local-only migration, **not** the unmerged V4 strict CAS/cooldown candidate.
- User-approved destructive network test target: `diamond-crystal/test-vault-obsidian-encrypted-github-sync-multi-platform` numeric ID **1284153873**, randomized absent-first branch and verified cleanup. Tests never use real vaults or modify the source repository. Maximum real test-file size: **100,000,000 decimal bytes**.
- Release and source-merge actions excluded: `pnpm qualify:local` / `pnpm release:local` intentionally not executed, since they can create remote qualification tags or public releases when authorized; no merge, no release, no global GitHub configuration changes.

## Confirmed defects fixed in this candidate

1. **Data-integrity / Unicode scalar identity:** `normalizeV4VaultPath` accepted unpaired UTF-16 surrogate code units. `TextEncoder` would replace those with U+FFFD, allowing two distinct JS path strings to hash to identical UTF-8 bytes / encrypted path identifiers. The portable path segment validation now rejects only invalid surrogate code points, preserving legitimate astral Unicode (e.g., emoji). A new fail-first regression in `tests/v4/protocol-core.test.ts` demonstrated the pre-fix bug and then passed.
2. **HTTP rate-limit reliability:** `githubRateLimitUntil` respected integer-seconds `Retry-After` only. HTTP also permits a UTC HTTP-date value; the old code shortened such a server-required wait to the 60-second fallback. Now strict canonical IMF-fixdate is parsed, sanity checked, and combined via **maximum** with a valid exhausted primary quota reset; malformed/past values cannot override a later valid deadline. New fail-first regression in `tests/v4/github-cooldown.test.ts` demonstrated the bug and then passed. Standard: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After ; GitHub guidance: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api .
3. No protocol migration, change of conflict policy, change of encryption KDF/authenticated storage layout, CAS fallback, force update, persistent configuration schema, or release tooling behavior was necessary for these fixes.

## Coverage matrix

| Cross-platform subsystem | Reviewed/test evidence | Assessment |
| --- | --- | --- |
| Cryptographic payloads, repository-scoped PBKDF2, AEAD authentication and opaque object identities | `src/lib/v4/crypto.ts`, `paths.ts`, `storage-codec.ts`; Fast protocol/opaque-leakage/storage tests | Regression gates PASS; new invalid-Unicode identity regression PASS |
| Remote config/head/shard/journal shapes, sizes, topology, hashes and encrypted descriptors | `remote-index.ts`, `remote-loader.ts`, `metadata-bounds.ts`, `history-journal.ts`; hostile metadata and shard tests | PASS for exercised adversarial cases |
| Conflict planning, rename/delete/recreate, stale peers, line-oriented review, source-changing during run | `planner.ts`, `conflicts.ts`, `conflict-review.ts`, `sync-session.ts`, `change-guard.ts`; Fast / Recovery | PASS for deterministic scenarios |
| Durable two-slot recovery, unknown publication, abort/restart, journal and staging | `recovery-store.ts`, `publish-reconciler.ts`, `git-mutation-policy.ts`; Recovery **55/55** | PASS; actual physical network cut not simulated here |
| GitHub GraphQL `beforeOid` strict CAS, no REST PATCH fallback, transport budgets and retries | `github-api.ts`, `request-scheduler.ts`, `github-cooldown.ts`; Fast and real disposable GraphQL CAS | PASS: exactly one winner for two concurrent contenders; stale base rejection; mock lost acknowledgement reconciled; no actual link severance |
| Secrets, persistent settings, cooldown context, debug/report sanitization, automatic wake state | `src/main.ts`, `secrets.ts`, `recovery-startup-policy.ts`, settings/debug Fast suites | PASS for tested cases; persistence disk-write failure remains a documented operational risk |
| Resource limits, chunking, packing, memory bounded transfers and deterministic 100 MB integrity | Resource **24/24**, Feasibility **133/133**, Soak **6/6**, includes exact **100,000,000 bytes** encrypted offline round-trip | PASS; not a claim of live GitHub 100 MB transfer |
| UI view-model logic, status, conflict decisions, accessible/styled markup, screenshot runner guards | Fast UI suites plus `node --test tests/v4/ui-visual-assertions.test.mjs tests/v4/ui-visual-smoke-cli.test.mjs` **8/8** | PASS; no physical GUI/OS-specific visual assertion in this scope |
| Local-only release integrity, canonical origin/toolchain, package/metadata, disposable E2E identity/cleanup, no GitHub Actions | Feasibility **133/133**, `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile` and zero tracked workflow files | PASS for non-mutating gates; actual publication intentionally untested |

## Reproducible checks on the candidate

- `pnpm install --offline --frozen-lockfile`: PASS.
- `pnpm build` after source changes: PASS.
- `pnpm test:fast`: **768/768 PASS**.
- `pnpm test:repeat`: **10/10 rounds; each 768/768 PASS**, run without overlapping test runners to avoid shared `.tmp/tests` contention.
- `pnpm test:recovery`: **55/55 PASS**.
- `pnpm test:resource`: **24/24 PASS**.
- `pnpm test:feasibility`: **133/133 PASS**.
- `pnpm test:soak`: **6/6 PASS**, includes a real local 100,000,000-byte encrypted round-trip; no >100 MB physical test files.
- `pnpm validate:metadata`, `pnpm validate:package`, `pnpm test:github-e2e:compile`: PASS.
- UI visual *assertions* only (no GUI required): **8/8 PASS**.
- `node scripts/qualify-graphql-cas-live.mjs`: **PASS**, `concurrentWinnerVerified:true`, `discardedResponseVerified:true`, `cleanupVerified:true`, disposable branch `obsidian-sync-e2e/local-66d749b0c27d-8797d9c4ae8f08df3f51` verified removed.

## Open release concerns, separated from this audit

- **Critical, platform-independent integration:** The source `master` does not contain the >500-commit strict-CAS / cooldown / recovery and performance candidate lineage. It is not enough to have passing tests on this separate branch. Integrate only after a deliberate reviewed change-selection decision; do not merge the entire history blindly.
- **Needs further fault injection (not necessarily OS-specific):** End-to-end transport fault in the plugin while a real GraphQL mutation has an ambiguous result, and persistence write failures through unload/restart, as opposed to a test client merely discarding a response.
- **Security assurance:** Current review is internal and covers known deterministic tests; an independent threat-model/security review remains warranted before claiming production-grade cryptographic sync assurance.
- **Explicitly out of this platform-neutral audit:** Physical Android/iOS, macOS/Linux, OS kill/suspend, desktop/mobile timers in real foreground/background, and native screenshot accessibility.
- **Never:** GitHub Actions, actual release publication without approval, real vault tests, or real test files larger than 100 MB.

**Assessment:** Portable candidate regression quality improved, but the product is **not production-ready** until source integration and remaining release blockers are resolved.
