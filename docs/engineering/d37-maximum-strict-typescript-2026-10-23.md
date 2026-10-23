# Stage D37 — Maximum Strict TypeScript fully enabled (Node.js V4)

Date: 2026-10-23. Dedicated audit worktree `.worktrees/d37-max-strict-index-safety`; branch `audit/2026-10-23-d37-max-strict-index-safety`. Parent is D36 pushed audit commit `4566d9c2839228230cf8402a9a85432eafca8aef`; this is **not** release/master and does not include independent D35 uncommitted UI average-rate edits.

## Result

**0 TypeScript errors** with `pnpm build` and `pnpm typecheck:max-strict`. `tsconfig.json` now makes these checks mandatory by default, not opt-in:

- `strict:true` (including strict null/constructor/function types, implicit any, unknown in catch)
- `noUncheckedIndexedAccess:true` and `exactOptionalPropertyTypes:true` (previously D36 migration-only)
- `noImplicitOverride`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch`, `noImplicitReturns`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedSideEffectImports`, `forceConsistentCasingInFileNames`, `allowUnreachableCode:false`, `allowUnusedLabels:false`, and `isolatedModules:true`.
- **`skipLibCheck:false`** explicit. `pnpm build`, `pnpm devcss`, and `pnpm typecheck:max-strict` no longer pass `-skipLibCheck`; project and installed dependency declarations typecheck without errors.
- `tsconfig.maximum-strict.json` remains as an explicitly reproducible equivalent profile. Feasibility test fails if either highest-risk compiler flag or library declaration checking is silently switched off.

## Engineering and compatibility

- Initial D36 max audit **174 errors**; D37 reduces 174 → 122 → 71 → 32 → 8 → **0**, without disabling checks or newly introducing `any`/`@ts-ignore`/`@ts-nocheck`.
- `incremental-hash.ts` uses a local checked indexed read for fixed SHA-256 words/bytes/constant tables, failing closed on a genuine out-of-bounds condition. Existing calculation, AAD, encrypted payload format and expected digest unchanged.
- `bytes.ts` reads base64 bytes through a bounds-checked helper, validates 64-character alphabet, uses `charAt` for bounded symbols and an explicitly validated hex byte lookup. The source encodes the same bytes; no protocol migration.
- `storage-codec.ts` checks remote object path indexes before yielding/finalizing parts. The first path is captured in a closure to avoid a mistaken `this` binding inside the returned `finalize()` method. Test initially caught this bug during migration; fixed and test green before shipping.
- Queue, planner, stream, crypto, Git index, WAL recovery and publication/reconciliation TypeScript types now distinguish absent optionals and explicit `undefined` where existing code intentionally clears state or conditionally passes a value. Index lookups and pack mapping guard against missing entries instead of presuming arbitrary array positions are present. No write/delete semantics, conflict policy or GitHub CAS/retry policy was modified.
- All changes confined to code/type contracts and compiler/test configuration; no GitHub Actions, Native OS Helper/Issue #9, master/release operations, personal vault or live GitHub writes.

## Verified on this exact audited source

| Gate | Result |
|---|---|
| `pnpm build` (full strict and dependency declaration checking) | PASS |
| `pnpm typecheck:max-strict` | PASS (0 errors) |
| `pnpm test:fast` | 528/528 PASS |
| `pnpm test:repeat` | 10×528/528 PASS |
| `pnpm test:recovery` | 79/79 PASS |
| `pnpm test:resource` | 11/11 PASS |
| `pnpm test:feasibility` | 134/134 PASS |
| `pnpm test:soak` | 1/1, bounded 100,000,000 logical bytes, SHA digest equals reference |
| `pnpm test:github-e2e:compile` | 3/3 bundle compile-only |
| `pnpm validate:metadata`, `pnpm validate:package` | PASS |
| Focused encrypted storage codec, incremental SHA | 8/8 and 2/2 PASS |

The D34 real GitHub/native Obsidian functional acceptance was on older source; **no credentialed live E2E or latest-SHA native GUI acceptance performed in D37**. Strict TypeScript does not prove mobile/macOS/Linux acceptance, line-level merge UX, power-loss durability or completeness of Hashing/Encryption telemetry. Requalify the exact combined candidate before any production release; independent D35 UI patch and D37 strict migration must be reconciled in a future isolated integration worktree.
