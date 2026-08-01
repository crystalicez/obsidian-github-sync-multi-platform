# Frequently Asked Questions (FAQ) / 常见问题解答

This FAQ describes the current V4 implementation. Qualification status for very large files is evidence-based and platform-specific.

本文说明当前 V4 实现。超大文件能力必须按平台和实际验证证据区分。

---

## 简体中文

### Q1. V4 是双向同步吗？

是。普通同步使用三方状态（上次已验证基线、本地、远端）制定计划：先处理需要拉取的远端变化，再在一个 Git 提交中发布需要推送的远端变化。文件创建、修改、删除、文件重命名和文件夹重命名都会保留 V4 的逻辑文件身份；“删除后重建”会产生新的身份。

**Force Push** 让 V4 远端精确镜像当前同步范围内的本地状态；**Force Pull** 让本地同步范围镜像已验证的 V4 远端状态。加密旧布局迁移只通过明确确认的 Force Push 完成，普通同步不会隐式迁移。

### Q2. V4 是否每次重新上传所有文件？

不是。计划器按逻辑文件身份、路径和内容哈希判断变化；未变文件复用现有远端记录。内容保持不变的重命名可以复用已有加密对象/分片，不重新上传文件内容。

但这不等于“文件内部增量/差分上传”。当一个大文件的内容发生变化时，当前 V4 会生成新的完整 `remoteVersion`；超过 50 MiB 的远端内容使用有序分片。当前协议没有 changed-part/delta sync，因此修改一个 5 GiB 加密文件可能产生接近一整个新 5 GiB 修订的数据增长。

### Q3. 多设备同时修改同一文件时怎么处理？

V4 会检测真正的三方冲突，不再采用旧版 FAQ 中描述的“409 后直接覆盖”。可选策略为：

- **Copy policy**：保留远端主版本，同时把本地版本保存为冲突副本。
- **Newer**：按元数据选择较新的版本；时间相同时退化为保留两份。
- **Merge text**：只对支持的文本类型且三个已知版本都不超过 2 MiB 时尝试当前的保守三方合并；不能安全合并时保留两份。
- **Always ask**：先让用户选择，再只读取所需的内容。

网络过程中如果本地目标又被用户修改，最终写入前的 precondition 会阻止静默覆盖，并转入重新规划/恢复路径。

### Q4. 大文件和 5 GiB 的支持状态是什么？

V4 远端格式在超过 50 MiB 时使用分片；当前兼容读取必须接受历史 48 MiB 分片。桌面端实现了有界读取、分阶段写入和最终校验提交，自动化测试还覆盖 512 MiB 虚拟路径以及独立的 2/5 GiB cryptographic soak harness。

但是“自动化虚拟流通过”不等于“真实设备 5 GiB 通过”。公开支持结论必须来自 `tests/baselines/v4/` 中记录的物理测试：

- **Windows 5 GiB**：在完整 Force Push → no-op → 清洁 vault Force Pull → SHA-256 相等测试被记录之前，状态是待物理验证。
- **Android 5 GiB**：当前实现没有经过支持路径证明的有界本地读取和最终 stage-commit，因此大文件会能力门控；状态为 `platform-capability-fail`，不宣称 Android 5 GiB。

### Q5. GitHub Free 适合反复同步 5 GiB 加密文件吗？

一次操作“技术上可能完成”和“长期运行健康”是两回事。当前 48 MiB 模型对 5 GiB 文件约为 107 个数据分片、约 114 个内容/发布 mutation，并至少需要约 113 秒的 1 秒 mutation pacing（不含网络、加密、重试和磁盘 I/O）。更重要的是，两个完整加密 5 GiB 修订的模型增长已经略高于 GitHub 当前 10 GB 仓库大小建议。

因此在真实一次性测量完成前，发布层面的 GitHub Free 5 GiB 状态仍是 `measurement-required`，尚不赋予发布分类；模型结论是 `technical-pass-operational-limited`，不能宣传为适合频繁修改的 5 GiB 工作负载。

---

## English

### Q1. Is V4 a two-way sync?

Yes. Normal sync plans from three states: the last verified base, local state, and authenticated remote state. It applies required pulls first and publishes required remote changes in one Git commit. Create, modify, delete, file rename, and folder rename preserve logical V4 identity; delete-then-recreate creates a new identity.

**Force Push** makes the V4 remote exactly mirror the local in-scope state. **Force Pull** makes the local in-scope state mirror the validated V4 remote. Legacy encrypted-layout migration is an explicitly confirmed Force Push operation, not an implicit normal-sync migration.

### Q2. Does V4 upload every file on every sync?

No. The planner compares logical file identity, path, and content hash. Unchanged records are reused, and a content-preserving encrypted rename can reuse the existing object/parts without uploading the content again.

This is not block-level delta sync. When a large file's content changes, current V4 creates a new complete `remoteVersion`. Remote payloads over 50 MiB use ordered parts, but V4 does not currently upload only the changed internal parts of a modified file. A changed 5 GiB encrypted file can therefore add roughly one new full revision to history.

### Q3. How are simultaneous edits handled?

V4 detects a three-way conflict instead of using the old “retry 409 then overwrite” behavior previously described by this FAQ. The available policies are:

- **Copy policy**: keep the remote primary version and materialize the local version as a conflict copy.
- **Newer**: choose by metadata; a tie keeps both.
- **Merge text**: attempt the existing conservative 3-way text merge only for supported text types when all three known versions are at most 2 MiB; otherwise keep both.
- **Always ask**: ask first, then load only the body required by the selected action.

If the user changes a local target while network work is in flight, the final precondition check refuses to silently overwrite that edit and moves the run into recovery/replanning.

### Q4. What is the large-file / 5 GiB support status?

The V4 remote format uses parts above 50 MiB and readers remain compatible with historical 48 MiB parts. Desktop code has bounded reads, staged writes, and verified final commit/rollback. The official Windows Task 15 automated gate and the separate 2/5 GiB cryptographic soak are recorded as passed.

A virtual stream is not a physical-device 5 GiB pass. Public support claims come only from recorded evidence in `tests/baselines/v4/`:

- **Windows 5 GiB**: pending a recorded physical Force Push → no-op → clean-vault Force Pull → SHA-256 equality run.
- **Android 5 GiB**: the current supported implementation lacks bounded local read and bounded final stage-commit capability, so large mobile paths are capability-gated and classified `platform-capability-fail`.

### Q5. Is repeated 5 GiB encrypted sync operationally suitable on GitHub Free?

Technical completion and operational suitability are separate. With the current 48 MiB model, one 5 GiB revision is 107 data parts and about 114 modeled content/publication mutations, with a minimum 113-second one-second mutation-pacing floor before network, crypto, retries, or disk I/O. Repository growth is the stronger limitation: two full encrypted 5 GiB revisions already model slightly above GitHub's current 10 GB repository-size recommendation.

Until one disposable-repository measurement is recorded, the release status is `measurement-required` and no release classification is assigned yet. The current model classification is `technical-pass-operational-limited`, not “healthy for frequent 5 GiB edits.”

See `docs/engineering/v4-github-free-operational-model.md` and `docs/testing/v4-windows-android-validation.md` for the evidence rules.
