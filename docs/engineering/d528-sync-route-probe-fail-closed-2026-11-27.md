# D528 — Fail-closed Sync route probes (2026-11-27)

Starting at audit HEAD 952a2a9, D526 had hardened Settings Save but Sync still probed the active migration route with the live, possibly missing/replaced Obsidian adapter. It could expose a raw adapter error rather than pausing Auto Sync, or sample inconsistent route presence across awaits. The route was pinned only when present, not when absent.

RED task 5c0cda18-af4b-4c6c-ada4-c35af21bdd5d: missing adapter produced raw TypeError instead of the typed Re-encryption fence failure. Fix: check original backing and pending/disposed state before and after each active-route probe, require strict boolean, normalize errors; pin both present and absent route status across preflight, retry and index resolution. Ordinary fence checks also recheck backing before returning. Force remains denied on active route. No new authority or fallback.

Nine injected cases in the real Runtime fixture: absent adapter, swapped before/during route and during fence, unreadable/nonboolean route, route disappearance, appearance before remote and after config selection. The first eight are denied before GitHub ref reads; the last permits read-only config selection but no mutations. Assert failed typed state, no blob uploads, unchanged contents and Index, watch disabled and scheduled Sync skipped. Initial GREEN attempt 0153fab3 failed a test assumption (third probe is after config reads, not before); split early and late appearance and retained the stricter no-mutation assertion.

Validation:
- Settings/Runtime d436d02f-be28-47ab-ba7c-e7cbef81a42f: 81/81.
- Installed rehearsal fixture b69badbb-34a7-4105-88c9-1eae0638bca3: 6/6, including active Destination Sync, restart, peer and recovery.
- Recovery 2f19eec2-79eb-40e2-9a12-1d3ed6b08cae: 95/95.
- Main UI 1ba0e541-d5d9-4a51-970e-164f2aa9ca80: 34/34.
- Maximum strict 81d234da, production build 0e647bbc, metadata 7c53e2b7 and package 8d9205e5: exit 0.

Follow-up after d7ab8b8: publication contract c146d8f5 failed because legacy MemoryObsidianVault had no DataAdapter and relied on the production memory fallback. Add a shared isolated text/directory adapter to five Runtime fixtures (no production guard relaxation or assertion deletion). Contract 19d4dc21 12/12, retry 71ce292c 2/2, stage lifetime 9d563cb0 2/2, encrypted speculative winner a3da46c0 1/1 all exit 0; physical selector fault matrix b71089f9 1/1 exit 0. The broad runtime filter and individual runtime-publication-mutation-race execution were tool-safety blocked, not bypassed; the latter fixture change is reviewed but unexecuted. Full Fast is not qualified on the current source.

Scope: cooperative sampled checks, not an OS-wide write lock; no claim to detect changes that revert between reads. No native Obsidian/GitHub or Android migration test in D528. Full Fast D527 applies to older exact snapshot only. Native harness safety block, Force/connection/scope and Wizard Execute remain gated; physical iOS waived. No production Vault, default branch, tag or release writes.
