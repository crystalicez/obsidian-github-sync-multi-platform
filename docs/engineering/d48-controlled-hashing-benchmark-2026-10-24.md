# D48 — controlled, bounded SHA-256 performance evidence (offline only)

Date: 2026-10-24 (Asia/Bangkok). Worktree `.worktrees/d48-hash-performance-evidence` (ledger-owned), branch `audit/2026-10-24-d48-hash-performance-evidence`, direct descendant of clean D47 docs SHA `03eb9259c927a19b739b4f3e982e5a6a0814a25d`. **No change to production `src/**`, wire protocol, Git writes, CAS, retry, recovery, conflict/delete semantics or cryptographic algorithm.** No user vault or live GitHub test repo mutated. No GitHub Actions, native OS helper or release/default-branch merge.

## Question and measurement limits

D45 and D46 genuine Windows Obsidian encrypted 100,000,000-byte journeys showed reported aggregate `hashingMs` about 985 ms versus about 9,704 ms. Those fields sum *observed content-hash operations across the Sync run*, not one isolated hash of exactly 100 MB. Reads, CPU scheduling, concurrent work, number of hashes performed, renderer execution and system load differ across those runs. Do not report this as a proven ~10× intrinsic regression of incremental SHA-256.

New reproducible `scripts/benchmark-v4-hashing.mjs` bundles the actual production `src/lib/v4/incremental-hash.ts` with local esbuild and hashes a deterministic bounded in-memory payload. No large physical file is created and no network request or Obsidian vault is touched. Each run compares the TypeScript incremental SHA-256 against **independent Node `createHash('sha256')` and WebCrypto `subtle.digest('SHA-256')`**, failing closed if any digest differs. It reports per-algorithm median/min/max wall time, measured incremental hashing-only duration, number of rounds, chunk size and process RSS; warm-up is excluded. Memory usage is **Node process RSS**, not Obsidian renderer peak and not a steady-state application guarantee. Input is strictly bounded at **100,000,000 bytes**, chunk size at **8 MiB**, rounds at **12**. CLI arguments are validated before allocating/compiling.

## Results from actual Windows Node.js v24.11.0

Run A (16,777,216 bytes, 4 MiB chunks, five measured rounds):
- Bundled production incremental SHA: median wall **63.0434 ms**, min **62.5655**, max **63.2695**, observed hashing median **62.9679 ms**
- Node native SHA-256: median wall **3.9403 ms**
- WebCrypto SHA-256: median wall **8.4613 ms**
- Same digest across all implementations: `f9be04180e771ba1d4a8a3acaa71d917e20fc0f87c1736c9e351b5a028d3fcbf`
- Peak Node process RSS **84,582,400 bytes**

Run B (100,000,000 bytes, 8 MiB chunks, three measured rounds; ceiling not exceeded):
- Bundled production incremental SHA: median wall **511.9676 ms**, min **468.8722**, max **512.6891**, observed hashing median **511.8387 ms**
- Node native SHA-256: median wall **25.7487 ms**
- WebCrypto SHA-256: median wall **45.8809 ms**
- All three independent implementations match the synthetic 100 MB source and the *previous real Obsidian peer-restore SHA-256*: `f079cad53add0091ed5d0409b0469f9f5cb745b8c280be685dda73203dea90e8`
- Peak Node process RSS **251,531,264 bytes**. Work was in-memory, not a newly written 100 MB test file.

Measured Node native SHA-256 is substantially faster on this machine, but it is **not** an approved replacement for the cross-platform streaming incremental implementation. Node `createHash` is not universally available inside mobile Obsidian runtimes. Neither this Node benchmark nor unrelated Obsidian runs prove an optimization will reduce total Sync time, preserve bounded memory under cancellation and file mutations, or behave equivalently on Android/iOS/macOS/Linux. Preserve the 8 MiB writer part policy and 100,000,000-byte maximum physical test size.

## Validation and release boundary

- New offline benchmark invocation tests: reject oversized/malformed arguments before work, verify live-bundled production incremental bytes against two independent hashes. Focused **2/2 PASS**.
- Strict TypeScript **0 errors**, production build PASS, E2E three bundles compile, recovery **79/79**, resource **11/11**, feasibility **134/134**, virtual 100,000,000-byte soak PASS, package and metadata validators PASS.
- An initial **concurrently launched build + fast tests** run failed because the Desktop CommonJS bridge test read `main.js` while build was still writing it; after build completed, an isolated sequential rerun of full fast tests **582/582 PASS**. This is a test orchestration conflict, **not** proven Sync behavior regression. Avoid build and fast tier in parallel, and preserve the initial red record.
- Fast repeat completed successfully **10 × 582/582**, exit 0. The repeat runner reported ten explicit rounds and ten separate 582-pass totals.
- D38 intermittent `Missing V4 remote object` P0 and D45 intermittent pre-publish head-null race remain **OPEN**. D47 has safe read-only evidence capture on terminal test failures, not a behavioral fix. Production still blocked by causal triage, cross-platform native acceptance, independent review, and safe manual line-merge UI integration.

## Proposed future choice (not implemented)

If the user explicitly authorizes an isolated architecture PoC, compare a bounded native Desktop streaming SHA backend with existing pure-TypeScript engine, using the same deterministic 100 MB digest, cancellation, source-snapshot guards, memory caps, mobile fallback and independent security review. **No opt-in or automatic algorithm switch is part of D48.**
