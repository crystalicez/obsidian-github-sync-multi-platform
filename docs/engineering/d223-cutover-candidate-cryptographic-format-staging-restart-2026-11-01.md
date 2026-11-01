# D223 — Production-namespace Cutover Candidate: AES-GCM Receipt/Selector, staged disk crash windows, restart readback

Date: 2026-11-01. Status: **internal production-format CANDIDATE, deliberately UNCOMMITTED**. The installed Re-encryption Wizard is Preview-only and release remains **blocked**.

## The blocker addressed

Prior stages D182/D219/D220/D221 used explicit `*-test-vector-uncommitted` Receipt/Selector records for hardening recovery observations. Those bytes cannot be reinterpreted as an authoritative Commit or selected by the runtime. D222 exposes them only as Manual Recovery operator guidance.

D223 begins the **separately namespaced cutover wire format**, not a cosmetic phase rename. It uses a shared domain contract for the real six pinned digests from Source Index, destination Shadow Index, prepared evidence, authenticated WAL, original Source Settings and proposed Destination Settings. Their 128-bit transaction ID and D142 three-branch identity also bind ciphertext AAD and encrypted payloads. The contract carries no plaintext passphrases or OAuth tokens. Existing D182 test vectors retain their own distinct HMAC contexts and remain backward-compatible within their internal test schema. The common validator moved to `reencryption-cutover-snapshot-contract.ts` to stop the eventual production path from importing a *test-vector schema*.

## Cryptographic format

`src/lib/v4/reencryption-cutover-candidate-crypto.ts` seals two **independently encrypted, domain-separated** AES-GCM ciphertext records, with separate HMAC-derived keys:

- `cutover-receipt-candidate-uncommitted`: exact canonical snapshot contract.
- `cutover-selector-candidate-uncommitted`: identical contract plus SHA-256 of the **actual ciphertext Receipt bytes**, not just the plaintext transaction ID.

The keys and AAD contexts are separate from D142 hypothetical markers, D147 prepared selectors and D182 test pair. An intact AES tag alone is insufficient: verifier requires byte-for-byte expected canonical plaintext and fields, same identity/transaction, encrypted Receipt digest, exact base64, key/contract stability and byte limits. It rejects replay, forged `committed` phase, extra fields, malformed records, missing halves and old D182 ciphertext. **Even a fully linked candidate has no authority**: all Cutover/Resume/Rollback/Git writes/old-key deletion flags are false.

`src/lib/v4/reencryption-cutover-candidate-manifest.ts` encodes a separate canonical, untrusted `cutover-candidate-snapshot-uncommitted` manifest to bootstrap the AAD after Restart. It rejects D220's historical test manifest phase, malformed/oversized/extra-key or noncanonical encodings. Its validity is not an authenticated commit.

## Actual adapter staging and restart inspection

`src/lib/v4/reencryption-cutover-candidate-stage.ts` is a guarded, **internal** write path to an isolated root:

`<indexRoot>-rekey-cutover-candidate-<runId>/contract.json` → `receipt.json` → `selector.json`

It holds exactly one external cooperating initiating-device lease; requires matching D142 identity, old Source Settings, both old/new SecretStorage values, the D173 exact active Sync Fence, independently authenticated generation-specific WAL and `best-effort-readback-only` checkpoints. It pins callbacks, paths, key and source metadata across asynchronous operations, refuses any existing root/partial bytes, writes canonical manifest then encrypted Receipt then Selector, checks WAL/Fence after each boundary, reads back all three and verifies AES-GCM linkage. On thrown or interrupted writes it **preserves every surviving byte and the Sync Fence**; never overwrites, retries, repairs, switches the source branch or scrubs credentials. A caller-provided digest contract is syntax-validated here but **its current remote provenance is NOT independently reverified by this writer**; thus this path cannot be used to commit or perform runtime cutover without a separate full D217-equivalent remote gate.

`src/lib/v4/reencryption-cutover-candidate-restart.ts` reads the three bytes back from storage without any in-memory historical contract. It holds one external owner lease, validates WAL/Settings/Secrets/Fence, fully reads, decodes and authenticates the pair twice, rechecks remaining bytes, and returns `authenticated-candidate-uncommitted` or `manual-recovery-required`. **Both cases prohibit every mutation, automatic recovery, Sync Resume, rollback and key cleanup.** It is not a Git content verifier; it cannot stop non-cooperating disk or remote writers, nor prove physical durability.

The candidate root is **NOT** the eventual active runtime Selector path, not an authoritative receipt, not read or used by the installed Wizard or live Sync. There is no production Commit transition in D223.

## Behavioral evidence

- `tests/v4/reencryption-cutover-candidate-crypto.test.ts`: 8 cases using actual AES-GCM/HMAC. Separately test lack of authority, ciphertext replay/substitution, torn/oversized/noncanonical bytes, cross-protocol D182 substitution, forgery of committed phases with a correctly derived key, independent snapshot/identity fields and mutation of input getters during await.
- `tests/v4/reencryption-commit-pair-test-vectors.test.ts` existing 9 cases remain passing after extracting common contract validation.
- `tests/v4/reencryption-destination-exact-commit.test.ts`: stages under a real deterministic D179-prepared WAL/Fence fixture with independently *read* D183 encrypted Git/Shadow snapshot contract. Tests exact on-disk AES pair and unchanged old active Index/Settings/Secrets/WAL; a second call cannot overwrite; interruptions after mkdir, manifest, Receipt, Selector retain evidence; WAL generation lost after Receipt stops Selector; recreated Prepared input without historical contract opens stored candidate; corrupted/missing/foreign contract, Receipt/Selector, lost WAL/Fence/old/new Secrets or mutated manifest during independent readback all require Manual Recovery. No Git mutation is performed.

### Limitations and remaining gates

The adapter fixture is memory-backed, so simulated power interruption proves **logical ordering only**, not real power-loss atomicity, OS fsync, concurrent noncooperating writers, torn native JSON save behavior, or platform-specific SecretStorage durability. There is **no production authoritative committed Receipt/Selector, no active runtime selector reader, no Source→Destination Settings/Passphrase/active Index switch, no restart-safe forward/rollback reconciliation, no user-facing migration Run or live Recovery action**. These must be built and tested with installed Obsidian Desktop/Mobile before the release gate can change. No Native Helper, GitHub Actions, force pushes, deletion/merge of branches, actual vault mutation or release.
