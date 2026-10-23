# Stage D36 — Maximum Strict TypeScript migration (in progress)

Date: 2026-10-23. Source: D35 committed SHA `4a01b93db59dc600511603c48b5adf479175610f`; isolated worktree `.worktrees/d36-max-strict-typescript`, audit branch `audit/2026-10-23-d36-maximum-strict-typescript`. This change does **not** include D35's concurrent uncommitted UI average-rate adjustments. No release/master, live GitHub or user vault changed.

## What is enforced now

`tsconfig.json` enables `strict: true`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedSideEffectImports`, `forceConsistentCasingInFileNames`, `allowUnreachableCode:false`, `allowUnusedLabels:false`, and prior `isolatedModules:true`. Strict includes strict null checks, function types, property initialization, implicit any and unknown-in-catch. `pnpm build` enforces these new flags and passes.

Source-only changes make Obsidian plugin lifecycle-initialized fields explicit using justified definite-assignment declarations, add required `override` modifiers, switch access to externally shaped records to bracket notation, and accurately model properties that the product already sets to explicit `undefined` when clearing UI state, request cancellation or transient protocol data. The modified source compiles and passes regression suites under the **active** flags. No new `any`, `@ts-ignore`, blanket `@ts-nocheck`, Git protocol change, encryption behavior change, or release.

## Strictest migration gate deliberately remains RED

`tsconfig.maximum-strict.json` extends the active config and enables both `noUncheckedIndexedAccess:true` and `exactOptionalPropertyTypes:true`, checked using `pnpm typecheck:max-strict` (non-emitting). The initial full strictest audit found **270 errors**. After D36 focused type-shape migration and explicit state types, the audit reports **174 errors** (exit code 2); it is **NOT yet a passing or default-enforced Maximum Strict build**. Do not claim that every TS safety flag is active in production merely because this profile exists.

Final error distribution: `TS2532 30`, `TS18048 45`, `TS2538 1` (array/index access); `TS2412 21`, `TS2379 23`, `TS2375 19`, `TS2345 24`, `TS2322 8`, `TS2719 1`, `TS2339 2` (optionals and boundary contracts). Main hotspots are `incremental-hash.ts` **52**, `sync-session.ts` **24**, `bytes.ts` **10**, `resource-controller.ts` **10**, `sync-coordinator.ts` **10**, `recovery-store.ts` **8**, `storage-codec.ts` **8**, and many smaller sites.

Priority next: (1) prove fixed-size SHA-256/hex/base64 array bounds without unsafe assertion blanket or unacceptable speed regression, using known-answer and soak tests; (2) normalize optional API arguments at the call site versus allowing explicit `undefined` only where semantically intentional; (3) pass full max profile, then move its last two flags into the default `tsconfig.json` and enforce that in `pnpm build`; (4) review any package/platform effects, run exact combined native Obsidian and disposable GitHub acceptance. Keep product deletion/conflict semantics untouched; Node.js remains primary, Issue #9 native helper deferred, no GitHub Actions.

## Verification on active strict config

- `pnpm install --offline --frozen-lockfile` PASS, `pnpm build` PASS, `pnpm test:fast` **528/528** PASS, `pnpm test:repeat` **10×528/528** PASS.
- Recovery **79/79**, Resource **11/11**, Feasibility **133/133** prior to adding the new strict-config feasibility regression (the new focused regression itself **1/1 PASS**); bounded virtual 100,000,000 byte Soak **1/1 PASS**; three GitHub E2E test bundles compile; metadata and package validators PASS. No new credentialed GitHub/native GUI E2E run during this strict-migration stage.
- Regression `tests/feasibility/tsconfig-strictness.test.mjs` verifies both active flags and availability of the maximum profile to prevent silent loss of coverage.
