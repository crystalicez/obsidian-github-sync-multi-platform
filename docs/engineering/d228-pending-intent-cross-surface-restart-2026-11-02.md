# D228 — Read-only cross-surface recovery for a pending Re-encryption Cutover Intent

Date: 2026-11-02. Release: **blocked**. D227 authenticates a historical local Candidate and Intent after Restart, but does not prove that persisted plugin Settings or the active and Shadow Index still match the recorded snapshot. This gap must be closed before an authoritative Cutover is attempted.

## Recovery input and observation

`inspectV4FencedPendingCutoverSurfacesAfterRestart` accepts D227's prepared migration identity and a separately supplied `readPersistedSettings` callback. The caller **must** implement this callback using persisted Obsidian plugin-data, not the in-memory settings object. D228 does not invoke an installed Obsidian data reader itself; this is an offline recovery building block, not an installed migration flow.

Under **one held initiating-device owner lease**, D228 reads the original Source Index and orphan Destination Shadow from the V4 local adapter, reads persisted Settings and the existing prepared Selector evidence, and inspects the current authenticated WAL and physical Sync Fence. It reconstructs the D223 snapshot contract from `contract.json` and checks six exact SHA-256 digests: original Source Index, Destination Shadow Index, prepared Selector evidence, WAL snapshot, persisted Source Settings, and derived Destination Settings. Indexes must be complete, clean, encrypted and pinned to their exact device, repository and commit. Settings must still describe the original Source and retain its old passphrase ID.

D228 wraps the D227 four-file Intent/Receipt/Selector restart reader using a **borrowed lease**, rather than reacquiring the external holder. It repeats the complete local snapshot after D227 succeeds and requires byte-for-byte equivalent contract, digest and persisted Settings observations. A single positive result, `source-and-destination-snapshots-match-pending-intent-uncommitted`, means only that the local Source Settings and both Indexes remain coherent with the historical pending Intent. This result is **not** a Commit, does not imply fresh remote Git proof and cannot authorize any operation.

## Fail-closed boundaries

Any missing, unreadable, changed or foreign persisted Settings; wrong branch/key ID; missing/dirty/corrupt/repointed active or Shadow Index; changed prepared evidence; broken or changed WAL; lost old/new key; missing or tampered Candidate/Intent; unexpected live Selector/proposed Commit residue; lost physical Sync Fence; mutated callback, adapter or holder; or mismatch across snapshots maps to `manual-recovery-required`. Neither case writes files, settings, secrets or Git refs.

The reader computes Source/Shadow digests sequentially and keeps only compact digests across full restart passes, avoiding duplicate whole-Index serialized strings in memory. D228 has no promise of OS crash-durable writes or cross-process atomicity. The external persisted-settings reader and owner lease need separate installed-platform integration and acceptance.

## Remaining release work

Do **not** reinterpret a valid pending Intent as an authoritative committed Receipt. The actual two-phase committed Receipt/Selector, active Index/Settings/SecretStorage switch, recovery after partial writes, stale multi-device client handling and installed Desktop/Android/iOS E2E are outstanding. The old independently writable Source, frozen Backup, orphan Destination, two passphrases and full Git history remain intact. Re-encryption Wizard Run stays Preview-only, and the six pending release checks remain blocked. No GitHub Actions or Native Helper.
