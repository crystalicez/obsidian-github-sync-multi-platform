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

29. **HIGH remote-change detection — commit-message-only plugin classification could hide forged external content changes.**
   - When the branch SHA changed, sync previously treated the tip as a plugin publication solely when its first commit-message line equaled `obsidian-sync-v4:<current journalId>`.
   - An external commit could change plaintext user bytes, leave V4 head/shards unchanged, reuse the previous plugin message, and cause planning to see unchanged metadata and return no-op; the local index could then advance to the forged SHA without reconciling those changed bytes.
   - In encrypted mode, the same marker-only classification could hide an external object/tree mutation that should instead trigger the encrypted external-change fail-closed path.
   - RED: `556cb4c6f70bb2c70935857ce09c85a7e7ee95f0` covers plaintext reconciliation and encrypted rejection.
   - Fix: `4d1815e47d8a168753232d0d89cbe891126517f7` treats the message only as one signal. It also loads/decodes the immediate parent's V4 head and requires a valid publication transition: same mode, generation exactly parent+1, and a new journal ID. Otherwise the tip is reconciled/rejected as external.
   - Plaintext repositories intentionally cannot cryptographically authenticate a publisher: a repository writer can construct a fully protocol-valid plaintext publication. This fix prevents accidental/message-only masquerade; it does not claim publisher authentication where the protocol has no secret.

30. **HIGH protocol integrity — remote records could carry local-only cache flags.**
   - `V4IndexFileRecord.dirty` and `deleted` are local-cache semantics; the writer does not publish them.
   - Remote decode previously accepted them. In particular, `deleted:true` is filtered by `logical()`, so a forged remote record could be interpreted as an authoritative deletion even though the record still exists in the shard.
   - RED: `2ec65f85757b4ffca38983c216a36b986d652ef6`.
   - Fixes: `41a1e01d1fc91566673a5d96b229cc7e055189ae`, `be0af3b9e6f7df0dc2a4842acb2bb30983a1d8f0` exclude both local-only fields from canonical cache hashing and reject them at the remote record boundary.

31. **MEDIUM resource safety — packed-entry decoding allocated base64 payloads before binding them to the record size.**
   - Pack records carry an exact plaintext `size`, and the writer emits deterministic base64 length for each entry.
   - Reader previously called `fromBase64(encoded)` before checking encoded/decoded size, so a validly encrypted/corrupt archive could force entry allocation beyond the record contract before the hash mismatch was detected.
   - RED: `afe682d6282009ac50a9cbbc5191f08d6dca7132`.
   - Fix: `b4a3a1e2b883f4f45b3f162a9f4d992ac39371ee` validates encoded length from `record.size` before decode and decoded length afterward.

32. **MEDIUM availability safety — explicit GitHub rate-limit headers could bypass the configured maximum cooldown.**
   - `maxSecondaryCooldownMs` capped only the exponential fallback path.
   - A large `Retry-After` or far-future `X-RateLimit-Reset` could therefore suspend all shared request scheduling far longer than the declared policy maximum.
   - RED: `7eeef1371644cb592d0416137d1d17b3f8f4dde3`.
   - Fix: `bec76c2aa77ee3f42cc56dd6e6aa06300e647108` caps both explicit header-derived delays at `maxSecondaryCooldownMs`.

33. **HIGH settings consistency — failed settings persistence could publish a new runtime target/credential generation anyway.**
   - The first atomic-generation fix quiesced old work correctly, but then assigned `this.settings = nextSettings` before SecretStorage and `saveData()` completed.
   - A SecretStorage/persistence failure could therefore leave UI reporting “not saved” while the in-memory runtime/client had already switched; reusing the same secret IDs also meant a failed metadata save could overwrite credentials referenced by the old persisted settings.
   - RED: `b1ecad5cea161c01e9776b4a38c0a6d8cab8a951`.
   - Fix: `b9ebf4f33956d6535d625cffeb1b19eaac915689` allocates new secret IDs on credential rotation, stores/persists the prepared generation first, and only then publishes `this.settings`, invalidates the runtime credential generation, and rebuilds the GitHub client. A failed durable save may leave only unreferenced orphan secrets, not a hidden runtime/persisted target switch.
   - Test-contract cleanup: `362211c4c15f8729895a12068b1a8019357c6d56` updates source-order assertions to the transactional generation and repairs two malformed regex literals that would otherwise create false test failures.

34. **MEDIUM hardening-regression — strict remote-record validation initially rejected valid local cache records.**
   - Local index entries intentionally carry local-only fields such as `dirty:false`.
   - After remote wire hardening began rejecting `dirty/deleted`, unchanged-shard cache reuse still passed local cached records through the wire validator unchanged.
   - That would turn a valid post-sync cache hit into a failure even though the shard content hash was correct.
   - Closure discovery also found a stale `remoteV4StateFromLocalIndex` import left after the unauthenticated bypass helper was removed.
   - Fixes: `20b8a08f8e425581a0250b3c981325a56627728e`, `35bcb0b1a51a31d1275bf897502974f32fdb3429`, `5ee7e5aa19404e19feecac936f37187f9b8d3014`.
   - Local cached records are now projected into canonical remote shape (strip `dirty/deleted`) before remote validation/reconstruction, while GitHub-loaded records still reject those fields.

35. **MEDIUM resource/fail-closed boundary — Git tree blob entries without byte size could bypass History preview size checks.**
   - `getTreeAt()` allowed blob entries with `size === undefined`.
   - External history converted missing size to `0`, so the 5 MiB preview guard could pass before fetching an unexpectedly large blob into memory.
   - Current GitHub REST tree responses include byte size for blob entries; missing size is therefore malformed evidence at this boundary.
   - RED: `98fe2b8f636ceb5314ff3dab60d64cd90d85f71f`.
   - Fix: `5d9ad89d4717f3f3b81ed44d1d582edb8a76163c` requires a non-negative safe integer size on every `type:"blob"` tree entry before history/immutable-read consumers receive it.

36. **HIGH fail-closed reconciliation — immutable external tree evidence could be silently weakened when a listed blob read returned missing.**
   - External plaintext reconciliation first obtains a complete immutable Git tree and then reads each included blob at that exact commit.
   - The old path used `if (!file) continue`, so a tree-listed blob whose immutable read unexpectedly returned `null` was omitted from reconstructed remote state instead of treated as contradictory/incomplete evidence.
   - That could feed planning an artificial deletion/absence and allow later index/local mutation work to proceed from an incomplete external snapshot.
   - RED: `0ec71b2f5a6d1420728f60094bedf35b1380cb41`.
   - Fix: `52070098483524b029cca836d9e709060b88c38b` fails closed whenever immutable tree evidence says a scoped blob exists but its exact-commit file read is missing; the regression also asserts no local trash/delete and no index mutation occur.

37. **HIGH destructive-action safety — Force Push/Pull confirmation was not bound to the settings generation the user reviewed.**
   - The modal rendered repository, branch, and scoped local-file count from the settings/client generation current when it opened.
   - Confirmation later called `v4Runtime.forcePush()/forcePull()` without proving that settings were unchanged while the modal remained open.
   - A concurrent settings save could therefore make the user approve target A while the destructive operation executed against target B.
   - RED: `aef9f1149b60bfd16eaffbbbf7afa23f741e6aed`.
   - Fix: `dc4161bad4668d0686d019db11d07b87f273017f` captures `settingsGeneration` when the modal opens and refuses the destructive action if the generation changes, requiring the user to reopen/review the confirmation.

38. **MEDIUM lifecycle/cancellation safety — runtime decision modals were not abort-aware.**
   - Conflict and modification-threshold modals returned promises that stayed pending until user interaction.
   - Settings rotation calls `quiesceForSettingsChange()`, which aborts the active sync and waits for the coordinator to become idle. If an active run was awaiting either modal, the settings save could remain blocked until the stale modal was manually closed.
   - The first abort-aware modal fix also needed post-await canonical cancellation checks; otherwise an abort resolved to `ask`/false and could be reported as a generic sync failure.
   - RED: `25e473ae7d40f8ba740abc35ce5468215b83bbb8`, `95a0635e9a07702fcceb5d1da246935808b73b51`.
   - Fixes: `aa0f556aa1b9dfecfc82e2d0426a3939397892c5`, `cf88125803e3ce1c13199c82075235ef35c6036b`, `a8f4d79da344ba610ac83b4df2c20be4bfa571b0`.
   - Both decision modals now settle immediately on AbortSignal, remove listeners on every settle path, and callers re-check cancellation immediately after awaiting so settings change/unload remains canonical `V4CancelledError`.

39. **HIGH multi-platform path safety — logical paths were not restricted to a portable filesystem subset.**
   - Git and Unix-like vaults can contain names that Win32 cannot safely represent or aliases specially, including device names such as `CON.md`, trailing dot/space, control characters, and `<>:"|?*`.
   - Existing path normalization handled slash/dot-segments and sync separately detected NFC/case collisions, but did not reject these cross-platform-invalid path segments before remote/local mutation planning.
   - RED: `bcab23adc56f7edc8d5088159f519e4bff7ecf9c`.
   - Fix: `4b6282a559841d800a057caecf6ef096e95feca5` makes `normalizeV4VaultPath` enforce a portable logical-path subset: reject Windows device names, control/forbidden characters, trailing dot/space, and >255 UTF-8 byte path components.

40. **HIGH privacy/local-mutation safety — desktop filesystem IO could traverse vault symlink/junction ancestors outside the vault.**
   - Obsidian desktop supports symlinks/junctions that may target locations outside the vault. The previous bounded/staging IO resolved a lexical vault path with `getFullPath()` then used Node `fs.stat/read/open/mkdir/rename/rm`, which follows parent links.
   - A vault link to an external directory could therefore make local-source reads upload bytes outside the vault, or make staged pull/rollback/commit paths mutate files outside the vault.
   - External reference confirmation: Obsidian documentation explicitly warns that symlinks/junctions may point outside the vault and can cause sync/data-loss issues; FileSystemAdapter exposes `getBasePath()` and `getFullPath()` on desktop.
   - RED: `1f1052c4110f459f79dcae51e18183ea8418b90c` covers an external directory link used by bounded source read and a staged commit target beneath that link.
   - Fixes: `d6ddd9836e60b7ee7437656374decc30cbd93f3d`, `d25b9c0a9ccc92b051776da5ab4e41113f3939eb`, `d0e46ea1d8e4cd9bb75cd760a47fc8e1aea13ca1`, `10ad6688ca89061024095969247caed38ef98aef`, `4cb9a969ab8be2ebcbdc6beb85b88c020e444b58`, `7697ad51d8a32d1d4599c1bcfd4d6a7c2786a7ba`, `3ef3575af8ecc5eeb98f387efd76e003fc2dfe87`, `fb950b961bfa1fb43980dca5bc633374797151f7`.
   - Desktop IO now requires both FileSystemAdapter full-path and base-root proof, checks lexical containment, resolves the real vault root, rejects symlink/junction or outside-root existing descendants, and applies the guard to small vault reads/writes/trash plus bounded/staging/recovery IO. Desktop stage/recovery operations capability-fail rather than falling back to unproven adapter IO when root proof is unavailable.
   - The vault root itself may resolve through a symlink; links **inside** the vault tree are rejected for synced IO.
   - Residual TOCTOU: a local adversary/OS process can theoretically replace an already-verified directory entry between the guard and the following Node filesystem call. Fully eliminating that narrow race would require handle-relative/openat-style APIs not exposed by the current Obsidian/Node integration; do not claim stronger guarantees.

41. **HIGH settings-generation safety — new sync/history work could start during asynchronous settings persistence after the old generation had been quiesced.**
   - `saveSettings()` previously called `quiesceForSettingsChange()` and then awaited SecretStorage/plugin-data persistence before publishing the new settings/client generation.
   - During that persistence window the runtime was idle but not gated: watcher, manual, scheduled/startup, force, or history work could start again on the old generation. The save could then publish a new settings/client generation while that newly-started work was active, recreating the cross-target race fixed earlier.
   - Pending startup timeout callbacks were also not bound to the settings generation that scheduled them; an old startup timer could fire after a settings switch.
   - RED: `6a75dc8f4e8ca039709b08b75a1f9984c26efe7c`.
   - Fixes: `4b43edbe23a018c63dede004028d2a333d6d0275`, `2a31aff2789edfa55890f4483cce51cc26c201cb`.
   - Runtime now enters a settings-transition gate before cancelling/awaiting active work, blocks new manual/startup/scheduled/force/history work while the transition is active, cancels pending coordinator work, records in-scope local events for a post-transition rescan, and releases the gate in `finally` whether durable persistence succeeds or fails.
   - Startup and scheduled callbacks capture the settings generation that created the timer and no-op if that generation is stale.

42. **MEDIUM/HIGH credential/request-boundary safety — GitHub owner/repository settings could alter REST paths before repository identity checks.**
   - `GitHubClient.baseUrl` interpolates owner/repository into `https://api.github.com/repos/<owner>/<repo>`.
   - Branch/path/query components are encoded elsewhere, but owner/repository were free-form settings strings.
   - Malformed persisted or clipboard-derived values containing slash/query/percent/dot-segment syntax could therefore change the PAT-bearing REST path inside GitHub's API before normal V4 repository-identity validation ran.
   - RED: `c95c5ee000ed22d3097790785e35f6cd6e82545f`, `30d96a8c2098be66d85a931d1419fe0dfd1026ac`.
   - Fixes: `e06085a02108b534b3d1a88bac84e68828086b77`, `70d9359b97c051d539bdb81f05fdfdf252a75de1`, `0a897eed3b17f71bdb47bf5907adb6c9f2d21e80`.
   - A pure shared validator now restricts configured GitHub.com owner/repository coordinates to safe path-segment syntax; settings may still keep both fields empty while unconfigured, while direct `GitHubClient` construction requires valid non-empty coordinates.

43. **HIGH publication integrity — successful Git ref responses were not bound to the configured branch/target SHA.**
   - `getGitRef()` validated object SHA/type but accepted any non-empty `ref` string.
   - `updateGitRef()` and `createGitRef()` treated HTTP 200/201 as success without validating the returned ref name/object type/object SHA.
   - `publishV4CandidateRef()` returns immediately on a successful mutation call; reconciliation runs only when the mutation throws. Therefore a malformed/wrong 2xx response could make publication appear successful without proving the configured branch points to the requested candidate.
   - RED: `9422102bdc64c019890529852400b148f569f24c`.
   - Fix: `ef657ebc2ddeeec003e403279881127abefa71d8` centralizes configured-ref parsing and requires exact `refs/heads/<configured branch>`, `type:"commit"`, and exact requested mutation SHA for successful ref creation/update/read.
   - Fixture normalization: `8a9d29ab44713f5ee72733317a8f7c7b34ede63e` makes success fixtures reflect the actual GitHub ref response shape.

44. **MEDIUM/HIGH fail-closed Git evidence — recursive tree responses could contain duplicate logical paths and callers would silently choose/duplicate authority.**
   - `getTreeAt()` validated individual entries but did not reject duplicate `path` values in one tree response.
   - External reconciliation iterates every blob and could synthesize multiple records for one logical path; history converts tree entries to `Map(path -> node)` and would silently let a later duplicate replace the earlier one.
   - Immutable path-directed fallback already rejects duplicate exact entries, so accepting duplicates in the recursive boundary was inconsistent fail-closed behavior.
   - RED: `d6f4348979a876ae6c4aa83700b96028a719e124`.
   - Fix: `9c11d0a2b26566110d205c22d38b36e46a0359d8` rejects empty and duplicate tree paths before any sync/history consumer receives the response.

45. **MEDIUM/HIGH request-boundary safety — GitHub branch settings were not validated as safe Git refs before REST-path construction.**
   - Owner/repository coordinates already used a shared path-segment validator, but `githubBranch` was accepted as any string.
   - Branch is used both as a Git ref body value and in `/git/ref/heads/<branch>`; dot-segments, empty segments, `.lock`, `@{`, backslash/control/Git-special syntax could reach PAT-bearing REST requests before repository identity checks.
   - RED: `1b03b393a65ab4aa3c2d93763b3bf22de9716b9c`, `f49f664dd6bed74135a6aa3f01e28b4138be5b27`.
   - Fixes: `13eb57c1920abb1d04d0bc937a8f8bdfbb456efe`, `183b9d89ef52c14da102fc2a0b87b2b08d00b0c0`, `772f3d024c63b2f5c68d8f08efff06373cd864f1`.
   - Shared branch validation now rejects Git-invalid/dangerous ref syntax while preserving ordinary slash-separated branches such as `feature/local-release-qualification`; both settings validation and direct `GitHubClient` construction enforce it.
   - Compatibility correction: persisted/settings-layer `githubBranch: ""` historically means “use main” via the existing `githubBranch || "main"` fallback. RED `48e682490739b415cb75fc82a5ba76d576519383`; fixes `4a340753dfa0fb5e1780c3a4ab49ade6f458f536`, `7456e4e1321df1c87c5b0d98829e028066ccf902` allow empty only at the settings-validation layer while direct `GitHubClient` construction still requires a non-empty safe branch.

46. **MEDIUM/HIGH integrity/resource safety — whole-buffer V4 reads did not enforce the record's declared plaintext size.**
   - `V4StorageCodec.read()` verified plaintext hashes for single/chunked content but did not compare the returned plaintext byte length to `record.size`.
   - Conflict/history paths choose whole-buffer behavior partly from metadata size; a forged but internally hash-consistent record could under-report size and feed more bytes into a path the writer never produces.
   - Streaming `readToSink()` already enforced size, so behavior was inconsistent across readers.
   - RED: `90c19b14b2ff8385b392cc89c79023410ae6b49a`.
   - Fix: `b5d4af4091e23cfd2bdf5bbbce30375423db9608` requires actual plaintext length to equal `record.size` for single/chunked whole-buffer reads before returning bytes.
   - Residual transport limitation remains unchanged: Obsidian `requestUrl` can buffer an unexpectedly large HTTP body before this post-receipt validation runs.

47. **HIGH remote integrity — local-only cache flags were accepted on remote wire records and excluded from canonical shard hashing.**
   - Canonical shard hashing intentionally strips `dirty` / `deleted` because those fields are local-index cache state.
   - Fresh remote shard decoding nevertheless accepted those fields.
   - An external/corrupt commit could therefore add `deleted:true` to a remote record without changing the canonical record hash advertised by head metadata; planner logic filters deleted records and could treat a still-present remote object as logically deleted.
   - RED: `c0cb45d6c73bebe22a75ecd501a1d218a7dcf37e`.
   - Fix: `54b5d26c71286362add3aad8ab948ec152bfdf81` rejects any wire record carrying local-only `dirty` or `deleted` properties before remote shard records become authority.
   - Local persisted shards may still contain those fields; they are separately content-verified and protocol-validated before cache reuse.

48. **MEDIUM remote resource safety — aggregate pack groups were not constrained to writer limits.**
   - Per-record pack validation enforced <=1 MiB entries, but `assertV4RemoteRecordSet()` did not limit how many records could share one `packId` or their aggregate plaintext size.
   - The production writer caps a pack at 500 files and 32 MiB plaintext; accepting larger groups admitted remote states the writer cannot create and amplified repeated pack reads.
   - RED: `2f1a268e26f2a08e4c8b388cc203b67925fd2e45`.
   - Fix: `73dc49446e026de826000299201eddb9a6ff9a80` enforces `PACK_MAX_FILES` and `PACK_MAX_PLAINTEXT_BYTES` per remote pack group using the same writer constants.

49. **MEDIUM/HIGH remote resource safety — Force Pull decoded the same immutable pack once per member instead of once per pack generation.**
   - Packed records share one immutable encrypted pack object, but pull staging could call the single-record pack reader for every member.
   - A 500-file writer-valid pack therefore caused repeated download/decrypt/JSON/base64/hash work for identical bytes during one pull generation.
   - RED: `91d580b57093154a1a24eb9a63f78b00c92ba282`.
   - Fixes: `ec863a0d33ac4d8930a189b872442ed98a64a870`, `33349f1cad95c1f04e745b97fc4ce59dd8ef10f2`.
   - The codec now verifies/decrypts one declared pack group in a batch, and pull staging groups records by immutable commit + pack ID + remote path so a shared pack is fetched/decrypted once per pull generation.

50. **MEDIUM integrity/resource safety — pack payload bytes were not exactly bound to the declared record set before decrypt/JSON parse.**
   - Aggregate remote pack metadata was bounded, but the encrypted object itself could still contain extra/oversized archive entries not declared by the records being read.
   - The previous reader decrypted and parsed the whole archive before discovering missing/mismatched requested entries, allowing avoidable post-transport CPU/memory amplification and hidden undeclared archive content.
   - RED: `cfe0e5fabcb0545220da81ce6d18002a78a4a486` with compile-shaped fixture correction `386ad5286f21b9475b15371ee9e2940fcd07482a`.
   - Fixes: `9d78ea957fc66c9ed44846e1d7960577d7234f86`, `007bbb48612cb69f13d2bfed04eeebf5e330270f`.
   - Reader now derives the exact deterministic archive size from declared `fileId` + plaintext sizes, checks encrypted payload length before decrypt, re-checks plaintext archive length after decrypt, and requires the archive key set to equal the declared record IDs exactly.
   - This does **not** remove the previously documented transport peak-memory residual: Obsidian `requestUrl` can still buffer an unexpectedly large HTTP body before post-receipt validation runs.

51. **LOW/MEDIUM reliability — scheduled sync timer could be enabled before GitHub configuration was complete.**
   - `shouldRunScheduledSync()` checked only `syncEnabled + scheduledSyncEnabled`, unlike startup sync which also required token/owner/repo.
   - Main then installed a repeating timer whose callback invoked `runtime.scheduledSync()` without a local catch; runtime throws when `githubClient` is absent.
   - A partially configured installation could therefore produce repeated rejected scheduled sync attempts every interval.
   - RED: `d36678c39c1570821a073c086c56d4c147bc29eb`.
   - Fix: `8b5d2ff83e7d4528b7f606ce6a9b1b97de9c2647` makes scheduled sync require the same complete GitHub configuration predicate before a timer is created.

52. **HIGH integrity — a matching remote commit SHA did not prove the local cached shard manifest matched the authenticated current head.**
   - A local index could remain internally self-consistent and retain the same `remoteCommitSha` while its epoch/generation/shard-hash manifest disagreed with the current remote head.
   - The remote loader correctly fetched authoritative remote records, but planner base selection previously treated cache completeness + a remembered commit SHA as sufficient known-base authority.
   - That could let stale/tampered cached records influence causal planning even though the current remote head had already disproved the cache manifest.
   - Fix: `82efe37c23094d20aeb348a2f93be7b1ede50a38` requires mode/epoch/generation and the complete shard-hash manifest to match the authenticated current head before cached records can be used as the known base.
   - Regression coverage: `v4 plaintext matching-SHA sync rejects a self-consistent local cache that disagrees with the remote head`.

53. **HIGH correctness/reliability — a large keep-both conflict copy could consume its stage before the corresponding push read it.**
   - In the no-recovery execution path, committing a large staged pull moves/removes the stage file as it becomes the final vault target.
   - The paired push for an in-scope conflict copy could still retain a stage-backed source handle, so later upload preparation attempted to read a stage that had already been consumed.
   - Fix: `82efe37c23094d20aeb348a2f93be7b1ede50a38` tracks consumed pull stages and rewrites any paired push source to the committed vault file with the same hash/size/mtime snapshot.
   - The large keep-both regression now uses a writer-shaped chunked remote object and verifies the committed copy without whole-buffer reassembly.

54. **MEDIUM/HIGH audit-branch correctness regression — exact pack validation initially rejected writer-valid multi-entry packs in single-member consumers.**
   - The new exact pack payload/entry binding in `007bbb48612cb69f13d2bfed04eeebf5e330270f` is correct only when the reader receives the complete metadata group for that immutable pack.
   - Sync conflict/pull paths and history preview still had call sites that supplied only one packed record; after rebasing the audit branch, writer-valid multi-member packs therefore failed with `V4 pack payload size does not match its declared records.`.
   - Fix: `932515b` threads complete pack metadata through pull/conflict bindings, makes historical pack preview load and validate the historical V4 state before decoding, and falls back from unknown-base three-way merge when an older packed base cannot be proven complete.
   - The strict payload-size and exact archive-entry-set checks remain intact; this repair does not weaken finding 50.
   - This regression was caught on the audit branch before merge/release.

55. **MEDIUM remote resource safety — file-history traversal had no aggregate journal page-read budget.**
   - Per-commit journal validation capped one journal at 256 pages, but `getFileVersions()` can scan up to 20 commit-list pages × 50 commits.
   - A history made entirely of valid plugin markers with writer-limit journals could therefore drive roughly 256,000 journal-object reads for one file-history request even though every individual commit was protocol-shaped.
   - RED: `ee6640d6fe02f9e493158f3c60e30e026fbd6948` proves aggregate fanout was unbounded across otherwise valid commits.
   - Fix: `45123da` gives one `getFileVersions()` traversal a shared 1,024-page journal-read budget and decrements it before each remote page fetch. Single-commit history inspection retains the existing per-journal 256-page contract.

56. **LOW/MEDIUM reliability — scheduled sync intervals could exceed the signed 32-bit timer delay range.**
   - Runtime settings accepted any positive finite `scheduledSyncIntervalSeconds`; normalization enforced the 30-second minimum but no upper timer bound.
   - Extremely large but otherwise valid values were multiplied by 1,000 and passed to `setInterval`, where timer implementations can overflow/clamp an out-of-range delay into unexpectedly frequent execution.
   - RED: `ee6640d6fe02f9e493158f3c60e30e026fbd6948` shows `Number.MAX_VALUE` survived normalization unchanged.
   - Fix: `45123da` clamps normalized intervals to `Math.floor(0x7fffffff / 1000)` = 2,147,483 seconds while preserving the existing default and 30-second minimum.

57. **MEDIUM reliability/resource safety — large local-event bursts could overflow JavaScript argument limits during debounce coalescing.**
   - `coalesceV4Changes()` used `Math.max(...changes.map(...))` for rescan mtimes and ambiguous rename fallbacks.
   - A 150,000-event burst reproduced `RangeError: Maximum call stack size exceeded` on the repository's Node 24 toolchain before sync execution began.
   - Vault watchers can accumulate very large event bursts during mass operations, so sync reliability must not depend on the engine's function-argument count limit.
   - RED: `8aac1d5bc0b7598dafd25e4302be4035e960ff08`.
   - Fix: `e1173260c083c2be55c4317ed1fec119b90a488f` replaces spread-based maxima with one O(n), O(1)-extra-space scan in every coordinator rescan-mtime path.

58. **MEDIUM remote protocol/history safety — journal change objects were exposed before writer-shape/path/descriptor validation.**
   - The history reader bounded page count and changes-per-page but accepted arbitrary individual change objects from remote journal JSON.
   - Invalid change kinds, unsafe/non-canonical paths, and impossible create/delete/modify/rename shapes could escape `getCommitChanges()` into Sync Center/history consumers before preview-time descriptor validation.
   - RED: `8aac1d5bc0b7598dafd25e4302be4035e960ff08`.
   - Fix: `e1173260c083c2be55c4317ed1fec119b90a488f` validates every decoded journal change at the read boundary: kind, portable paths, writer-shape semantics, and before/after descriptors through the existing V4 remote-record contract. Rename-before descriptors are validated against `previousPath` rather than the new path.
   - One older test fixture represented `modify` with only `after`; the initial V4 writer history was checked and the fixture was corrected to the writer-valid before+after shape instead of weakening production validation.

59. **HIGH immutable Git integrity — successful commit/tree reads were not bound to the requested object IDs.**
   - `GitHubClient.getGitCommit(requestedSha)` and `getTreeAt(requestedTreeSha)` validated that returned SHAs were syntactically valid Git object IDs, but did not require them to equal the immutable IDs named in the request URL.
   - A mismatched 200 response could therefore substitute a different valid commit or tree into publication reconciliation, external-commit reconciliation, Force Push tree evidence, immutable fallback, or history preview logic.
   - This was inconsistent with raw Git Blob reads, which already authenticate returned bytes against the requested object SHA.
   - RED: `1c5ca913938a2df2b8c9a034e21669197531d62f`.
   - Fix: `8d56b55c130062934ed3850b43dfcb62b462bb69` validates requested commit/tree IDs before issuing the request and rejects any successful response whose object SHA does not exactly match the requested immutable ID.

60. **HIGH immutable Git mutation integrity — successful blob creation was not bound to the uploaded bytes.**
   - `createGitBlob()` accepted any syntactically valid SHA returned by a 201 response and handed that SHA to tree construction.
   - A mismatched success response could therefore make a candidate tree reference different blob bytes from the content that the client actually uploaded.
   - RED: `e4c68da4e8f37af14ac1add9a715db201b5f30e0`.
   - Fix: `7cc635aa3ee71bdbe36ddce8a6d7b5017c895f27` computes the deterministic Git blob SHA from the uploaded bytes before the base64/HTTP transient reservation and rejects any successful mutation response whose SHA differs. Existing transport fixtures were updated to use the real Git object IDs of their uploaded bodies.

61. **HIGH publication integrity — successful commit creation was not semantically bound to the requested message/tree/parents.**
   - `createGitCommit()` previously accepted any valid-looking SHA from a 201 response; candidate publication could then update the branch ref to that unrelated commit.
   - RED: `1192a6c12c3900f87290f38a3702e8c4876d2b64` returns a valid created SHA whose immutable commit has a different message and proves the mismatch was accepted.
   - Fix: `ddec918b51d3dc4e0129449b0682487cce1fb126` validates requested tree/parent object IDs, reads the returned immutable commit back by SHA, and requires exact message, tree, and ordered parent-list equality before the SHA can become a publication candidate.

62. **HIGH bootstrap integrity/race safety — a successful empty-repository Contents bootstrap could silently adopt a competitor base.**
   - The empty-repository preflight and Contents PUT are separate operations. If another initializer created the default branch after the preflight but before our PUT, GitHub could accept our PUT as a child commit on that newly created branch.
   - The previous success path trusted the returned commit SHA and could then accept/create the configured ref at that child commit, thereby inheriting competitor state despite the operation having been planned as an empty-repository bootstrap.
   - RED: `e042790b06fbce6621054a4ab67b3edbdcb6a855` models a successful bootstrap response whose immutable commit already has a competitor parent.
   - Fix: `a4f9d5ba5ecd26140cb3a237251aa96939783276` reads the successful bootstrap commit immutably before any configured-ref adoption, requires it to be a root commit with the exact bootstrap message, and surfaces a typed `V4RepositoryBootstrapRaceError` carrying the observed parent SHA when a competitor base is present.

63. **HIGH bootstrap mutation integrity — root/message checks still did not bind the successful bootstrap commit to the exact marker bytes requested.**
   - After finding 62, a returned bootstrap commit had to be a root commit with the exact bootstrap message, but a different root commit carrying that same message could still be accepted if its `.obsidian-github-sync-v4/bootstrap` bytes differed from the Contents PUT body.
   - That left another substitution gap in the successful empty-repository bootstrap path before configured-ref adoption.
   - RED: `26af58a088acca4f39568a645c1e0e00225a7a26` returns a root commit with the exact bootstrap message but different marker bytes and proves the success path previously accepted it.
   - Fix: `ff4386adeb24f983316872ae99394464b17efad3` reuses the exact bootstrap bytes sent to Contents PUT, reads the marker back immutably at the returned commit SHA, and requires byte-for-byte equality before accepting or creating the configured ref.

64. **HIGH bootstrap ref-adoption integrity — a configured branch appearing after verified bootstrap could be accepted at a competitor SHA.**
   - After the root bootstrap commit and marker were verified, `ensureConfiguredBootstrapRef()` returned any already-existing configured branch without requiring it to point at the verified bootstrap commit.
   - A competing actor could therefore create the configured branch between bootstrap verification and configured-ref adoption and cause the caller to continue from unrelated state.
   - RED: `103bae04cdebc751d8dd5b367b6e774141291ad8`.
   - Fix: `68803e2f8ef1754c5c16dd93cce524f0dae84551` centralizes configured-bootstrap-ref validation and raises a typed `V4RepositoryBootstrapRaceError` unless the observed branch points exactly at the verified bootstrap SHA.

65. **HIGH bootstrap ref-race safety — a configured branch could move away immediately after successful ref creation.**
   - The successful `createGitRef()` path re-read the configured branch and returned it without binding that re-read to the bootstrap SHA.
   - A competitor advance between ref creation and the follow-up read could therefore make bootstrap appear successful at a different commit even though the create response itself was correct.
   - RED: `d5cdcd2ecd0424bfc6bff2be0f665a0d8ee79e19`.
   - Fix: `68803e2f8ef1754c5c16dd93cce524f0dae84551` applies the same exact-SHA bootstrap-ref assertion to the pre-existing, post-create, and ambiguous-create reconciliation paths.

66. **LOW/MEDIUM qualification reliability — the fast-tier planner benchmark used wall-clock time under concurrent test load.**
   - The 100,000-file planner regression asserted `Date.now() - started < 5_000` while Node's test runner executes fast-tier files concurrently.
   - On the current branch this reproduced a false full-suite failure: functional assertions passed, but the planner test observed ~8.4 s under CPU contention; an immediate isolated rerun passed all 3 benchmark tests with the planner at ~1.13 s.
   - Fix: `0762038ae20673674fceb71376906dd21d1443c4` keeps the same 5-second compute budget but measures the benchmark process's own CPU time via `process.cpuUsage()`, excluding scheduler wait caused by unrelated concurrent test files. A subsequent full fast run passed 503/503 before the next regression was added.

67. **HIGH bootstrap tree integrity — exact bootstrap marker bytes did not prove the root commit contained only the requested bootstrap tree.**
   - After finding 63, a substituted root commit with the exact message and exact marker bytes could still contain additional root or bootstrap-directory entries and be accepted before configured-ref adoption.
   - RED: `2d3812e6b5010c8296242ac3b5df8c9b2f86394b` supplies the exact marker plus an extra root `extra.txt` and proves the success path previously accepted it.
   - Fix: `593657cb7a73b06630a0610f38ba281ea2eaa883` authenticates the bootstrap commit's non-recursive Merkle shape: the root must contain exactly the `.obsidian-github-sync-v4` tree, that tree must contain exactly the `bootstrap` regular blob, and the leaf SHA/size must match the already authenticated marker. This is a bounded two-level proof and does not add a recursive repository scan.

68. **HIGH immutable Contents identity integrity — authenticated blob bytes were not bound to the requested repository path/type.**
   - `getFileBytes(path, ref)` authenticated a successful Contents payload against the response blob SHA, but accepted that authenticated blob even when the successful response described a different repository path.
   - A malformed/substituted Contents 200 could therefore return valid bytes for another file and pass the blob-integrity check; the immutable fallback's path-directed Merkle proof only ran on 404 and did not protect this 200 path.
   - GitHub's Contents file schema includes both `type: "file"` and the requested repository `path`, so this identity can be checked without inventing a new protocol rule.
   - RED: `79a109603463a56559982d0c071df662db95e2be` returns a byte/SHA-authenticated blob for `different.md` while requesting `expected.md` and proves the response was previously accepted.
   - Fix: `d957ad1` requires a successful Contents object to be `type: "file"` and to report the exact requested path before decoding/trusting its payload. SHA validation remains first so malformed-object-ID failures retain their established precedence.
   - Fixture follow-up: `a121304` makes the immutable-fallback success fixture protocol-shaped rather than weakening the new production boundary.

69. **HIGH bootstrap availability/compatibility — configured-ref lookup rejected GitHub's documented empty-repository HTTP 409.**
   - GitHub's Git database REST documentation lists `409 Conflict` for Git reference reads and states that Git database APIs return 409 when a repository is empty or temporarily unavailable; empty repositories must be initialized through the Contents API.
   - `getGitRefOrNull()` converted only 404 into an absent ref. A real empty repository could therefore fail before reaching the already-hardened Contents bootstrap path.
   - RED: `d578693148d77549a7a3aab779a580daf073345b` reproduces a `Git Repository is empty.` 409 from the configured-ref endpoint and proves the helper threw instead of returning `null`.
   - Initial fix: `6d3ba0a899214c9b8d0f842ce3a28be14c3a5796` allowed the documented empty-repository 409 to reach Contents bootstrap.
   - Follow-up RED: `a1362712f9e3c4a0d34d0c44847f62f1733f0394` proves a generic/unavailable 409 must not be interpreted as an empty repository.
   - Final fix: `4959c07acd5ae6007ec66a925050edcd40bfb76f` returns `null` only for 404 or a 409 whose GitHub error explicitly reports that the Git repository is empty; other 409 conflicts propagate fail-closed.

70. **MEDIUM remote resource/fail-late safety — resolved operations could exceed journal capacity only after staging or streamed object uploads had already started.**
   - The journal writer contract is 500 changes/page × 256 pages = 128,000 changes per publication, but `buildV4JournalPages()` was the first place enforcing that limit.
   - For large/chunked or packed pushes, `V4SyncSession` can create immutable Git blobs while building push records before it later constructs journal pages. An operation with more than 128,000 resolved journal changes could therefore fail deterministically after creating orphan remote objects; pull/conflict staging could also be performed unnecessarily before the inevitable writer rejection.
   - RED: `5655f2b3f565bf3b1b8912524b798f76336c2659` requires the journal capacity to be preflightable from a change count without materializing an oversized change array.
   - Fix: `647fbeeaade34008162d4382955afc37a787bf09` centralizes the writer-compatible capacity assertion and checks the exact resolved journal entry count — external-reconciliation pulls plus final resolved pushes — immediately after conflict resolution and before packed-pull staging, final local mutation, or streamed Git blob upload.
   - This remains a per-publication journal bound, not a global vault file-count limit; large vaults remain supported as long as one atomic publication stays inside the existing protocol journal contract.

71. **MEDIUM/HIGH remote resource safety — direct plaintext external reconciliation re-downloaded every unchanged vault blob.**
   - When a plaintext branch contained a direct external Git edit after the locally known V4 publication, `reconcileExternalCommit()` traversed the full current tree and called `getFileBytes()` for every in-scope blob, even when an immutable baseline tree proved that most blob object IDs were unchanged.
   - A one-file manual GitHub edit in a large vault could therefore expand into thousands of Contents/blob reads, consuming rate-limit budget and making sync latency proportional to total vault size instead of the external delta.
   - RED: `909c7442c6b6da3aea6f1d8eda9db87a3d657d29` proves an unchanged plaintext file was fetched during a one-file external edit.
   - Fix: `48d103dc95b2c75feba43deabf40f56c2305804c` compares the current immutable tree with the locally known immutable baseline tree and reuses the authenticated V4 record when the path/blob object ID is unchanged.
   - Reuse is deliberately gated by `localIndexMatchesRemoteHead()`; if the local metadata manifest is stale relative to the authenticated remote head, reconciliation keeps the prior full-read behavior rather than reusing records from the wrong generation. Closing that stale-device amplification path safely requires a bounded proof of which ancestor owns the inherited V4 metadata.
   - The sync-session fixture now models tree child IDs as content-sensitive values so tests preserve the content-addressed Git invariant required by this optimization.

72. **HIGH bootstrap side-effect safety — generic any-ref HTTP 409 could still enter Contents bootstrap and mutate remote state before failing.**
   - Finding 69 hardened the configured-branch lookup, but the broader `inspectAnyGitRef()` preflight still treated every HTTP 409 as proof that the repository was empty.
   - A populated or temporarily unavailable repository returning a generic refs conflict could therefore enter the empty-repository Contents bootstrap loop and issue remote PUT mutations before later root/message/tree verification rejected the result.
   - RED: `0b097d3a4334096d90bea438d09d111bb28109f4` returns `409 Git Repository is temporarily unavailable.` from the any-ref preflight and proves the client attempted the bootstrap Contents PUT twice instead of failing before mutation.
   - Fix: `5d7f4d211d22b73a4383972430ccd6ab4a039c5e` centralizes explicit empty-repository conflict detection for both configured-ref and any-ref reads. Only 404 or an explicit empty marker (`empty` / GitHub's `Git Repository is empty.`) is treated as absent; other 409 conflicts propagate before any bootstrap mutation.
   - Focused bootstrap/ref transport regressions remain green, including legacy fixture shorthand `empty`, while `temporarily unavailable` remains fail-closed.

73. **HIGH bootstrap concurrency correctness — a definitive create-ref conflict at the already-verified bootstrap SHA was not reconciled.**
   - `ensureConfiguredBootstrapRef()` first reads the configured branch, then creates it if absent. Another actor can create that same ref in the race window after the initial 404 and before our POST.
   - The existing code reconciled ambiguous/unknown mutation outcomes but propagated definitive 409/422 create conflicts immediately, even when a read-back proved the configured ref already pointed exactly at the authenticated bootstrap commit.
   - Regression commit: `72529e40a16c1bbe32a02fdeafc936cd4f5050da` covers the definitive already-exists race at the verified SHA.
   - Fix: `5ed8abe` reconciles definitive 409/422 ref-create conflicts by reading the configured ref back and accepting it only through the existing exact-SHA `assertConfiguredBootstrapRef()` proof.
   - A second regression proves a competitor SHA remains a typed `V4RepositoryBootstrapRaceError`; the conflict path therefore becomes idempotent only when the observed ref is exactly the verified bootstrap commit and remains fail-closed otherwise.

74. **HIGH remote-state integrity — a maximum safe remote generation could overflow on the next publication and create an unreadable head.**
   - `decodeV4RemoteHead()` correctly accepts every non-negative safe-integer generation, including `Number.MAX_SAFE_INTEGER`.
   - The publication path then used `remote.head.generation + 1` without checking that the successor remained a safe integer. A valid max-generation remote plus any push/Force Push could therefore encode an unsafe generation into the new V4 head after remote object work had begun; the next reader would reject that head as invalid.
   - RED: `015df6301bbf264930166ef861075895630099d0` proves a max-generation remote could proceed instead of rejecting before blob/tree/commit/ref side effects.
   - Fix: `b10522ea4e2fd2f942afd3cbca1ea0ed971b4da3` fail-fast guards the publication branch before publication-base resolution or remote uploads and reuses the checked generation for the increment.
   - Pure pull/no-publication flows still return before this guard, so a vault can still recover/read a max-generation remote; only a new publication is blocked until the protocol generation is reset through an explicit migration/reinitialization path.

75. **MEDIUM/HIGH Force Push mirror safety — managed remote gitlinks/submodules could survive an exact-mirror Force Push.**
   - Force Push recursive-tree cleanup previously deleted only blob entries. An in-scope Git tree entry with `type: "commit"` / mode `160000` (gitlink/submodule) was skipped, so the operation could report a successful exact mirror while leaving managed remote state that does not exist in the local vault.
   - RED: `34bf179` proves an in-scope remote gitlink survived Force Push, while an explicitly out-of-scope gitlink remains a legitimate preserved entry.
   - Fix: `620c3bb` treats a managed gitlink as unsafe and fails before candidate publication; out-of-scope gitlinks remain untouched by scope policy.

76. **MEDIUM lifecycle/settings safety — a settings save could resume after plugin unload and recreate scheduled runtime work.**
   - `saveSettings()` quiesces the runtime, stores secrets, then awaits durable settings persistence. If the plugin is disabled/unloaded while that await is pending, `onunload()` disposes the runtime and clears timers, but the resumed save previously still published in-memory settings, recreated the GitHub client, and called `registerScheduledSync()`.
   - Because `registerScheduledSync()` itself had no unload guard, this could install a new interval after unload and retain callbacks against a disposed plugin/runtime generation.
   - RED: `014e073` requires late settings persistence to stop before runtime/client/timer publication and requires scheduled registration itself to be inert after unload.
   - Fix: `d8c3c6b` returns immediately after successful durable persistence when `this.unloaded` is true, and `registerScheduledSync()` now fails closed after unload. The `finally` path still releases the settings-transition gate.
   - Focused settings/runtime coverage is green at **52/52**.

77. **HIGH external plaintext reconciliation safety — an in-scope gitlink/submodule could be interpreted as a remote deletion and trash the local file.**
   - Direct external plaintext reconciliation rebuilt logical remote state from recursive-tree blob entries and silently skipped every non-blob. If an external commit replaced a managed file path with a Git gitlink/submodule (`type: "commit"`, mode `160000`), that path disappeared from reconciled metadata even though the remote tree still contained an object at the path.
   - The planner could then treat an unchanged local file as remotely deleted, apply the pull through trash/delete semantics, and later publish V4 metadata that still did not represent the surviving gitlink.
   - RED: `4dce43d` replaces `note.md` with an in-scope gitlink in an external commit and proves normal sync proceeded instead of rejecting before local mutation.
   - Fix: `fe8b8e7` validates gitlink paths during external reconciliation and fails closed for internal or in-scope gitlinks/submodules before planning/local mutation; explicitly out-of-scope gitlinks remain untouched.
   - Focused `sync-session` coverage is green at **100/100** after the fix.

78. **HIGH external plaintext reconciliation safety — a managed Git symlink could be consumed as ordinary file bytes and replace local content.**
   - Recursive Git trees report a symlink as `type: "blob"`, mode `120000`. External reconciliation previously special-cased gitlinks but otherwise treated every blob mode as a normal file.
   - The session could therefore read the symlink blob payload, hash it as file content, plan a pull, and replace a managed local file with the symlink target text instead of rejecting an unsupported filesystem object.
   - RED: `b7518a4` replaces `note.md` with an in-scope mode-`120000` symlink and proves normal sync did not reject before the local mutation path.
   - Fix: `ed76ca7` accepts only regular managed blob modes `100644` / `100755`; internal or in-scope symlinks and other unsupported blob modes fail closed before body reads/planning/local mutation, while out-of-scope objects remain untouched.
   - Focused `sync-session` coverage is green at **101/101** after the fix.

79. **MEDIUM crash-recovery integrity — the local recovery generation could overflow past the safe-integer contract and persist an unreadable successor.**
   - Recovery headers correctly accept non-negative safe-integer generations, including `Number.MAX_SAFE_INTEGER`, but `save()` previously computed `generation + 1` without a successor check.
   - An integrity-valid max-generation recovery state could therefore cause the next save to write an unsafe generation that later readers reject, undermining crash-recovery continuity after the write.
   - RED: `38f6266` installs a valid max-generation slot and proves the next save proceeded instead of rejecting before any write.
   - Fix: `2d00466` checks the current generation before encryption/directory/write side effects and raises `V4RecoveryRequiredError` when no safe successor exists.
   - Recovery coverage is green at **49/49** after the fix.

80. **MEDIUM/HIGH plugin lifecycle safety — async startup could finish after unload and recreate disposed plugin work.**
   - `onload()` awaited settings loading and, when secret migration was needed, durable settings persistence before constructing the runtime, views, timers, commands, ribbon actions, and vault event handlers.
   - If the plugin was disabled/unloaded while either startup await was pending, `onunload()` set the disposed state and cleared existing work, but the resumed `onload()` previously had no lifecycle guard and could continue creating new runtime/UI/timer/event state after unload.
   - RED: `dd7e97d` requires startup to stop after both async settings boundaries when `this.unloaded` has become true.
   - Fix: `df2bc0a` checks the unload sentinel immediately after `loadSettings()` and again after optional migrated-settings persistence, before any runtime/client/view/timer/event registration occurs.
   - Focused settings/runtime coverage is green at **53/53** after the fix.

81. **MEDIUM/HIGH secret-migration durability — unload during settings load could skip durable cleanup of migrated legacy secrets.**
   - Legacy settings migration moves raw token/passphrase values into Obsidian SecretStorage and marks the in-memory settings as migrated so the old cleartext fields can be removed from plugin data.
   - Finding 80 added an unload guard immediately after `loadSettings()`. If unload happened while `loadSettings()` was awaiting and migration completed before that await returned, the guard could return before `persistData()`, leaving the legacy raw secret fields durably present in plugin data even though the plugin instance had already migrated them into SecretStorage.
   - RED: `ff149f941c7dbb1b0111baaa7d126af0bfad3226` requires migrated-secret cleanup persistence to occur before unload can short-circuit startup runtime creation.
   - Fix: `78ba901` preserves the lifecycle safety from finding 80 but orders startup as load → optional migrated-settings persistence → unload guard → runtime/UI creation. Unload during settings loading therefore cannot recreate runtime work, while migrated raw secrets are still durably scrubbed before startup returns.
   - Focused settings/runtime coverage is green at **54/54** after the fix.

82. **HIGH settings/credential integrity — malformed persisted settings could mutate SecretStorage before being rejected.**
   - `loadSettings()` merged persisted data with defaults, then called `migrateV4Secrets()` before `assertPluginSettingsRuntimeSafe()`.
   - `migrateV4Secrets()` can write legacy raw token/passphrase values into SecretStorage. Therefore structurally unsafe persisted settings could overwrite or create durable secret entries before startup validation rejected the settings object.
   - RED: `0d7bf41` requires persisted settings validation to occur before any secret-migration side effect.
   - Fix: `2279fa9` validates the merged persisted settings before calling `migrateV4Secrets()`, while retaining the existing post-migration validation of resolved runtime settings.
   - Focused settings/runtime coverage is green at **55/55** after the fix.

83. **MEDIUM/HIGH Force Push mirror safety — a managed explicit empty Git tree could survive an exact-mirror Force Push.**
   - Force Push cleanup rejected managed gitlinks and deleted managed blobs, but skipped every `type: "tree"` entry in the recursive Git tree.
   - Git can contain an explicit empty tree object with no descendant entries. Because Obsidian vault sync has no content object corresponding to that empty directory, such a managed tree could survive Force Push while the operation reported an exact managed mirror.
   - RED: `9bc0fa2` injects an in-scope `type: "tree"`, mode `040000` entry with no descendants and proves Force Push completed instead of rejecting the unmirrorable remote state.
   - Fix: `37f5f55` precomputes directory paths that are proven non-empty from recursive-tree descendants and fails closed only for managed tree entries with no descendants. Ordinary non-empty directories and out-of-scope tree entries keep their prior behavior.
   - Focused `sync-session` coverage is green at **102/102** after the fix.

84. **HIGH external reconciliation safety — a tracked file replaced by a Git directory could be misclassified as a remote deletion.**
   - Plaintext external reconciliation previously skipped recursive-tree directory entries and later inferred absence for the tracked file path from the lack of a blob entry.
   - If an external Git commit replaced a tracked file such as `note.md` with a directory at the same path, normal sync could therefore plan local deletion instead of recognizing an unsupported file→directory topology change.
   - RED: `2d8d32a` replaces a tracked file with a Git tree and proves the sync path could otherwise reach local deletion semantics.
   - Fix: `1613d05` fails closed when an in-scope recursive-tree directory occupies a path that is already represented by an authenticated tracked file record, before any local mutation or metadata publication.

85. **HIGH recovery/local topology safety — a directory→file pull could write before removing blocking descendants or fail on a surviving empty folder.**
   - Recovery payloads were emitted in planner order. When remote state replaced a local directory subtree such as `dir/file.md` with a file at `dir`, the stage-write for `dir` could precede the descendant trash and fail because the filesystem topology still blocked the target.
   - On the real Obsidian vault adapter, deleting the last descendant can still leave an empty `TFolder` object at the target path; desktop staged commit and direct vault writes then observe a directory where the file precondition expects no file.
   - RED: `3526f19` proves recovery must remove blocking descendants before writing the parent file.
   - Fix: `ffb71e0` topologically orders blocking trash mutations before stage-writes, derives pull completion from each pull group's actual terminal mutation, removes only empty target folders before file creation/commit, and refuses to replace non-empty folders.
   - Focused recovery boundary coverage is green at **3/3** and vault-write adapter coverage at **2/2** after the fix.

86. **MEDIUM/HIGH recovery liveness — vault topology races could hard-fail instead of triggering a safe replan.**
   - The vault adapter correctly refused to replace a non-empty folder with a file and refused to create a parent directory where a file already existed, but those failures were generic errors.
   - Recovery treats `V4LocalTargetChangedError` or an equivalent `local target changed` signal as evidence to persist `replan-required`. Generic topology errors therefore could leave recovery in `local-committing` and repeat the same failure after a concurrent user/out-of-scope topology change.
   - RED: `6bbd6f5` requires both non-empty-folder targets and file-as-parent conflicts to be classified as local target changes.
   - Fix: `be6fcf8` marks both vault topology safety errors as `V4 local target changed`, allowing the existing recovery replan path to preserve local state instead of hard-failing.
   - Focused vault-write coverage is green at **3/3** and recovery-boundary coverage remains **3/3** after the fix.

87. **MEDIUM/HIGH recovery resource safety — topology ordering introduced an O(N²) trash/write scan for large pull payloads.**
   - The directory→file recovery fix initially classified each trash mutation by scanning every staged-write path with ancestor/descendant checks.
   - Large Force Pull or recovery payloads can contain many thousands of writes and trashes, so the pairwise scan scaled quadratically even though the surrounding sync/recovery pipeline is designed for large vaults.
   - RED: `39bc40f` exercises 10,000 staged writes plus 10,000 unrelated trash mutations and measured about **2.28s CPU** before failing a 0.75s resource ceiling.
   - Fix: `235fb98` replaces pairwise scanning with an exact-path set, ancestor lookup, sorted write paths, and binary prefix search. The same 20,000-mutation regression now completes in tens of milliseconds while preserving the recovery topology ordering regression.
   - Focused resource regression is green at **1/1**; recovery-boundary semantics remain **3/3**.

88. **HIGH remote-state integrity — authenticated V4 records could describe filesystem-impossible file-prefix collisions.**
   - Complete remote-record validation rejected exact duplicate logical paths but did not reject one logical file path being an ancestor of another, such as `dir` and `dir/file.md`.
   - The local writer cannot produce that state from an Obsidian vault, but a forged/corrupt authenticated remote metadata set could pass record hashes/pathId checks and reach planning/recovery even though no filesystem can materialize both files simultaneously.
   - RED: `af9c879` constructs valid plaintext records for `dir` and `dir/file.md` and proves `assertV4RemoteRecordSet()` accepted them.
   - Fix: `5b78259` validates the complete logical-path set for file ancestors by walking slash-delimited prefixes against the already authenticated path set. The check is order-independent and O(total path depth), with no additional remote reads.
   - Focused remote-index coverage is green at **18/18** after the fix.

89. **HIGH cross-platform remote-state integrity — authenticated records could collide only after NFC/case-insensitive canonicalization.**
   - The local writer already rejects logical path sets such as `Notes/A.md` plus `notes/a.md`, and NFC-equivalent names such as composed/decomposed `Café.md`, because those names cannot be represented distinctly on all supported vault filesystems.
   - Complete remote-record validation previously rejected only exact duplicates and file-prefix topology collisions. A forged/corrupt authenticated metadata set could therefore pass with canonical-name collisions that are impossible to materialize safely on case-insensitive or Unicode-normalizing platforms.
   - RED: `d585a37` proves `assertV4RemoteRecordSet()` accepted both case-insensitive and NFC-equivalent collisions.
   - Fix: `ce673e9` applies the same `NFC + lowercase` canonical key used by the local writer to the authenticated remote record set and rejects any distinct logical paths sharing that key.
   - Focused remote-index coverage is green at **19/19** after the fix.

90. **HIGH cross-platform remote topology integrity — a file ancestor collision could exist only after NFC/case-insensitive canonicalization.**
   - Finding 89 rejected distinct logical paths that canonicalize to the same full path, but the file-prefix topology check still walked the original case-sensitive logical path set.
   - A forged/corrupt authenticated record set such as file `Dir` plus file `dir/child.md` (or NFC-equivalent ancestor spellings) could therefore pass despite being impossible to materialize on supported case-insensitive/normalizing filesystems.
   - RED: `e64a7e7` proves both case-insensitive and NFC-equivalent file-ancestor collisions passed `assertV4RemoteRecordSet()`.
   - Fix: `9bf77af` walks the already-authenticated canonical path map for slash-delimited ancestors in addition to the exact logical-path topology check, preserving O(total path depth) validation with no remote reads.
   - Focused remote-index coverage is green at **20/20** after the fix.

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
- Remote metadata/history fields still rely partly on transport size plus post-parse writer-shape validation rather than one universal pre-parse byte/string ceiling. This pass specifically reviewed journal bytes and `fileId` length; no new cap was added because the current writer contract does not define a portable total-path/metadata-byte maximum and tightening arbitrary string lengths could reject existing V4 data. Treat this as protocol/resource-hardening design work, not a confirmed destructive bug in this pass.
- `createGitTree()` still validates general successful tree mutation responses primarily as Git object IDs rather than proving full semantic equivalence to `base_tree + requested edits`. Blob creation and commit creation are bound to their intended bytes/semantics, and the special empty-repository bootstrap tree now has its own exact bounded two-level proof, but general candidate-tree equivalence still needs authenticated Merkle/path reconstruction of the base and result. A naive recursive-tree comparison would add large-repository cost and can itself encounter truncated tree responses, so do not add a broad recursive scan merely to close this residual; design a bounded exact-tree proof first.

- Supply-chain review: the repository has no runtime npm dependencies; build/test dependencies are lockfile-managed. `esbuild ^0.24.2` is in a known affected range for dev-server advisories (including the historical cross-origin dev-server issue and a Windows servedir file-read issue), but this repository's `esbuild.config.mjs` uses only `context().watch()/rebuild()` and never starts `serve()`. Treat esbuild `0.24.2` as a dev-tooling hygiene residual, not a production/runtime blocker. Do not hand-edit the pnpm lockfile; upgrade only with a real pnpm install + build/package verification.
- Repository-host security alert APIs (Dependabot/secret-scanning/code-scanning) were probed through the available GitHub connector but were not readable with the current connector permissions, so this audit does not claim server-side alert dashboards are empty.
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
- `ee6640d6fe02f9e493158f3c60e30e026fbd6948` — file-history traversal must have one aggregate journal-read budget, and scheduled intervals must stay within the signed 32-bit timer delay range.
- `8aac1d5bc0b7598dafd25e4302be4035e960ff08` — large coordinator event bursts must not depend on argument-spread limits, and remote history journal changes must be writer-shaped before exposure.
- `1c5ca913938a2df2b8c9a034e21669197531d62f` — successful immutable Git commit/tree reads must be bound to the exact requested object IDs, not merely valid-looking SHA strings.
- `e4c68da4e8f37af14ac1add9a715db201b5f30e0` — successful Git blob creation must return the deterministic object ID of the uploaded bytes.
- `1192a6c12c3900f87290f38a3702e8c4876d2b64` — successful Git commit creation must read back to the requested message/tree/parents before publication.
- `e042790b06fbce6621054a4ab67b3edbdcb6a855` — a successful empty-repository bootstrap commit must still be a root commit rather than silently inheriting a competitor base.
- `26af58a088acca4f39568a645c1e0e00225a7a26` — a successful root bootstrap commit must contain the exact bootstrap marker bytes sent by the client before any configured ref is trusted.
- `103bae04cdebc751d8dd5b367b6e774141291ad8` — an already-existing configured bootstrap branch must point exactly at the verified bootstrap commit.
- `d5cdcd2ecd0424bfc6bff2be0f665a0d8ee79e19` — the configured branch must still point at the bootstrap SHA on the post-create read, not merely on the successful create-ref response.
- `2d3812e6b5010c8296242ac3b5df8c9b2f86394b` — exact bootstrap marker bytes are insufficient if the root/bootstrap-directory tree contains additional entries.
- `79a109603463a56559982d0c071df662db95e2be` — authenticated Contents bytes must still be bound to the exact requested repository path and file type.
- `d578693148d77549a7a3aab779a580daf073345b` — an empty Git repository's documented HTTP 409 configured-ref response must be treated as an absent ref so Contents bootstrap can run.
- `5655f2b3f565bf3b1b8912524b798f76336c2659` — journal capacity must be checkable from the resolved change count before staging or immutable-object upload begins.
- `909c7442c6b6da3aea6f1d8eda9db87a3d657d29` — direct plaintext external reconciliation must not re-download an unchanged blob when authenticated metadata and immutable baseline/current trees prove the blob object ID is unchanged.
- `0b097d3a4334096d90bea438d09d111bb28109f4` — a generic/unavailable any-ref HTTP 409 must fail before empty-repository Contents bootstrap can issue any remote mutation.
- `72529e40a16c1bbe32a02fdeafc936cd4f5050da` — definitive configured-ref create conflicts must reconcile by exact observed SHA instead of failing a benign same-bootstrap race.
- `015df6301bbf264930166ef861075895630099d0` — a valid maximum safe remote generation must reject before any publication side effects because no safe successor generation exists.
- `34bf179` — Force Push must not silently preserve an in-scope remote gitlink while claiming an exact mirror; out-of-scope gitlinks remain preserved by scope.
- `014e073` — a settings save that resumes after plugin unload must not recreate client/runtime timers or publish a new live settings generation.
- `4dce43d` — plaintext external reconciliation must not interpret an in-scope gitlink/submodule as file absence and locally delete the managed path.
- `b7518a4` — plaintext external reconciliation must reject an in-scope Git symlink before its blob payload can be treated as ordinary file content.
- `38f6266` — recovery persistence must reject a valid maximum safe generation before computing or writing an unsafe successor.
- `dd7e97d` — plugin startup must remain inert if unload occurs while settings load or migrated-settings persistence is still awaiting completion.
- `ff149f941c7dbb1b0111baaa7d126af0bfad3226` — unload during startup settings load must not skip durable cleanup of migrated legacy secrets before startup returns.
- `0d7bf41` — malformed persisted settings must be rejected before secret migration can mutate SecretStorage.
- `9bc0fa2` — Force Push must not silently preserve a managed explicit empty Git tree while claiming an exact mirror.
- `2d8d32a` — external reconciliation must not treat a tracked file replaced by a Git directory as ordinary remote absence/local deletion.
- `3526f19` — recovery pulls must remove path-topology blockers before writing a file that replaces a directory subtree.
- `6bbd6f5` — vault file/directory topology conflicts must be classified as local-target changes so recovery can replan safely.
- `39bc40f` — large recovery topology payloads must not use pairwise trash × write scans.
- `af9c879` — complete remote V4 record sets must reject logical file-prefix collisions such as `dir` plus `dir/file.md`.
- `d585a37` — complete remote V4 record sets must reject distinct logical paths that collide under the writer's NFC + case-insensitive canonicalization.
- `e64a7e7` — complete remote V4 record sets must reject file-ancestor topology collisions that appear only after NFC + case-insensitive canonicalization.

Refined root-cause design:
- create one canonical shard-record hash function and use it for writer hash creation, remote shard verification, and local persisted-cache verification;
- validate remote config/head/record/history metadata at decode boundaries using writer-compatible limits;
- bound whole-buffer chunk read concurrency even after descriptor validation;
- add coordinator `cancelActive` plus runtime quiesce and make settings publication occur only after the old run is idle;
- unknown empty-repository Contents bootstrap outcomes must replan on newly observed repository state rather than adopt an unproven SHA.

Current execution state supersedes the earlier sandbox/DNS limitation: the connected lnwjud workspace can execute the repository with the exact Node/pnpm toolchain and can fetch/push the audit branch successfully. Hosted GitHub status/check-runs/workflow runs remain separate evidence and must still be checked for the exact pushed SHA before release qualification.

### Production fix status

Root-cause fixes are now on the audit branch:
- `da56f07630a1f388249fc588b246f1a46a7d29bb` — add canonical V4 shard-record hashing helper.
- `378059b94b33dc8b495f0b4810c2b9b4b9219dd2`, `3dba921c263e5098214cb9bad800836c8b817ed9` — validate local cached shard hashes on load and refuse mismatched shard persistence.
- `dcff671b8b09baab72a3ecd580819f1de28d7c76`, `359b873277cfb25456faf1617e76b54c04073472` — writer derives head hashes from canonical records; remote loader verifies both cached and freshly fetched shards against the head.
- `e300fe07983a757d0020cb8fe8c79a18993e1e4e` — unknown empty-repository Contents bootstrap outcomes with newly observed repository state now surface a typed bootstrap race instead of adopting an unproven SHA.
- `88990134ae8e8764e8b8c0696e16c934020727ae`, `aab2e432c74dc7b550455d5300a1a604eaac087f`, `e382e63e085fc196e8015c4dc046a7c1c99e8473`, `a04ba7b4f9b233871328368fbdb58da1591965fa`, `d2a02390b7c725a40f96ebc392153b8a13611fd8` — reusable active cancellation, runtime quiescence, settings publication ordering, and progress cleanup for atomic settings/client generation rotation.
- `f2ad17aef7d833178f7e9ba105489ce6fb6ad999`, `8c6bd38cdb0b9bc3a953a4bc9dcda0734b6bf60b` — encrypted config/KDF bounds plus remote head/record/shard shape/resource validation.
- `ff2780ff1543fde9b3914db174b733a998011f9f` — bound whole-buffer chunk remote reads to four concurrent part fetches.
- `e1173260c083c2be55c4317ed1fec119b90a488f` — remove coordinator argument-spread amplification and validate remote journal change semantics/paths/descriptors before history consumers observe them.
- `8d56b55c130062934ed3850b43dfcb62b462bb69` — bind successful immutable Git commit/tree reads to the exact requested SHA before their evidence is trusted.
- `7cc635aa3ee71bdbe36ddce8a6d7b5017c895f27` — bind successful Git blob creation to the deterministic SHA-1 of the uploaded bytes.
- `ddec918b51d3dc4e0129449b0682487cce1fb126` — validate commit mutation inputs and read the created commit back to bind message/tree/parents before publication.
- `a4f9d5ba5ecd26140cb3a237251aa96939783276` — authenticate successful empty-repository bootstrap as a root commit with the exact bootstrap message before accepting/creating the configured ref.
- `ff4386adeb24f983316872ae99394464b17efad3` — bind successful bootstrap completion to the exact immutable marker bytes that were sent in the Contents PUT before configured-ref adoption.
- `68803e2f8ef1754c5c16dd93cce524f0dae84551` — bind every configured-bootstrap-ref observation to the verified bootstrap SHA, including pre-existing refs, post-create reads, and ambiguous create reconciliation.
- `593657cb7a73b06630a0610f38ba281ea2eaa883` — authenticate the successful root bootstrap commit's exact bounded two-level tree shape and marker leaf identity before configured-ref adoption.
- `0762038ae20673674fceb71376906dd21d1443c4` — stabilize the fast planner qualification by measuring process CPU time instead of wall-clock delay caused by concurrent test files.
- `d957ad1` — bind successful GitHub Contents file responses to `type: "file"` and the exact requested repository path before trusting authenticated payload bytes.
- fixture-only follow-up `a121304` keeps the immutable Contents-success regression protocol-shaped under the stricter response contract.
- `6d3ba0a899214c9b8d0f842ce3a28be14c3a5796`, `4959c07acd5ae6007ec66a925050edcd40bfb76f` — allow only documented empty-repository configured-ref conflicts to reach verified Contents bootstrap while propagating unrelated 409 conflicts fail-closed.
- `647fbeeaade34008162d4382955afc37a787bf09` — preflight the exact resolved journal change count against the shared writer contract before staging or streamed remote uploads can create side effects.
- `48d103dc95b2c75feba43deabf40f56c2305804c` — reuse authenticated plaintext records for unchanged external-tree blobs when the local metadata manifest exactly matches the authenticated remote head, avoiding full-vault blob re-downloads for direct external edits.
- `5d7f4d211d22b73a4383972430ccd6ab4a039c5e` — distinguish explicit empty-repository conflicts from generic/unavailable 409 responses in the any-ref bootstrap preflight so non-empty conflicts fail before Contents mutation.
- `5ed8abe` — reconcile definitive 409/422 configured-ref create conflicts only when read-back proves the ref points exactly at the verified bootstrap commit; competitor SHA remains a typed bootstrap race.
- `b10522ea4e2fd2f942afd3cbca1ea0ed971b4da3` — guard max-generation remotes at the publication boundary so no unsafe successor head or remote publication side effects can be created.
- `620c3bb` — fail closed when an in-scope remote gitlink/submodule prevents Force Push from proving an exact managed mirror; preserve out-of-scope gitlinks.
- `d8c3c6b` — keep late settings-save completion inert after plugin unload and prevent scheduled sync registration from recreating timers on a disposed plugin.
- `fe8b8e7` — reject managed external plaintext gitlinks/submodules before they can be misclassified as remote deletions; preserve out-of-scope gitlinks by scope.
- `ed76ca7` — reject managed external plaintext symlinks and unsupported blob modes before body reads or local planning; preserve out-of-scope objects by scope.
- `2d00466` — fail closed before recovery encryption/write when the current valid recovery generation has no safe successor.
- `df2bc0a` — make async plugin startup stop after unload at both settings-load and migrated-settings-persistence boundaries before recreating runtime work.
- `78ba901` — persist migrated legacy-secret cleanup before the startup unload guard while keeping all runtime/UI/timer creation behind that guard.
- `2279fa9` — validate merged persisted settings before `migrateV4Secrets()` can write SecretStorage, while retaining post-migration runtime validation.
- `37f5f55` — fail closed on managed explicit empty Git tree entries during Force Push while preserving non-empty and out-of-scope directories.
- `1613d05` — fail closed when external plaintext reconciliation replaces an authenticated tracked file path with a Git directory before local deletion can be planned.
- `ffb71e0` — topologically order recovery trash/write mutations and make the Obsidian vault adapter replace only empty target folders when a file must occupy that path.
- `be6fcf8` — classify non-empty-folder and file-as-parent vault topology conflicts as local-target changes so recovery enters replan-required instead of hard-failing.
- `235fb98` — replace quadratic recovery trash/write topology scans with exact-path/ancestor set lookups plus sorted-prefix binary search.
- `5b78259` — reject complete remote V4 record sets where one logical file path is an ancestor of another before planning or local mutation.
- `ce673e9` — reject authenticated remote logical path sets whose distinct names collide under NFC + case-insensitive canonicalization.
- `9bf77af` — reject authenticated remote file-prefix topology collisions across NFC/case variants by walking the canonical path set.
- `6151868d066c050deef9159d3beda389e2ae0ce7`, `d9cde1a72496a8c86df5c85b975d39b92998f873`, `0c301523e774d54bc03191aa7a897da98691ac81`, `06335328777bd5010e928c1951f1cdb581aac2f0` — bounded journal writer/reader contract, safe journal markers, cross-page consistency, descriptor validation before blob reads, and preview-limit precedence.
- fixture-only followups `4ce0affffce484398db30b0de339af8a2dd1e5cf`, `e5ae96eda6003faa4233346bd5104561e2258923`, `40fc418844c40a52ef4baa39c7318f21a5547782`, `b876e4076084e544ec13ec0ef60c9ef7e0cbcc8a` keep tests protocol-shaped rather than weakening production validation.

Recent crash/memory hardening:
- `99f8e793...` / `e2d9dae3...` — interrupted desktop staged swaps become resumable.
- `d49bb3c8...` — large chunked conflict copies stream directly into staging.
- `82efe37c23094d20aeb348a2f93be7b1ede50a38` — final desktop staged-target hash verification re-runs vault path safety before bounded reads, in addition to the cache/staged-copy fixes above.

Verification status:
- The repository was executed through the connected local engineering workspace with Node `v24.11.0` and pnpm `9.12.3`.
- Final post-fix gates on the current production source: `pnpm run test:fast` **529/529**, `pnpm run test:recovery` **50/50**, `pnpm run test:resource` **12/12**, and `pnpm run build` PASS.
- Final release checks also pass on regenerated artifacts: `pnpm run validate:metadata` and `pnpm run validate:package`.
- The 529/529 fast run was executed with one unrelated uncommitted test-only helper in `tests/v4/github-transport.test.ts`; it does not modify production source or add/change a test case. Do not describe that run as a pristine exact-Git-tree qualification until that concurrent WIP is committed or removed.
- Focused regressions in the latest audit pass: settings-secrets **55/55**, sync-session **102/102**, remote-index **20/20**, recovery **50/50**, recovery-boundary **3/3**, recovery-topology-ordering **1/1**, vault-write **3/3**, github-bootstrap-ref-conflict **2/2**, github-empty-ref **3/3**, github-transport **43/43**, storage-history **4/4**, github-immutable-read-fallback **13/13**, and benchmark **3/3**; the benchmark qualification also reproduced the prior wall-clock flake under full-suite contention before `0762038...`, with later full fast runs remaining green through the current **529/529** audit head. Prior history-service **13/13**, sync-coordinator **25/25**, sync-policy **2/2**, storage-codec **12/12**, and opaque-leakage **2/2** remain covered by the full fast gate.
- Real GitHub E2E remains excluded from the default fast tier and was not run in this closure; inspect hosted checks for the exact pushed SHA separately before treating the branch as release-qualified.

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
