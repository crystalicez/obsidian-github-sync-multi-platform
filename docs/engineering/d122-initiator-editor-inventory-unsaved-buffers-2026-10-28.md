# D122 — Re-encryption initiating Vault parity must not miss unsaved/open editors

Date: 2026-10-28. **Pre-publication/pre-cutover conservative safety hardening; release remains BLOCKED.**

## Verified correctness gap

`verifyV4ReencryptionInitiatorLocalParity` already double-hashes the physical local Vault and checks live runtime/lease/scope guards. But its editor guard rejected an open editor **only if its path was among the authenticated remote source records** (`expectedCanonical.has(...)`). Consequently the function could return `noOpenEditorsObserved:true` while an **uncommitted new file**, an editor outside the sync scope or another non-source editor was open. A new Markdown buffer can have unsaved data with **no physical file or remote source record at all**: disk inventory parity cannot detect it.

Further, `V4PluginRuntime.createReencryptionInitiatorLocalReader()` enumerated active/leaf `file.path` only. An unsaved Markdown editor with no assigned TFile/path was silently omitted by that runtime guard. The D90/D91 owner-approved procedure explicitly requires pausing Vault editing during migration; returning a clean editor report under either condition would be misleading.

## Fail-closed change

- `src/lib/v4/reencryption-initiator-parity.ts`: reject **any** nonempty open editor path listing, not just paths in the source manifest. The method continues to reject a missing/nonarray enumeration; no parity success is produced until all enumerated editors are closed.
- `src/lib/v4/runtime.ts`: reject an `activeEditor` without a bound file path; inspect every Obsidian workspace leaf and reject a `getViewType() === "markdown"` leaf with no file path. Continue reporting all bound leaf/editor paths for the parity guard, including those outside the source inventory.
- No file is closed or saved automatically. No source file, settings, branch, passphrase, local index or GitHub ref is modified, and no cutover is authorized. Users must explicitly close or save/discard their edits themselves before any future migration preflight can pass.

## RED→GREEN regression evidence

- New `tests/v4/reencryption-initiator-parity.test.ts` case opens an editor to `draft/new-unsaved.md` (absent from the authenticated inventory and disk) and `.obsidian/workspace.json` (outside the source records). **The new regression failed before the parity fix**, proving a false `noOpenEditorsObserved:true`.
- Extended `tests/v4/reencryption-desktop-initiator-reader.test.ts` installed-runtime adapter case tests (a) a known file open, (b) untracked unsaved new note path, (c) a Markdown view without a bound file path, and (d) an active editor without a bound path. The pathless Markdown case **failed before the runtime adapter fix**, then passed after fixing enumeration. Existing live connection/lease change refusal remains verified.
- Focused parity **10/10**, desktop physical reader/runtime **11/11**, full Fast **924/924**, Fast repeat **10×924/924** (exit 0), Recovery **80/80**, Resource **11/11**, Feasibility **136/136**, Maximum Strict TypeScript and Production Build PASS. GitHub E2E compile-only 3 bundles and package/metadata validation PASS. Bounded crypto Soak **100,000,000 bytes / 12 chunks**, exact reference SHA-256 matched.

## Limits and release blockers

This is a **conservative read-only preflight**, not a real OS-enforced writer fence. A different process can still modify files between samples, or a new editor can open after the last guard. The initiating-only transactional branch/passphrase/index cutover, full OS vault edit fence, new-key origin/recovery, installed multi-device Windows/mobile qualification and numeric-pin live GitHub same-repo three-branch E2E remain incomplete. Node-only Windows directory `fsync EPERM` still cannot prove true sudden power-loss WAL durability.

The owner-approved D90/D91 topology remains: independent writable old Source, frozen Backup pinned at source SHA, zero-parent encrypted orphan Destination, **all in the same GitHub repo**, with other clients manually switching if desired. No GitHub Actions, automatic old-branch cleanup, Native Helper promotion, durability waiver or Wizard enablement. Release gate `docs/release-gates/reencryption-wizard.json` stays `blocked`.
