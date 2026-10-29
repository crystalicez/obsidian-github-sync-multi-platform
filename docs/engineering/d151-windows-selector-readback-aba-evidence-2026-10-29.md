# D151 — Real Windows Selector readback drift and undetectable ABA

Date: 2026-10-29. Owner policy **A**: Node.js first, strict Crash-safe Re-encryption, no Native Helper without a separate architecture decision. Keep the Wizard **Preview-only**, release gate `blocked`. No installed vault or GitHub mutation.

## Experiment

The D146 diagnostic `inspectV4ReencryptionSeparatedSelectorAfterRestart()` authenticates a separately stored AES-GCM Selector, independently loads the original Source Index and separate Shadow Index and observes prepared WAL under caller-supplied lease callbacks. It reads each store twice and returns an *uncommitted*, non-authorizing report. **This D151 fixture uses no-op lease callbacks** to isolate the readback race; **D150 separately demonstrated the bypass of an actual held D86 cooperative WAL lease**. In D151, `tests/recovery/reencryption-separated-selector-windows.test.ts` runs the reader against **real disposable Windows disk files** while an actual **independent Node process** in `tests/recovery/support/reencryption-selector-aba-child.mjs` opens that same Selector path directly using `O_RDWR | O_DSYNC`. No mock writer or adapter replaces the mutation. The child is path restricted to the repository's `.tmp` tree and to the `selector.json` test basename.

The parent creates **two distinct independently AES-GCM-authenticated ciphertexts for the exact same migration identity**. The independent writer operates during the first authenticated WAL snapshot, between the first and second Selector reads. The parent also verifies that Source and Shadow remain distinct read-only test indexes.

| External write between the two reads | Actual Selector readback result | Authority |
| --- | --- | --- |
| Replace original ciphertext with a different but valid authenticated ciphertext and leave it changed | `manual-recovery-required` | All cutover/Sync/rollback/remote/secret-cleanup authority flags **false** |
| Replace with different valid ciphertext, fsync, restore the original ciphertext, fsync again *before the second read* | `authenticated-selector-with-both-indices-uncommitted` | All authority flags still **false** |

Both behaviors were verified on Windows through genuine filesystem I/O in independent processes. The second case is the **ABA limitation**: two byte-identical snapshots **cannot prove no external writer executed between observations**. This is not a cryptographic failure; both AES-GCM records validate the same expected identity. It is a missing cross-process writer/external Vault editor fence and not something solved by adding more reads, hashes or a WAL lock understood only by cooperating processes.

## Risk and policy

- An `OBSERVED` diagnostic report is evidence of **only the sampled authenticated state** and must not be interpreted as durable, globally exclusive, serializable, or committed. The D146 interface already hardcodes `localCutoverAuthorized`, `resumeSyncAuthorized`, `rollbackAuthorized`, `remoteWritesAuthorized` and `oldPassphraseCleanupAuthorized` to `false`.
- The D86 Node-only `.exclusive.lock` protects cooperating clients but cannot stop the independent process proven in D150. D151 further shows a transient writer can evade D146's double read without changing its observed final bytes.
- Do not weaken owner-approved strict Crash-safe standards or enable Re-encryption cutover on this evidence. The test involves **process-level concurrency**, not unexpected machine power loss; file/directory provisioning durability, atomic Settings/SecretStorage/Source/Shadow/WAL/GitHub state, immutable ref verification, genuine multi-device installed Obsidian acceptance and independent security review remain unproved.
- **Next proof:** evaluate whether a Node.js-only Windows mechanism can enforce global non-cooperating file writes and an independent physically durable intent without platform-specific native helper. If unable to establish either requirement, keep Windows cutover blocked and present an explicit architecture decision to the owner; do not silently select weaker best-effort safety.

No production Writer, actual passphrase, Index, GitHub ref or installed Obsidian Vault is mutated. D151 modifies only read-only documentation of the existing diagnostic contract, test fixtures and isolated subprocess code.
