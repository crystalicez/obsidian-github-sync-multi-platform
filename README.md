# Encrypted GitHub Sync (Multi-Platform)

[![GitHub release (latest by date)](https://img.shields.io/github/v/release/crystalicez/obsidian-github-sync-multi-platform?style=flat-square)](https://github.com/crystalicez/obsidian-github-sync-multi-platform/releases)
[![Downloads](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=9437ff&label=downloads&query=encrypted-github-sync-multi-platform.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json&style=flat-square)](https://obsidian.md/plugins?id=encrypted-github-sync-multi-platform)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg?style=flat-square)](https://www.apache.org/licenses/LICENSE-2.0)

[English](#english) | [简体中文](#chinese)

---

<a name="english"></a>

## 🚀 Overview

**Encrypted GitHub Sync (Multi-Platform)** is a high-performance, serverless synchronization solution. It leverages the GitHub REST API to provide seamless, real-time note synchronization across Desktop (Windows/macOS/Linux) and Mobile (iOS/Android) devices within your notes environment.

Unlike traditional Git-based plugins, this tool interacts directly with the GitHub API, eliminating the need for a local Git environment on mobile devices and providing a faster, more stable experience.

### ✨ Key Features

-   **Mobile support without Git binaries**: Normal-size vault content works through the Obsidian API. Large mobile files are capability-gated when a bounded local read/commit path is unavailable; the plugin does not fall back to a multi-gigabyte whole-buffer read.
-   **Real-time Auto-Sync**: Intelligent event listening triggers synchronization on file modification with a 5-second debounce to optimize API usage.
-   **Serverless Architecture**: No middle-man server required. Your data goes directly to your private GitHub repository.
-   **Atomic two-way sync**: Pulls first, plans with a three-way index, and publishes all required remote updates in one Git commit.
-   **All vault file types**: Syncs notes, media, archives, Canvas files, and other files. The V4 remote format splits payloads over 50 MiB into verified parts; desktop uses bounded local I/O, while large mobile upload remains capability-gated pending a proven bounded read path.
-   **Optional encryption**: Hides every directory name, filename, extension, and file content behind stable opaque objects; plaintext mode stores normal paths and bytes.
-   **Sync Center**: Browse 50 commits per page, inspect commit changes, and lazily preview commit or current-file versions.

## 🛠 Tech Stack

-   **Core**: TypeScript, Plugin API.
-   **UI**: Vanilla CSS, native Obsidian setting controls.
-   **Network**: GitHub REST API (v3).
-   **Build**: esbuild for high-speed bundling.

## 📥 Installation

1.  Open **Settings** > **Community plugins**.
2.  Disable **Restricted mode**.
3.  Click **Browse** and search for `Encrypted GitHub Sync (Multi-Platform)`.
4.  Click **Install**, then **Enable**.

*(Alternatively, download the latest release and place `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/encrypted-github-sync-multi-platform/`)*

## ⚙️ Configuration

1.  **GitHub Token**: Generate a [Personal Access Token (PAT)](https://github.com/settings/tokens) with `repo` scope.
2.  **Repo Settings**:
    -   **Owner**: Your GitHub username.
    -   **Repo**: Your private notes repository name.
    -   **Branch**: Typically `main` for an already initialized V4 repository. For a new encrypted Vault, choose a branch name that does not yet exist; **Sync now** will create it after you save Settings. The GitHub branch field must contain an explicit name; an empty branch cannot be saved or used for manual, automatic or Force Sync. Existing installations with a saved empty or malformed GitHub branch, owner or repository can still open Settings for explicit repair without switching targets or contacting GitHub; malformed legacy routing loads read-only without automatic SecretStorage migration, and normal Settings Save still refuses unsafe coordinates. An incomplete saved connection (including a blank branch, Device ID, token, or required encryption passphrase) does not construct an authenticated GitHub client, including for History views; fix Settings and Save changes before Sync.
3.  **Check connection**: If using **Paste remote configuration**, the clipboard must contain JSON with string owner, repo and token fields (and optionally branch), using either GitHub-prefixed keys or short aliases. The plugin validates these fields before changing the Settings draft; pasted credentials require an explicit **Save changes** and are not synced immediately. The clipboard parse result and token are never logged. Use **Test GitHub connection** in Settings before syncing. It checks repository and branch read access using the current form values, even before saving. For a new, not-yet-created branch, a missing-branch result is expected. After you save Settings, **Sync now** creates the branch and uploads your first notes with normal Sync; **Force Push is not needed** for a genuinely absent branch. Malformed GitHub owner, repository or branch values receive field-specific correction guidance before any network request. The connection check sends only GET requests. For an existing branch it reads the V4 configuration and required HEAD metadata from the **same immutable Git commit**, checks the repository identity, storage mode and path layout, and warns if the HEAD is missing or invalid (in plaintext mode). This is a read-only snapshot: Sync rechecks the live branch before writing. When the existing branch is incomplete or incompatible, choose a new empty branch or restore the original from a separate backup; do not Force Push over unrelated history. For encrypted HEAD, this read-only check only verifies that the blob exists; it does not decrypt or authenticate it. The check does not verify write permissions, the encryption passphrase, full remote contents, or whether a new branch can be created. A branch with existing non-V4 history is never overwritten by normal Sync. If the Vault has no notes yet, the first **Sync now** still initializes the new branch with V4 configuration and HEAD metadata; subsequent unchanged Sync runs do not create extra commits.
4.  **Sync Options**: Configure startup, five-second debounced local-change, and interval synchronization independently. Automatic Sync waits until owner, repository and a non-blank GitHub token are configured; a token containing only whitespace is treated as missing. Encrypted mode also requires a passphrase. Manual/Force Sync and the read-only connection check likewise ask you to correct a whitespace-only token before making a request; the saved token is not silently modified. Settings Save also refuses a whitespace-only token before SecretStorage or plugin-data writes, while allowing an empty token for staged first-use configuration. The ribbon shows **Not Configured** until the saved owner, repository, branch, Device ID, token and required encrypted passphrase all satisfy the same readiness check used before Sync; it refreshes after Settings Save. Manual Sync and Force controls also refuse missing saved configuration before starting Runtime or opening a Force confirmation, with a notice naming the missing fields; finish Settings and Save changes, then retry Sync now. If you change Settings before a queued startup or scheduled Sync fires, its old callback is ignored; a successfully saved interval schedule replaces the old timer. An uncertain failed Settings save also suspends old automatic callbacks until restart or a successful save. Save or discard pending Settings edits before **Sync now**, **Force push**, or **Force pull**. Manual Sync actions in Settings, the ribbon, Command Palette, status bar, and Sync Center refuse to run against the previously saved GitHub target while a draft differs or a save is pending. Force actions also refuse to open a confirmation until those edits are resolved. After saving, run **Sync now** manually. **If Sync fails**, the current plugin session pauses further automatic Sync attempts (startup, interval and local edits) rather than risking a duplicate remote write whose outcome is unknown. Edits from failed attempts remain queued; inspect Sync status and GitHub, then use **Sync now** explicitly to reconcile. A successful Manual Sync resumes automatic Sync. While paused, the status bar reads **GH Sync: Paused** and Sync Center shows **Failed · Auto-Sync paused** with guidance to review GitHub before clicking **Sync now**; successful Sync removes that warning. Restarting Obsidian creates a new session, so this pause is not a crash-persistent guarantee. Do not Force Push merely to clear an error. If a previously saved token or passphrase cannot be read after restart, Obsidian shows a notice to re-enter it in Settings rather than repeatedly trying an incomplete automatic Sync.
5.  **Device ID**: The device ID in Settings is a local identifier used by sync metadata and conflict copies, **not** the GitHub repository name. Fresh installations without saved plugin Settings receive a randomly generated `device-...` ID, which is persisted in local plugin Settings during initial setup or the first Settings Save. Obsidian's initial SecretStorage-ID migration can persist this ID before the user presses Save. Existing installations retain their previously saved ID, including the legacy `defaultVault` value. Keep each device ID unchanged after syncing, and use a distinct ID on every installation. Device ID must not be empty or only whitespace: Settings refuses to save an empty ID and manual/automatic/Force Sync remains blocked until you enter a Device ID and Save changes. Existing installations with an already saved blank ID can still open Settings to correct it; the plugin never silently assigns them a different identity. When copying a configured Vault to another device, set a new ID on that second installation before its first Sync. If the copied Vault includes the old device's local V4 index, normal Sync starts with fresh in-memory tracking for the new Device ID and rechecks GitHub; it does not trust the copied device's last-sync cache or overwrite that index merely by opening Settings. Changing an existing Device ID can cause notes to be re-evaluated for conflicts, so keep independent backups and do not use Force Push to bypass conflicts. On a copied Vault, normal first Sync compares unchanged notes to the current remote without publishing duplicate commits. If a copied note was edited before first Sync, the default **Copy** conflict policy retains the edited local note at its normal path and saves the previous remote contents as a separate `.conflict-remote-...` note; that conflict copy is also available to another device after Sync. Copy filenames keep ordinary Device IDs readable and use a stable short digest for unusual IDs containing unsafe characters or very long values; the actual saved Device ID remains unchanged. Long note basenames are shortened only for the conflict copy to satisfy cross-platform filename limits, while the original note stays untouched. The normal remote path may contain the edited version after reconciliation, so check the conflict copies before removing backups.
6.  **Safety and scope**: Choose a conflict policy, ignore-path regexes, a modification-percentage guard, and independent `.obsidian`, bookmark, and plugin scopes.

## 🔐 Encrypted Sync Mode

Encrypted mode hides every directory name, filename, extension, and file content. GitHub stores stable opaque objects in fixed technical buckets; the plugin reconstructs logical paths from authenticated encrypted metadata. Repositories created by the earlier encrypted V4 layout require a confirmed Force Push before normal sync or Force Pull.

Object sizes, commit timing, and plugin use may remain observable. Use the same passphrase on every device. GitHub tokens and passphrases are stored with Obsidian SecretStorage rather than in plugin `data.json`. Encrypted V4 must start on a new empty repository or branch. The plugin refuses to retain plaintext Git history while switching a populated branch to encryption. Existing V1/V2/V3 remotes must be replaced with an explicitly confirmed V4 Force Push; V4 Force Pull never guesses how to read a legacy layout.

When you save a new GitHub token or encryption passphrase, the plugin checks that Obsidian SecretStorage can read the new nonempty value back before committing Settings. If SecretStorage silently rejects the write, the save fails and the previous active credentials remain in use. This immediate check is not proof that a sudden crash or power loss cannot lose recent SecretStorage changes.

If **Save changes** fails, your unsaved Settings draft stays editable. Check your values, secure storage and any active Recovery state before retrying. The error Notice deliberately omits raw storage errors, which may contain credentials.

If Obsidian SecretStorage throws an error during startup (for example, while the operating system credential store is unavailable), the plugin opens Settings without loading unverified credentials. Automatic Sync and Settings saves remain disabled for that session. Restore access to the operating system credential store and restart Obsidian; do not replace the encryption passphrase just to bypass a temporary storage failure. The plugin keeps existing saved secret IDs and legacy settings unchanged for a safe retry.

### Encrypted Sync Controls

- Manual sync runs a normal pull-before-push operation immediately.
- Force push makes the V4 remote match the local vault; Force Pull mirrors the V4 remote locally and can delete files in scope. If visible local files change their path, size or modification time while the Force confirmation is open, the approval expires and you must review the current vault before confirming again. The confirmation also expires when Obsidian reports a visible file create, modify, delete or rename event, even if the file's size and modification time appear unchanged. Its temporary Vault-event listeners are removed when the confirmation closes; unrelated hidden Obsidian configuration changes do not invalidate the visible-file approval. These event and metadata checks remain best-effort, do not verify contents byte-for-byte, and do not replace a separate backup.
- Ignore regex rules match plaintext vault paths before encryption.
- A global five-second debounce coalesces create, edit, delete, and rename bursts into one commit. Large imports with many file events no longer abort event coalescing because of JavaScript argument limits; when a rescan is needed, ambiguous rename/delete events remain available for reconciliation. Repeated manual or force actions report that a sync is already running.
- New REST uploads above 8 MiB use ordered parts capped at 8 MiB (12 data parts for a 100,000,000-byte file), with full-file SHA-256 verification; older 48 MiB parts and larger historical single blobs remain readable. Encrypted packs are also capped at 8 MiB of ciphertext.
- The modification guard applies to normal and force operations. A blocked force operation requires a separate one-time override confirmation.

### Live Sync Status

The status bar shows the current sync phase with separate pull and push counts; its tooltip includes the complete logical vault path plus completed, total, and remaining work in each direction. The Sync Center keeps the same live status above commit and current-file history, including operation, trigger, attempt, failure context, total duration, and an ordered per-phase timing summary. Repeated phases aggregate their duration and display the number of attempts. If a saved GitHub owner, repository, branch, token, Device ID or required encryption passphrase is missing, **Commit history** and **Current file** identify the specific missing field labels without showing credentials or loading GitHub history; correct those fields in Settings, select **Save changes**, then open history again (or keep Current file open for automatic refresh). If V4 history is not initialized yet, Sync Center shows first-use guidance rather than a connection failure: on a **new empty branch**, click **Sync now** to initialize it normally; if the selected branch already has unrelated files or history, choose a **new empty branch** instead of forcing an overwrite. Merely opening Sync Center never starts a Sync. For other history failures, Sync Center shows a safe error without raw GitHub responses; check your connection in Settings, then select **Retry history**. Both **Commit history** and **Current file** offer **Refresh history** to fetch changes made by another device without running Sync or restarting Obsidian. Refreshing commits returns to the newest page, while **Retry history** after a page load failure stays on the failed page. Rapid repeated **Next** or **Previous** clicks cannot skip pages, and old paging controls stop working after switching views or closing Sync Center. These read-only actions do not modify local or remote files. When paging through Commit history, the selected commit details clear so only commits from the current page can be inspected, avoiding accidental confusion with the previous page. After a successful Settings Save, an open Sync Center clears history from the previous repository or branch and loads the saved target **without switching away from Current file versions** when that view is open. Responses from earlier history requests cannot replace the new target's history. When Sync finishes successfully or with no changes, the open Sync Center refreshes its current Commit history or Current file versions once, so the first uploaded note appears without manually reloading. When **Current file** is selected, opening another note or renaming/moving the active note in Obsidian automatically shows the current path's versions; unrelated renames or reopening the same note do not refetch history, and closing Sync Center stops tracking file changes. In **Current file**, versions appear newest first. Closing Sync Center, opening another note, switching views, or changing saved GitHub Settings stops further commit-page and journal downloads for the old version search after any in-flight request completes; the current HTTP request is not aborted. Select a historical text version and choose **Copy version text** to recover the preview to your clipboard without changing the Vault or GitHub; if clipboard access fails, select and copy the preview text manually. For a historical Markdown (`.md`) version, **Restore as new note** creates a distinct `Recovered-...md` file at the Vault root, choosing a numbered filename when needed and leaving the original note untouched. Its recovered filename preserves complete Unicode characters while bounding the sanitized basename in UTF-8 bytes for Windows and mobile. The action must be clicked explicitly and can create at most one file per preview; after successful creation, **Open recovered note** opens the saved file in a new Obsidian tab only if clicked. If creation is uncertain, inspect the Vault before reopening the preview to retry. The History reader uses strict UTF-8 for text versions and preserves a UTF-8 BOM when present. Invalid UTF-8 Markdown is shown as unreadable rather than offering a potentially corrupted copy or Restore, and the recovery writer validates the original bytes again before creating a note. It does not invoke Force Sync, but normal automatic Sync settings may upload the new note as usual. Keep independent backups. Progress timing updates and failed Sync runs do not trigger history reads. Failed Sync status, Notices and opt-in Debug Console output redact the configured GitHub token and encryption passphrase from error text while retaining useful failure context.

Corrupt or excessive remote history journal page counts stop History loading without fetching further pages. Historical previews enforce a 5 MiB decoded-content limit, reject invalid file sizes, and check single-blob sizes and chunked part totals from the Git tree before fetching Blob bytes. Chunked previews permit at most 256 unique parts and fetch them one at a time, including legacy encrypted parts. If a Blob response is larger than its Git tree metadata reports, the preview stops before fetching further parts; GitHub transport may still buffer that single oversized response before the check. Encrypted Pack history previews also require a known valid Git tree Blob size of at most 8 MiB, matching the current REST-safe Pack writer limit; larger legacy Packs can still be read by normal Sync but cannot be previewed. All preview limits are best-effort: the GitHub transport can buffer a mismatched oversized Blob response before the post-download check. This read-only check never changes GitHub or Vault files. Direct Git Blob downloads, including Contents API fallbacks, must match the requested Git object SHA-1 before use. Missing raw bytes, malformed object IDs, failed SHA calculation, or mismatched content stop the read instead of returning an unverified note.

Phase changes appear immediately. Rapid path and counter changes are published at most once every 400 ms, while an active phase's elapsed time refreshes once per second. The latest completed run remains visible until the next run begins. Logical paths and timing details exist only in runtime memory and are never saved to plugin settings, the local index, or GitHub.

## 🧪 Qualification status

V4 uses three separate evidence layers; one layer never substitutes for another:

- **Local deterministic release gates (no GitHub Actions)** cover model behavior, recovery/crash handling, bounded resources, source snapshots, cancellation, transport pacing, and compile the destructive real-GitHub E2E harness. The official Windows Task 15 automated gate and separate 2 GiB + 5 GiB cryptographic virtual soak are recorded as passed.
- **Live real-GitHub qualification** is a credentialed exact-SHA workflow against a dedicated disposable repository. It exercises plaintext/encrypted multi-device conflicts, branch-head races, exact Copy-policy lineage, and encrypted out-of-band mutation refusal. A commit is not described as live-qualified until that workflow's `qualify` and `cleanup` jobs actually succeed for the exact SHA.
- **Physical-device/large-file evidence** remains separate. The permanent physical test-file limit is 100,000,000 bytes, and an exact-size Windows Obsidian Force Push → no-op → second-instance Force Pull round trip is not claimed until it passes with the current pinned source SHA. Physical mobile acceptance remains separate.

For offline native Windows onboarding acceptance, `pnpm test:obsidian:offline-first-use:preflight` verifies the installed Obsidian and local build without creating a Vault; `pnpm test:obsidian:offline-first-use` then creates an entirely disposable Vault/Profile, verifies the fresh Device ID and Sync Center in real Obsidian, safely clicks **Sync now** with no GitHub configuration and verifies missing-field guidance without starting Runtime, edits the Device ID through the actual Settings input and **Save changes** button, then confirms the saved ID survives a real restart. It repeats the native onboarding flow in a second independently created Vault/Profile and verifies that the two fresh installations generate different random Device IDs, both saved identities survive their own restart, and neither test sends GitHub requests. No GitHub credentials are configured and no GitHub Sync is performed. See [D445 installed offline first-use smoke](docs/engineering/d445-installed-offline-first-use-2026-11-20.md). The native smoke also launches a third independent disposable Vault with a malformed legacy GitHub owner already persisted, verifies the plugin opens Settings without creating a GitHub client or rewriting data on startup, repairs the owner through the real Settings input and Save button, and verifies the correction survives restart without GitHub credentials. It rejects both invalid and empty GitHub branch input before persistence, then clicks **Restore as new note** in the installed Sync Center using a synthetic history preview, verifies Obsidian creates a collision-safe Markdown copy without overwriting the existing notes or duplicating on a double-click, and proves the files persist after a process restart. The native smoke also verifies **Open recovered note** is offered only after the file exists, opens that saved note on explicit click in Obsidian, and does not alter its content. The native smoke also checks byte-for-byte preservation of UTF-8 BOM, Unicode and CRLF in a restored Markdown file across an actual Obsidian restart, and confirms malformed UTF-8 Markdown offers neither text copy nor Restore. These checks exercise the installed UI, navigation and Vault API using synthetic history, **not** a credentialed GitHub history download. The smoke is not a substitute for disposable live-GitHub or Android/iOS acceptance.

The historical 48 MiB part format is **read compatibility only**: new GitHub REST writes use empirically verified 8 MiB parts, plus an enforced per-revision mutation budget. Files too large for the budget fail closed rather than automatically generating unsafe request sizes. See [the GitHub Free operational model](docs/engineering/v4-github-free-operational-model.md) for historical comparisons.

See [real GitHub E2E qualification](docs/github-e2e.md), [release procedure](docs/releasing.md), [Windows/Android validation](docs/testing/v4-windows-android-validation.md), and [performance methodology](docs/engineering/v4-performance-methodology.md) for the evidence rules.

## ❓ FAQ

For detailed information about synchronization mechanisms, incremental sync, and conflict resolution, please refer to our [FAQ Document](docs/FAQ.md).

---

<a name="chinese"></a>

## 🚀 项目简介

**Encrypted GitHub Sync (Multi-Platform)** 是一款高性能、无服务器同步方案。它直接利用 GitHub REST API，在桌面端（Windows/macOS/Linux）与移动端（iOS/Android）之间提供流畅的实时笔记同步体验。

与传统的基于 Git 命令行工具的插件不同，本项目通过 API 直接操作，在移动端无需安装 Git 环境，运行更轻快、更稳定。

### ✨ 核心特性

-   **无需 Git 的移动端支持**：普通大小的文件通过 Obsidian API 同步；当平台缺少经过验证的有界读取/提交能力时，大文件会安全地提示能力不足，不会退化成数 GiB 的整文件内存读取。
-   **实时自动同步**：智能监听文件修改事件，内置 5 秒防抖（Debounce）逻辑，平衡实时性与 API 调用额度。
-   **无服务器架构**：数据直接点对点传输至您的私有 GitHub 仓库，隐私安全。
-   **冲突检测**：基于内容哈希的智能检测，最大限度减少同步冲突。
-   **全部文件类型**：同步笔记、图片、压缩包、Canvas 与其他附件；V4 远端格式会将超过 50 MiB 的内容拆分并校验。桌面端使用有界本地 I/O；移动端大文件上传在有界读取能力得到验证前保持能力门控。
-   **可选加密**：隐藏所有目录名、文件名、扩展名和文件内容，并在固定技术分桶中保存稳定的不透明对象；明文模式直接保存原路径与内容。
-   **同步中心**：分页查看提交、变更列表，以及按需加载的提交/当前文件历史预览。
-   **可视化看板**：配套数据看板，直观展示写作进度与同步状态。

## 🛠 技术架构

-   **核心**: TypeScript, Plugin API.
-   **UI 框架**: 原生 CSS, Obsidian 内置设置组件.
-   **通信**: GitHub REST API (v3).
-   **构建工具**: esbuild 极速打包.

## 📥 安装方式

1.  打开 **设置** > **第三方插件**。
2.  关闭 **安全模式**。
3.  点击 **浏览** 并搜索 `Encrypted GitHub Sync (Multi-Platform)`。
4.  点击 **安装**，随后 **启用**。

*(或从 Release 页面下载最新版本，将 `main.js`、`manifest.json`、`styles.css` 放入 `.obsidian/plugins/encrypted-github-sync-multi-platform/` 目录)*

## ⚙️ 配置指南

1.  **GitHub 令牌**: 访问 [GitHub Settings](https://github.com/settings/tokens) 生成一个具有 `repo` 权限的个人访问令牌 (PAT)。
2.  **仓库配置**:
    -   **Owner**: 您的 GitHub 用户名.
    -   **Repo**: 您的私有笔记仓库名称.
    -   **Branch**: 默认为 `main`.
3.  **Sync Options**: 开启“启用同步”即可享受实时同步体验.

## 🧪 资格验证状态

V4 将证据分为三个互不替代的层级：**确定性 CI/发布门禁**负责模型、恢复、资源上限、取消与构建验证；**真实 GitHub 资格验证**使用独立一次性仓库，对精确 commit SHA 运行多设备冲突、分支竞争、Copy 策略身份链以及加密分支外部修改拒绝；只有对应 SHA 的 `qualify` 与 `cleanup` 都实际成功后，才称该提交通过真实 GitHub 验证。**物理设备/超大文件证据**仍单独记录，自动化或真实 GitHub 小中型测试都不能替代 5 GiB 真实设备完整链路。

Windows 物理加密 5 GiB 仍需在 `tests/baselines/v4/windows.json` 记录完整 Force Push → no-op → clean-vault Force Pull → SHA-256 相等后才能宣称通过。Android 当前没有受支持的多 GiB 有界本地读取/最终 stage-commit 路径，因此不宣称 Android 5 GiB 支持。详细规则见 [真实 GitHub E2E](docs/github-e2e.md)、[发布流程](docs/releasing.md) 和 [Windows/Android 验证](docs/testing/v4-windows-android-validation.md)。

## ❓ 常见问题 (FAQ)

关于同步机制、增量同步以及多设备冲突处理的详细说明，请参阅 [常见问题解答 (FAQ)](docs/FAQ.md)。

---

## 💖 Support / 支持

If this plugin has helped you with multi-device synchronization, please consider supporting the project. Your contribution keeps the development alive!

如果这个插件解决了您的多端同步需求，请考虑支持我一下。您的支持是持续开发的最大动力！

| Ko-fi (International / 国际) | WeChat (China / 微信支付) |
| :---: | :---: |
| [<img src="docs/images/kofi.png" height="36" alt="Buy Me a Coffee at ko-fi.com" />](https://github.com/crystalicez) | <img src="docs/images/qrcode.png" width="180" alt="WeChat Support" /> |

---

## 📄 License

Apache-2.0 © [Crystalicez](https://github.com/crystalicez)
