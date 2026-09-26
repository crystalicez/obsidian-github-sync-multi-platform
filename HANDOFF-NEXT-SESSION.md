# HANDOFF — NEXT SESSION

> Persistent handoff for the `obsidian-sync` project.
>
> **Mandatory workflow rule:** Every AI session that makes a material change to code, tests, design decisions, branch/PR state, verification status, or next steps MUST update this file before ending or handing work off. GitHub is the source of truth.

## Active production audit — 2026-09-26

Branch: `audit/2026-09-26-production-hardening`
Baseline master: `ef4f8e675a0be7d598c22b2ce88c843c1306c926`

The user requested the most detailed practical production audit possible. This audit is active and must be resumed before declaring the repository closed again.

Audit method:
- prioritize data loss/corruption, cross-target mutation, fail-open protocol behavior, remote-input/resource amplification, crash consistency, credential/symlink/path safety, GitHub mutation ambiguity, cancellation, and concurrency;
- distinguish prior acceptance coverage from adversarial audit coverage;
- confirm each production candidate with a RED regression before changing behavior;
- use TDD for fixes;
- do not run destructive live GitHub E2E or `release:local` merely as audit verification.

### Confirmed production findings awaiting RED tests/fixes

1. **HIGH — local-index cache integrity is not content-authenticated before becoming remote authority.**
   - `loadV4LocalIndex()` checks that the persisted shard's `hash` string equals the header's advertised hash but never recomputes that hash from the loaded records.
   - A cached shard whose records are omitted/modified while its old `hash` field remains unchanged is still considered complete.
   - The plaintext unchanged-head fast path can reconstruct `V4RemoteState` from that cache without loading the immutable remote shard.
   - Consequence: Force Pull can treat a still-remote file as deleted locally; normal sync can also plan/publish from an incomplete remote record set and remove metadata/object reachability for an unrelated remote file.
   - Intended fix: recompute the canonical remote shard content hash from loaded cached records (excluding local-only cache fields such as `dirty`) and invalidate the cache on mismatch; retain the valid unchanged-head optimization.

2. **HIGH — settings/credentials can change while a sync is active, allowing cross-target state mixing.**
   - Setting UI currently assigns `plugin.settings = tempSettings` before `saveSettings()`.
   - `saveSettings()` invalidates keyring generation and replaces `githubClient`, but does not cancel/await the active coordinator run.
   - Runtime reads `this.plugin.settings` and `this.plugin.githubClient` repeatedly across awaits, so one run can observe repo/client/settings from different generations.
   - Consequence: state/config loaded from target A can be combined with repo identity/client/passphrase/policy from target B.
   - Intended fix: add a non-disposing coordinator/runtime quiesce operation; abort + await the active run while old settings/client remain installed, then atomically publish/store the new settings/client.

3. **HIGH — empty-repository bootstrap unknown outcome can silently adopt an unproven competitor commit.**
   - After a lost/unknown Contents bootstrap mutation response, `ensureGitRepositoryInitialized()` accepts any newly observed ref SHA as the bootstrap commit.
   - There is no proof that observed SHA was created by this invocation; a concurrent initializer can win in the unknown window.
   - Definitive 409/422 bootstrap races already replan correctly, but unknown-outcome bootstrap currently has weaker semantics.
   - Intended fix: if an unknown Contents PUT is followed by newly non-empty repository state, throw typed `V4RepositoryBootstrapRaceError` and replan rather than adopting the observed commit.

4. **MEDIUM/HIGH resource safety — encrypted remote config accepts unsupported/unbounded KDF semantics.**
   - `decodeV4RemoteConfig()` currently validates version/mode/path layout only.
   - Encrypted `algorithm`, `kdf`, `kdfParams.iterations`, and salt representation/size are not strictly validated.
   - Runtime passes remote iterations directly into WebCrypto PBKDF2.
   - Consequences: unsupported protocol fields are silently interpreted as current AES-GCM/PBKDF2 behavior; forged/corrupt configs can request extreme PBKDF2 work and cause CPU/resource exhaustion.
   - Compatibility note: tests/legacy fixtures intentionally use low positive iteration counts, so the fix should enforce recognized algorithms, positive-safe integer iterations plus an upper resource ceiling, and strict bounded base64url salt without imposing a new high minimum that breaks legacy repos.

5. **MEDIUM resource/protocol safety — history journal identity/page fanout is insufficiently bounded.**
   - Commit classification accepts any non-whitespace suffix after `obsidian-sync-v4:` as a journal ID, while the writer emits a restricted `${timestamp}-${base64url}` token.
   - Page 0 `pageCount` controls one remote read per page without a protocol ceiling.
   - Subsequent pages are not required to agree on `pageCount`; page change arrays are not bounded to the writer's 500-change default.
   - Consequences: forged/corrupt plugin-looking history commits can cause large request amplification and path-like journal identifiers.
   - Intended fix: validate journal ID token shape/length, bound page count, enforce positive integer page metadata/cross-page consistency, and cap changes per page to the writer contract.

6. **MEDIUM resource/protocol safety — remote record descriptors permit workloads the writer cannot produce.**
   - Remote record validation does not require non-negative safe `size`, bounded chunk part counts, or writer-compatible pack-entry sizes.
   - Chunked `V4StorageCodec.read()` currently fans all `partPaths` through `Promise.all()`.
   - Writer already enforces a 400 content-mutation/revision budget and pack limits (500 files, <=1 MiB entry, <=32 MiB plaintext group), but reader validation does not enforce corresponding impossible-state rejection.
   - Conflict/merge/copy/history paths use the whole-buffer reader, so forged metadata can amplify concurrent remote reads.
   - Intended fix: enforce remote record numeric/descriptor bounds using the writer constants and replace unbounded chunk `Promise.all()` with bounded/sequential reading as defense in depth.

7. **HIGH crash consistency — interrupted desktop stage replacement was not resumable from the backup-only state.**
   - Desktop atomic commit swaps `target -> <stage>.target-backup` then `stage -> target`.
   - A process crash between those renames leaves the target absent and the durable backup present.
   - Recovery previously evaluated the logical target precondition before delegating the large staged write to `commitStage()`, so this valid interrupted state could be classified as changed/replan-required instead of resumed.
   - RED coverage: `5a86244f21dac3d32e42e2cb330aee3356b52cc2`, `2c4de65ae99d2c558c9ac8845a7e08249deb6a8a`.
   - Fixes: `99f8e793c3270adbc0c9d48bfe7ec904f6f8c930`, `e2d9dae3bda454d0004b472aa6d54e687cc04a34` make desktop commit recover the backup-only intermediate state and let large recovery delegate the atomic precondition/recovery decision to the platform commit path.

8. **MEDIUM/HIGH memory safety — large chunked conflict-copy path could materialize the whole remote file before staging.**
   - Conflict-copy construction had a fallback `readRecord(...) -> stageBytes(...)` path.
   - For chunked content this defeated the streaming/staging design and could allocate the entire remote file in memory during a keep-both conflict.
   - RED coverage: `744c42ae289deb28ead5115f269317a3dff602c7`.
   - Fix: `d49bb3c8c38700aa7eec6a149b0b08d90e83a74a` routes chunked conflict copies through `stageRemotePull()`, retaining bounded streaming into staging.

9. **HIGH data loss — recovery replan cleanup could delete the only pre-sync backup after an interrupted desktop stage swap.**
   - If the process crashed after `target -> <stage>.target-backup` but before the durable recovery receipt, a later remote-head change could mark recovery `replan-required`.
   - Runtime then called `discardV4RecoveryStages()`; desktop `removeStage()` removed both stage residue and `.target-backup`.
   - In the backup-only crash state this could delete the only remaining copy of the local pre-sync target.
   - RED: `130fa31665b08728d7402f9967535cf2daa43508`, `77f283dbcf8c582c21c7bce569c12152b0cd5be9`, mobile contract `df79be819e5c5e2c6405b4931f01206c7ae52316`.
   - Fixes: `2e1251d06985a827086f970f1d48d5ab93eb673e`, `8d90ce599c152dfb076872a17968d781eca61dca`, `82987f41177ca4f927a30a9d6eb82d3e81419e23`, `d8fced6f4d79dafec9e59de29a58959c13fdc354`, `af293a38cc311b50bba9a731e8f60798353b0e17`.
   - Desktop rollback restores a verified backup when target is missing or still contains the staged bytes, refuses to overwrite unrelated user edits, and only then allows stage cleanup. Non-desktop rollback is a no-op because mobile never creates desktop target backups.

10. **HIGH — debounced local-change work could cross a settings/target generation even after active-run cancellation.**
   - The first settings fix cancelled/awaited the active coordinator run, but an old generation's debounce timer/pending queue could still fire after the new repo/client/settings were installed.
   - RED: `b0ac790970c6ac885dee48f8b235835c50584de7`.
   - Fixes: `a57fe29f03d3352640ad797b8d09a8598b764ed9`, `4b1897494ec2b24beabc8211f6b6ea719c5d2433`.
   - Coordinator now has reusable `cancelPending()`; settings quiescence clears old pending/timer state before cancelling the active run and again after idle, while leaving the coordinator reusable.

11. **MEDIUM privacy/correctness — Sync Center cached history service across settings generations.**
   - `V4SyncCenterView` retained one `V4HistoryService`, while that service captures GitHub client/config/keyring at creation.
   - After repo/token/passphrase rotation, subsequent history actions could continue reading the previous repository; an in-flight old history request could also complete after settings changed.
   - RED: `f49f2ee92ae6504db7f3d4b8a52a10b5da240df3`, `62d775dfd3675ef2c5ec73c8e466853eeac45360`.
   - Fixes: `634391f1e3ba167fe2559da0b2be9ece1a799e26`, `85ae7b944a401d278805bb03eb61238f76ed5f7a`, `4cb2eed2942b853e77ea7a237c00f5bd01c69e4b`.
   - Runtime exposes a monotonic settings generation, captures one client/repo/passphrase generation for history creation/file lookup, old history services assert their generation at async boundaries, and Sync Center recreates its cached service when the generation changes.

12. **MEDIUM/HIGH integrity — GitHub Contents 200 could bypass binary authentication when the response SHA was malformed.**
   - `getFileBytes()` only verified decoded Contents bytes against Git blob SHA-1 when the returned `sha` already matched the 40-hex pattern.
   - A non-empty malformed SHA therefore skipped verification and the decoded Contents payload was accepted directly.
   - This undermined the binary-transformation defense used for encrypted/opaque metadata and could propagate unverified bytes into protocol decoders.
   - RED: `7af7f593b634a445f88a469645874ed668138989`.
   - Fix: `934b7a979e0958ea8deb5907cf3594311dac0a2b` requires a valid Git object SHA before any 200 Contents payload can be trusted, verifies decoded bytes against that SHA, and otherwise falls back to the raw Git Blob endpoint using the validated SHA.
   - Fixture cleanup: current GitHub transport fixtures now use protocol-shaped 40-hex object IDs rather than symbolic placeholder SHAs where the Contents boundary is exercised.

13. **MEDIUM history correctness — strict V4 descriptor validation exposed that external Git history preview was using the V4 codec path.**
   - External commits produce raw Git tree/blob descriptors, not V4 storage descriptors with `pathId/plaintextSha256/remoteVersion`.
   - Reusing the V4 descriptor validator/codec for external history would reject those changes; on encrypted repos, attempting V4 decrypt semantics on an external raw blob is also conceptually wrong.
   - RED: `24e0d41a4aaf246992b045aca49fb226a79a4978`.
   - Fix: `91a81da29e06da35ea09886645bb07543717674e` routes external history previews directly through the immutable commit tree/raw Git blob while plugin-authored history continues through the V4 storage codec and descriptor validation.
   - Fixture cleanup: `7a2818d0c2bfdcae6eb70d39bf8b108c1aa71a98` keeps legacy remote-index fixtures protocol-shaped under the stricter validator.

14. **MEDIUM/HIGH integrity — raw Git Blob 200 responses were trusted without authenticating bytes against the requested object ID.**
   - Contents fallback intentionally treats the Git Blob endpoint as canonical, but `getBlob()` previously returned any 200 `arrayBuffer` directly.
   - A malformed/proxy-transformed 200 could therefore defeat the canonical fallback assumption.
   - RED: `6d324737c23a1e4fbde51f8bbd089c7a6ef48d16`.
   - Fix: `4f9b970f5db15fea65d91bcfc8e7140128e034cd` validates the requested Git object SHA, requires raw bytes, computes the Git blob SHA-1 over `blob <len>\0<bytes>`, and rejects mismatches or unavailable verification.

15. **MEDIUM resource hardening refinement — initial PBKDF2 ceiling exceeded the writer contract.**
   - The first KDF fix bounded remote iterations at 5,000,000, but the production writer emits exactly 600,000.
   - Accepting >600,000 preserved an avoidable remote CPU-amplification range the writer never creates.
   - RED refinement: `f07c06ee88bb5d5dc5f238292297dcfe2dacd4fb`.
   - Fixes: `c14ffb89b79aae4287f762fbd8d82a86e61facd5`, `b093ad1cebbb10b11d4202471c52a73e252bc5fc`, `4a03d7954859d63064bfc2ece5c88518fafe3232` define one shared exact 600,000-iteration writer/reader contract.

16. **MEDIUM fail-closed boundary — successful GitHub list/tree/object responses still accepted malformed object IDs/shapes.**
   - After initial response-shape hardening, refs/commits/mutation object IDs could still be arbitrary non-empty strings, and history list/tree responses could omit required structure such as the tree `truncated` boolean.
   - Malformed 2xx data could therefore move failure into later dependent operations or make history treat incomplete evidence as complete.
   - RED: `e05415043c61425897ba2c602d29e694a5c8159e`, `99bbd729d40cc9b08c1c79beb142b9ca0083d00b`.
   - Fixes: `751aeace07b7edf4bd226ed800ae11cc2ed5a4a8`, `8277a94652319e134bf0a304050ef76889d0895a` validate commit-list/tree shapes and require 40-hex Git object IDs at ref/commit/tree/blob mutation boundaries.
   - Fixture normalization: `28cc0e313c54757c930b96136a588af39c56c023`, corrected by `18c0509b9a8023de72e6f1794b30aae511091729`, keeps transport fixtures object-ID shaped without changing semantic `type: "blob" | "commit"` literals.

17. **MEDIUM destructive-action safety UI — Force Push/Pull confirmation understated the actual synced local scope.**
   - Confirmation counted vault files by excluding all `.obsidian/*`, while production scope can intentionally include config, bookmarks, community plugin metadata, and other plugins.
   - With those settings enabled, the destructive confirmation displayed fewer affected local files than runtime would actually consider.
   - RED: `50de3d3925e371001142b0b61f0b65ae9b32a0f6`.
   - Fixes: `d21c1c5d4a92d7875c4da6d185e78d39f4a774fa`, `111e9fdd0549f4f9de93753909eae1c6a3a085ba` centralize scoped-path counting on the same predicate used by runtime and use it in the force confirmation.

18. **MEDIUM settings safety — invalid ignore-regex edits could disrupt the current generation before being rejected.**
   - Scope compilation can throw for an invalid regex. If validation occurs only after runtime quiescence/settings publication begins, an invalid edit can cancel legitimate in-flight work or partially rotate runtime state even though settings are not accepted.
   - RED: `0fa5a74fe39259d117ecffc140b2ffadd76d3796`.
   - Fixes: `38928aa3aed4e51b82b4f23b65a3450544d7d946`, `3b6d46cb7c0d2d272021cacb59c851452a51625e`.
   - `saveSettings(nextSettings)` now compiles/validates the ignore regex before quiescing the old runtime generation, and the settings UI reports failure without publishing the invalid generation.

19. **MEDIUM remote resource amplification — chunk descriptors were broadly capped but not constrained to counts the writer can actually produce for the declared size.**
   - The first remote descriptor hardening allowed any positive part count up to 400.
   - A forged small or ~50 MiB record could therefore claim hundreds of canonical-looking part paths and trigger unnecessary immutable reads despite the writer using at least 1 MiB parts, at most 48 MiB parts, and not chunking below the threshold.
   - RED: `429b10ce5bc68bad0be548caf20b8826397759e3`.
   - Fix: `690f64ed557836caa3fb4923a833d7cb0e2d61e1` requires chunked records to cross the writer threshold and constrains part count to the writer-compatible range `ceil(size / 48 MiB) .. ceil(size / 1 MiB)`, while retaining the 400-mutation budget ceiling.

20. **MEDIUM/HIGH settings fail-closed regression — runtime validator existed but was not actually invoked before sync.**
   - `assertPluginSettingsRuntimeSafe` was added and settings-save validation called it, but `V4PluginRuntime.execute()` only imported the validator without calling it.
   - The existing RED contract in `tests/v4/settings-secrets.test.ts` explicitly required runtime validation before GitHub access; without execution, malformed persisted settings could still reach runtime work.
   - Fix: `d8fa4a6d9b7280fe4ca0a6076f579a281fbfc82d` invokes `assertPluginSettingsRuntimeSafe(this.plugin.settings)` immediately after cancellation check and before progress/network/session work.

21. **MEDIUM local destructive-replay safety — integrity-valid recovery payloads were not constrained to the writer contract.**
   - Recovery payload validation accepted arbitrary strings for mutation paths/IDs, duplicate IDs, completed receipts unrelated to any mutation, weak stage IDs/hashes/sizes, and incomplete/invalid target preconditions.
   - Plaintext recovery integrity is an accidental-corruption integrity check, not a keyed authentication boundary; coherent local state edits or programming bugs could therefore feed writer-impossible data to trash/write recovery replay.
   - RED: `96d07441114cdbeaf7a3737b7dff2a3daf91a0b2`.
   - Fix: `d9467e54517e1c357063acdfa4f256e1c92f3359` validates normalized vault paths, unique bounded mutation IDs, receipt subset/uniqueness, stage ID/hash/size/mtime, and exact target-precondition shape before loaded recovery state becomes replayable.

22. **MEDIUM invariant safety — unsafe recovery payloads could be replayed immediately after save without passing the load validator.**
   - `V4RecoveryStore.save()` returned the caller's payload in the snapshot and the sync path can apply that snapshot immediately.
   - Loader-only validation therefore did not protect the current process from an internal/upstream writer-contract violation.
   - RED: `722524c9abad4099f979fe59cd19d46b4da6fa3a`.
   - Fix: `2f2f1ac0875623279ff35362e82c097027504869` applies the same payload validator before persistence/return, so malformed recovery state cannot become replayable in-process or after restart.

23. **HIGH local-mutation safety — external Git paths were not normalized before entering reconciliation/planning.**
   - Manual/plaintext Git commits can introduce tree paths not emitted by the plugin writer, including backslash/noncanonical path forms.
   - Without an explicit trust-boundary check those paths could flow toward local pull planning with platform-dependent normalization semantics.
   - RED: `5a0409c06a3507f27fd1d15a2d220a33130e675d`.
   - Fix: `a42e50294fc3db66a30a4eaed69af56d84a9f291` requires every external non-internal blob path to pass `normalizeV4VaultPath` and already be canonical before any file read/planning/local mutation.

24. **HIGH conflict safety — external reconciliation synthesized remote mtimes and the `newer` policy treated them as authoritative.**
   - Git trees do not carry file mtimes, so reconciliation uses a local synthetic timestamp.
   - Under `newer`, a concurrent local edit could be overwritten merely because the synthetic remote timestamp happened to be later.
   - RED: `037845866387da48402e00ee5fe4528bee33c7be`.
   - Fix: `3433f06d1d31535a0adf57079e9193405a94382a` downgrades `newer` to keep-both/copy conflict resolution for externally reconciled state, preserving both sides instead of comparing synthetic time.
   - Follow-up `ae590080696312eeba0c5cf122cf32eb74bdc150` keeps synthesized external `remoteVersion` inside the protocol-safe token alphabet.

25. **MEDIUM fail-closed Git boundary — successful empty-repository bootstrap accepted a malformed commit object ID.**
   - Contents bootstrap `200/201` extracted `commit.sha` as any non-empty string, unlike the hardened immutable Git object APIs.
   - A malformed 2xx response could therefore trigger a dependent create-ref mutation using an invalid/unproven object ID.
   - RED: `fb8c8196c26a2be984defdb23d62c8acf9f11ca7`.
   - Fix: `95b56311885d9fbce55996e24afc3a593b355bd0` requires the bootstrap commit SHA to be a valid 40-hex Git object ID before any dependent branch creation.

26. **HIGH sync correctness — authoritative full scans trusted size+mtime and could silently miss content changes.**
   - The targeted watcher-change path already rehashes changed files.
   - Startup/scheduled/manual runs with no queued changes and explicit `rescan` used the full-scan path, where matching cached size+mtime reused the prior content hash.
   - Tools/restores that preserve both size and mtime could therefore change bytes while a normal authoritative sync continued to report no change and retained the stale index hash.
   - RED: `980f9211f2addc2d70cc83e071b82f419799f7c5` covers both no-change-list full scan and explicit rescan.
   - Fix: `f41c250c6f32a69244455b508423519079bb941f` disables stat-only hash reuse for authoritative full scans/rescans; targeted event-driven scans retain the optimization.

27. **MEDIUM settings lifecycle safety — malformed persisted settings could affect startup/client/timer policy before runtime validation.**
   - Runtime execution and settings-save boundaries were already validating settings, but `loadSettings()` installed migrated persisted settings before any validator ran.
   - `onload()` then used those values for GitHub client creation, startup-sync policy, scheduled-sync policy, and runtime construction before `V4PluginRuntime.execute()` could reject them.
   - RED: `d8a6c5eed4efe5eb50f46732f59106f5ae6d484e`.
   - Fix: `4319fb067755953613f95e218b206410b73627c2` validates the default-merged + secret-migrated settings object before assigning `this.settings`, preserving valid legacy secret migration while preventing malformed persisted safety controls from reaching startup policy.

28. **LOW/MEDIUM lifecycle safety — a late workspace layout-ready callback could recreate startup work after plugin unload.**
   - `onunload()` clears an already-created startup timer, but the registered `onLayoutReady` callback could itself run after unload and create a new timer that no later unload pass would clear.
   - The disposed runtime would reject/skip eventual work, so this was not a remote-corruption path, but it could retain a stale callback/timer after plugin disable/reload.
   - RED: `a01a7d2aa57908032bc0cccb72c8e76cbd3c660c`.
   - Fix: `90350f2f9afc18b5079b0b3dda3a6ad09f9def99` guards both the layout-ready callback and delayed startup callback with the plugin unload flag.

### Audited surfaces with no new confirmed defect so far

- secret migration/persistence: raw token/passphrase are removed before plugin data persistence and use Obsidian SecretStorage;
- debug payload/logging: sensitive key redaction, recursive error sanitization, cycle/depth bounds are present;
- GitHub mutation retry policy: reachable-ref mutations are not blindly retried after unknown outcomes;
- publication reconciliation: ancestry work is bounded and fails indeterminate rather than claiming success;
- request scheduler/transport policy: read/write concurrency and rate-limit waits are bounded/abortable;
- local release publication tooling: canonical repo checks, create-only stable refs, ambiguous-state reconciliation, exact asset set/size/hash verification, and temp-ref compare-delete are present;
- workflows: Actions are SHA-pinned, CI uses read-only contents permission, and the legacy Actions stable-release path remains intentionally interlocked;
- local target preconditions still use size+mtime at final mutation boundaries, but authoritative local discovery no longer treats matching size+mtime as content identity; the remaining narrow TOCTOU window is guarded by source hashing/stability where content is read and remains a residual OS/filesystem race rather than the previously confirmed full-scan blind spot;
- recovery payload path/ID/stage/precondition validation is now enforced on both save and load; remaining header-field tightening is low-priority local-state hardening rather than a confirmed destructive path;
- retired encrypted key material is best-effort zeroized on runtime disposal, but resolved keyrings invalidated by settings changes may remain in the cache's retired set until disposal. Immediate zeroization is intentionally not changed yet because history work exists outside the sync coordinator and can hold a live keyring reference; settings-generation guards now stop stale history results, but tighter reference-counted key lifetime remains a residual hardening opportunity. (full path/duplicate-ID/numeric validation), but header integrity and normal writer ownership mean no equivalent concrete production corruption path is confirmed yet.
- Obsidian `requestUrl` buffers HTTP response bodies before the V4 reader can inspect expected descriptor/tree sizes. Git/V4 integrity checks and read concurrency still fail closed after receipt, but a forged unexpectedly large remote blob can create transient peak memory above the writer contract before rejection. A meaningful fix requires a streaming/bounded transport API; a post-allocation size check would not solve the peak-memory risk and is intentionally not presented as mitigation.

### RED regression status

RED tests have now been pushed on the audit branch:
- `494c7c57d86eb3125ccd7b664512a4c57b7e07c8` — local-index cached records can be tampered/omitted while the advertised hash string remains unchanged.
- `88d0dad51c6f7f4a3b6a96a923b5040cc9973e0d` — encrypted remote config KDF/algorithm bounds and remote record numeric/chunk descriptor bounds.
- `ced09a381e8c2f4bd4e2bd772d631117f3807733` — history journal marker/page-count safety.
- `e8268b238fef068a97be4469e5d6777dc3d954d0` — unknown bootstrap outcome plus competitor ref must be a typed bootstrap race.
- `01c6190b6d457e37a1ebed473b7285668f61f650` — reusable active-run cancellation required for settings rotation.
- `89cc24a6664cd4839e8f5e991567cbc653adaf71` — whole-buffer chunk reads must have bounded concurrency.
- `088e3d18cc4e646f095859259a18d09ab03a6d29` — settings UI/main must quiesce the old generation before publishing new settings/client state.
- `83a9044b8047c9a57c8bae6e33878fd3db735037` — freshly fetched remote shard records must match the head's advertised shard hash.

Refined root-cause design:
- create one canonical shard-record hash function and use it for writer hash creation, remote shard verification, and local persisted-cache verification;
- validate remote config/head/record/history metadata at decode boundaries using writer-compatible limits;
- bound whole-buffer chunk read concurrency even after descriptor validation;
- add coordinator `cancelActive` plus runtime quiesce and make settings publication occur only after the old run is idle;
- unknown empty-repository Contents bootstrap outcomes must replan on newly observed repository state rather than adopt an unproven SHA.

Execution constraint recorded during this audit: a direct sandbox clone of the audit branch was attempted and failed with DNS resolution error `Could not resolve host: github.com`. Do not claim local suite execution from the AI environment unless a later attempt succeeds.

### Production fix status

Root-cause fixes are now on the audit branch:
- `da56f07630a1f388249fc588b246f1a46a7d29bb` — add canonical V4 shard-record hashing helper.
- `378059b94b33dc8b495f0b4810c2b9b4b9219dd2`, `3dba921c263e5098214cb9bad800836c8b817ed9` — validate local cached shard hashes on load and refuse mismatched shard persistence.
- `dcff671b8b09baab72a3ecd580819f1de28d7c76`, `359b873277cfb25456faf1617e76b54c04073472` — writer derives head hashes from canonical records; remote loader verifies both cached and freshly fetched shards against the head.
- `e300fe07983a757d0020cb8fe8c79a18993e1e4e` — unknown empty-repository Contents bootstrap outcomes with newly observed repository state now surface a typed bootstrap race instead of adopting an unproven SHA.
- `88990134ae8e8764e8b8c0696e16c934020727ae`, `aab2e432c74dc7b550455d5300a1a604eaac087f`, `e382e63e085fc196e8015c4dc046a7c1c99e8473`, `a04ba7b4f9b233871328368fbdb58da1591965fa`, `d2a02390b7c725a40f96ebc392153b8a13611fd8` — reusable active cancellation, runtime quiescence, settings publication ordering, and progress cleanup for atomic settings/client generation rotation.
- `f2ad17aef7d833178f7e9ba105489ce6fb6ad999`, `8c6bd38cdb0b9bc3a953a4bc9dcda0734b6bf60b` — encrypted config/KDF bounds plus remote head/record/shard shape/resource validation.
- `ff2780ff1543fde9b3914db174b733a998011f9f` — bound whole-buffer chunk remote reads to four concurrent part fetches.
- `6151868d066c050deef9159d3beda389e2ae0ce7`, `d9cde1a72496a8c86df5c85b975d39b92998f873`, `0c301523e774d54bc03191aa7a897da98691ac81`, `06335328777bd5010e928c1951f1cdb581aac2f0` — bounded journal writer/reader contract, safe journal markers, cross-page consistency, descriptor validation before blob reads, and preview-limit precedence.
- fixture-only followups `4ce0affffce484398db30b0de339af8a2dd1e5cf`, `e5ae96eda6003faa4233346bd5104561e2258923`, `40fc418844c40a52ef4baa39c7318f21a5547782`, `b876e4076084e544ec13ec0ef60c9ef7e0cbcc8a` keep tests protocol-shaped rather than weakening production validation.

Recent crash/memory hardening:
- `99f8e793...` / `e2d9dae3...` — interrupted desktop staged swaps become resumable.
- `d49bb3c8...` — large chunked conflict copies stream directly into staging.

Verification status:
- AI sandbox execution is still blocked from obtaining the repository: direct `git clone` failed because `github.com` cannot resolve; local tools visible are Node 22.16.0, npm 10.9.2, TypeScript 5.8.3, and no pnpm.
- GitHub Actions runs were queried for the audit branch and none were available; connector-created commits did not produce a usable CI run.
- Therefore no full suite may be claimed yet. Continue static/targeted audit, then request the established user-local gates only after the audit branch is coherent.

### TDD plan

Write RED regressions before fixes:
- `tests/v4/local-index.test.ts`: records tampered/omitted while advertised hash remains unchanged must invalidate cache.
- `tests/v4/sync-coordinator.test.ts` + settings/runtime contract test: cancel active run without disposing and remain reusable; settings save must quiesce before publishing new settings.
- `tests/v4/github-transport.test.ts`: unknown bootstrap response followed by competitor ref must surface a typed bootstrap race.
- `tests/v4/protocol-core.test.ts`: unsupported/unbounded encrypted remote config must fail before key derivation.
- `tests/v4/history-service.test.ts`: unsafe journal marker, excessive pageCount, and pageCount inconsistency must fail closed with bounded reads.
- new remote-metadata bounds regression: invalid size / excessive chunk descriptors reject before body fanout; chunk reader must not create unbounded concurrent reads.

After RED proof:
1. implement minimal root-cause fixes;
2. update this handoff with exact commits and any refined severity;
3. attempt focused verification in the AI environment;
4. if repository execution remains unavailable, provide one user-local focused gate before full acceptance;
5. open a draft audit PR only after the branch diff is coherent; do not merge without explicit user request.

## Final repository state

As of 2026-09-26 (Asia/Bangkok), the implementation/integration scope covered by PRs #1, #3, #4, #5, #6, and #7 is complete and landed on `master`.

- Repository: `crystalicez/obsidian-github-sync-multi-platform`
- Active implementation branch: none
- Open pull requests: 0
- Open issues: 0
- PR #4 merge commit: `43f96478007aded2ebde7cef5da81dfc3685c7c1`
- Post-merge closeout handoff commit before final branch cleanup: `76e7500d2bd9a2ca2e3d7db4cdc8145b4bf47127`
- Exact release toolchain: Node `v24.11.0`, pnpm `9.12.3`
- GitHub Actions Stable Release remains intentionally interlocked.
- The supported stable publication authority is the accepted local exact-SHA qualification/release path.

## Final acceptance evidence

Final non-destructive release-grade acceptance is GREEN.

Focused / build:
- `github-e2e-compile-cli`: 4/4 PASS
- `release-metadata`: 9/9 PASS
- `local-qualify`: 9/9 PASS
- `local-release`: 37/37 PASS
- production build: PASS
- feasibility: 138/138 PASS

Full gates:
- fast: 419/419 PASS
- repeat fast: 10/10 complete runs, each 419/419 PASS
- recovery: 43/43 PASS
- resource: 11/11 PASS
- release metadata validation: PASS
- GitHub E2E compile-only: PASS for all 3 bundles
- CI producer input-manifest path: PASS
- package validation: PASS
- final clean-tree/head integrity: PASS

The final full-gate run was performed on accepted code/test head `c6e38c5b5057adedb445a82fb5768435d22cdb73` with Node `v24.11.0` and pnpm `9.12.3`. Later commits touching only this handoff document do not invalidate that code/test evidence.

## Landed work

### Publication race / conflict recovery

Key correctness properties now landed:
- publication-race retry is structured/evidence-based; stale-message regex classification is not used;
- conflict-copy reservation identity may survive a publication replan, but stale staged bytes do not;
- recovery generation ordering is authoritative before payload-key resolution;
- stale `replan-required` state terminalizes only after a successful fresh session and local index save;
- cancellation wins over transport/mutation errors when the operation signal is aborted;
- empty-repository/custom-branch bootstrap races replan the whole operation;
- encrypted speculative bootstrap retries derive the winner KDF before reading winner state;
- runtime publication mutation races are covered by production reconciliation tests;
- debug/error sanitization preserves an allowlisted cause chain while redacting sensitive values.

### Immutable Git read fallback

Key properties now landed:
- immutable commit-SHA Contents 404 fallback is path-directed;
- tree reads are non-recursive and descend only the exact path;
- positive exact entries may be used from truncated trees;
- absence is inferred only from complete (`truncated === false`) evidence;
- malformed/duplicate/unsupported evidence fails closed;
- executable blobs are supported;
- tree/gitlink final nodes mean file absence;
- managed symlinks are rejected;
- thrown and returned 404 forms are covered;
- no broad tree cache is retained.

### Local qualification / release and live-E2E safety

Key properties now landed:
- exact-SHA annotated qualification receipts;
- create-only stable ref ownership;
- explicit draft -> exact asset verification -> publish -> post-verify release state machine;
- deterministic dependency-free ZIP32 stored packaging;
- exact toolchain/version binding;
- canonical fetch/push origin checks;
- target repository identity pinned by numeric repository ID;
- target ID must differ from canonical/current source repository IDs;
- destructive target default branch is rejected;
- required local E2E config validates before source-repository network lookup;
- source/publication credentials are stripped from live-E2E child process boundaries;
- cleanup re-proves target identity before destructive branch operations;
- local release filesystem paths/assets reject unsafe symlink/non-regular-file states;
- ZIP entry traversal shapes are rejected;
- qualification temp refs are collision-safe and compare-deleted only when invocation-owned.

## Exact Node toolchain decision

The repository's official exact runtime was intentionally migrated from Node `v22.11.0` to Node `v24.11.0`.

- `.node-version` is the authority.
- qualification/release logic remains exact-version fail-closed;
- release/feasibility/V4 metadata tests were migrated to Node 24;
- CI/release workflows consume `.node-version` or the exact CI-produced version;
- `@types/node` was intentionally not changed during the runtime-only migration to avoid unrelated type/lockfile churn;
- final build and test evidence above proves the accepted runtime/type combination.

The earlier Windows/libuv failure under Node 24 exposed a real preflight-ordering defect: `scripts/run-github-e2e.mjs` attempted source-repository network lookup before rejecting missing required local E2E config. Commit `572a69f40a84e125375cbd9f23de9b11649a1896` fixed the ordering. The focused regression then passed on Node 24.

## Remote branch cleanup

Cleanup completed successfully on 2026-09-26.

The following already-landed/obsolete remote branches were deleted:
- `agent/harden-v4-change-causality`
- `audit-hardening-2026-08-24`
- `child-c-publication-race-conflict-recovery`
- `child-d-immutable-git-read-fallback`
- `encrypted-sync`
- `feature/local-release-qualification`
- `fix/live-github-immutable-read-fallback`
- `fix/v4-rescan-causality`
- `impl/2026-08-30-live-github-e2e-safety`
- `test/real-github-e2e-superuser`

Current remote branches are exactly:
- `master`
- `agent/conflict-audit-red`
- `agent/conflict-copy-guard-red`
- `agent/conflict-history-ui`
- `agent/conflict-prefetch-red`
- `agent/task8-audit-transport`
- `design/2026-08-30-hardening-followup`

The six non-master branches above are intentionally retained historical prototype/design/agent branches. They contain unique old work and have no merged PR proving their current tips were integrated. They are not active backlog and should not be auto-deleted without an explicit future decision.

The previously noted `tmp-ignore` branch is also absent.

## Important invariants

- Never reintroduce regex/message-based stale-ref race classification where structured publication evidence exists.
- Publication reconciliation fails closed on incomplete ancestry/evidence.
- Do not treat staged conflict-copy bytes as authoritative across a changed remote snapshot.
- WAL recovery/discard remains the physical recovery-stage cleanup authority.
- Do not terminalize recovery state before local index persistence succeeds.
- Cancellation is canonical when the operation signal is aborted.
- Bootstrap races cause whole-operation replan.
- Recovery generation ordering precedes payload-key resolution.
- Immutable Git fallback never infers absence from truncated/incomplete tree evidence.
- Do not add a broad immutable tree cache without measured need.
- Destructive live-E2E operations must remain bound to explicit target numeric identity and safety checks.
- Release/qualification remains exact-toolchain and fail-closed.

## Relevant design / plan docs

- `docs/superpowers/specs/2026-08-30-publication-race-and-conflict-recovery-design.md`
- `docs/superpowers/plans/2026-09-05-publication-race-and-conflict-recovery.md`
- `docs/superpowers/specs/2026-08-30-immutable-git-read-fallback-design.md`
- `docs/superpowers/plans/2026-09-06-immutable-git-read-fallback.md`
- `docs/superpowers/specs/2026-08-30-live-github-e2e-safety-design.md`
- `docs/superpowers/plans/2026-08-30-live-github-e2e-safety-execution-ready.md`
- `docs/superpowers/specs/2026-08-27-local-qualification-and-release-design.md`
- `docs/superpowers/plans/2026-08-27-local-qualification-and-release-v2.md`

## Next action for a resumed session

There is no active implementation PR, issue, acceptance gate, or required branch cleanup remaining for the landed scope.

For future work:
1. Start from current `master`.
2. Create a new branch for new product/feature/correctness work.
3. Preserve the invariants above.
4. Obtain fresh acceptance evidence appropriate to the new change.
5. Do not run destructive live GitHub E2E or `release:local` merely to reconfirm historical acceptance.
6. Update this handoff whenever code/tests/design/branch/verification state materially changes.

## Last updated

- 2026-09-26 (Asia/Bangkok)
- Reason: verify successful deletion of all safe cleanup branches and normalize the durable handoff to the final repository state.
