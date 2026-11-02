# D237 — Authenticate the existing encrypted Re-encryption WAL after a cold start

Date: 2026-11-02. This is an offline, read-only recovery component. Public Release and Wizard Run remain blocked.

## Why this exists

D236 can rederive the original key and decrypt every live file from the old frozen Backup. That does not prove the local WAL is the exact generation used by the persisted Cutover Contract. Two encrypted slots may be individually valid but belong to different generations, a different run or divergent histories. A success based on a single slot, an unchecked snapshot or the last in-memory initiator could promote a partial Cutover.

## Input and guarantee

`inspectV4ColdStartWalSnapshot` in `src/lib/v4/reencryption-cold-start-wal-snapshot.ts` accepts only an **explicit** relative WAL root, a read-only `exists/read` adapter, the independently authenticated D183 `V4ReencryptionCutoverSnapshotContract`, the **original** 32-byte journal key recovered from the frozen Backup, and a live-owner assertion. It does not select a WAL directory or discover a physical vault. The caller must establish the storage origin and any cooperating writer exclusion separately.

It constructs a new D80 journal through a read-only adapter whose `write` and `mkdir` always reject. The existing journal decoder authenticates AES-GCM slot payloads and strict adjacent-generation transitions, and `assertHealthySnapshot` refuses missing, damaged or displaced slots. D237 checks the exact `identity.walGeneration`, required verified Backup/Destination ref receipts, prepared candidate and staged object state via `matchesV4ReencryptionPreparedWal`. It hashes the complete canonical snapshot and requires exact equality with the persisted D183 `walSnapshotSha256`.

The procedure captures both slot texts, authenticates the journal **twice** and requires the two snapshots and final slot bytes to match the initial observation. It checks pinned adapter methods, contract fields, original key and owner assertion across awaits. A temporary key copy is cleared before returning, while the caller's original key is not modified. All failures return `manual-recovery-required`.

A successful result is `authenticated-current-wal-still-fenced`, with `bestEffortReadbackOnly=true` and all Cutover, Sync, rollback, remote mutation and old-key cleanup authority flags **false**. It is evidence of a coherent **observed** read, not OS power-loss durability or protection from an uncooperative writer between observations. The adapter cannot enumerate unexpected temporary files in the WAL directory; the caller must separately require D164's best-effort checkpoint under a real exclusive lease before relying on the disk layout.

## Verification

`tests/v4/reencryption-cold-start-wal.test.ts` creates a real AES-GCM 10-generation two-slot journal using the public D80 writer. Six cases check a valid read-only reconstruction with no writes; wrong key, run, generation and contract hash; torn/missing predecessor; a slot changed during the read; owner and adapter-method mutation; and a real Windows Node WAL release/reopen in the project-local disposable `.tmp` directory using the best-effort checkpoint before authentication. The fixture's disk data is deleted afterwards.

This component is deliberately **not wired into the installed Obsidian command**. D236 does not acquire the owner-scoped physical WAL root on Desktop, Android or iOS, and the native Settings/SecretStorage/Index state is not yet joined to a complete new-key Destination Git scan. Do not set D236's `coldStartWalReverified` flag, resume Sync, clear either fence, claim platform parity or clean old keys based on D237 alone. No GitHub Actions, Native Helper, forced Git updates, branch deletion or public Release.

## Next

Reconstruct the trusted WAL root and owner scope from actual persisted per-platform storage without guessing; link this proof to the authenticated D236 old Backup route and a **separate complete current Destination Git/Shadow proof**, with verified physical repository and branch refs. Then design and test an actual mutable Destination Index activation, stale-device behavior and Manual Recovery windows. Use native Obsidian Desktop and mobile acceptance before altering release gates.
