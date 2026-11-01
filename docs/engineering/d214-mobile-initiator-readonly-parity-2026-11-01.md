# D214 — Mobile initiating-device read-only parity through Obsidian DataAdapter

Date: 2026-11-01. Status: **internal read-only evidence only**; Re-encryption Wizard **Preview-only**, first-release gate **blocked**.

## Missing platform capability

D105/D106 already compare two complete SHA-256 passes over the initiating Vault against immutable, authenticated Source records, but D106's production factory only accepts Desktop Node filesystem access. Mobile's Obsidian adapter has no Node file descriptors, reliable O_NOFOLLOW, native filesystem snapshot, or bounded random-access file stream. Treating the desktop reader as portable would be unsafe. At the same time, using only Obsidian's cached `getFiles()` list could miss a recently created physical file and silently accept a stale inventory.

## Implementation

`src/lib/v4/reencryption-mobile-initiator-reader.ts` provides a **read-only Mobile adapter** using `DataAdapter.list("/")`, `stat()` and `readBinary()`. It recursively traverses real adapter listings in the captured V4 scope, checks canonical Unicode/portable paths and case-fold collisions, requires valid file/folder stats, rejects duplicate or out-of-parent entries, and caps the inventory at 100,000 entries/64 levels. A live cooperative lease, Runtime Sync/edit queue, source settings+adapter identity and *all open/unsaved editor* checks run before inspection and between awaited reads. The content reader checks size+mtime before and after read and after the last hash chunk; D105's existing independent **two-pass full SHA-256** proof still detects same-size/same-mtime edits and new/missing logical files.

Mobile `readBinary()` returns a complete ArrayBuffer. Do **not** pretend it is streaming physical I/O: fail closed on an individual included file larger than the existing `DEFAULT_V4_WHOLE_BUFFER_CEILING_BYTES` (**32 MiB**) before reading. Yield 8 MiB-or-smaller views over that bounded buffer to the common verifier. No settings, secrets, Vault writes, remote Git refs, index or Cutover are touched.

`V4PluginRuntime.createReencryptionInitiatorLocalReader()` now selects the existing Node/real-disk reader on Desktop and the new adapter reader on Mobile; an adapter swap invalidates the captured source settings proof. All proof results retain `initiatorLocalCutoverAuthorized:false`. Missing adapter methods, listing/stat inconsistencies, unsupported capabilities, scope drift, editor state or lease loss fail closed.

## Verification and limitations

Seven D214 behavioral tests cover Unicode and excluded files, full two-pass hashing, external file creation absent from Obsidian `getFiles()`, same-size/same-mtime edits, metadata drift during buffered reads and after yields, unsafe/colliding/traversal paths, oversized-file refusal without allocation, runtime wiring and adapter identity drift. Prior 11 D106 Desktop real-disk tests still pass.

Offline gates: Build and Maximum Strict TypeScript pass; full Fast **1,273/1,273**, Recovery **93/93**, Feasibility **136/136**, Resource **11/11**, GitHub E2E **compile-only**, metadata/package validators and exactly **100,000,000-byte** bounded SHA-256 soak all pass.

**Still not installed-device acceptance.** Mobile DataAdapter listing does not provide a native no-symlink/no-hardlink guarantee, OS-wide exclusive writer lock, consistent filesystem snapshot or bounded physical streaming for files above 32 MiB. Adapter implementation behavior on actual Android/iOS and recovery after interruption remain unverified. This read-only parity is a best-effort prerequisite, **not** independently sufficient for irreversible local Cutover, Backup/Destination publication, old-key cleanup or resuming Sync. The same-physical-repository three-branch policy, best-effort warning and Manual Recovery remain in force. No GitHub Actions, Native Helper, live GitHub mutation, release or branch merge.
