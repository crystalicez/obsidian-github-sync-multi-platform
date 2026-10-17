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
-   **Sync Center**: View a read-only, verified remote file inventory with All / Changed / Local only / Remote / Synced filters, path search, expandable tree view, and current-file/commit version history.

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
    -   **Branch**: Typically `main`.
3.  **Sync Options**: Configure startup, five-second debounced local-change, and interval synchronization independently.
4.  **Safety and scope**: Choose a conflict policy, ignore-path regexes, a modification-percentage guard, and independent `.obsidian`, bookmark, and plugin scopes.

## 🔐 Encrypted Sync Mode

Encrypted mode hides every directory name, filename, extension, and file content. GitHub stores stable opaque objects in fixed technical buckets; the plugin reconstructs logical paths from authenticated encrypted metadata. Repositories created by the earlier encrypted V4 layout require a confirmed Force Push before normal sync or Force Pull.

Object sizes, commit timing, and plugin use may remain observable. Use the same passphrase on every device. GitHub tokens and passphrases are stored with Obsidian SecretStorage rather than in plugin `data.json`. Encrypted V4 must start on a new empty repository or branch. The plugin refuses to retain plaintext Git history while switching a populated branch to encryption. Existing V1/V2/V3 remotes must be replaced with an explicitly confirmed V4 Force Push; V4 Force Pull never guesses how to read a legacy layout.

### Encrypted Sync Controls

- Manual sync runs a normal pull-before-push operation immediately.
- Force push makes the V4 remote match the local vault; Force Pull mirrors the V4 remote locally and can delete files in scope.
- Ignore regex rules match plaintext vault paths before encryption.
- A global five-second debounce coalesces create, edit, delete, and rename bursts into one commit. Repeated manual or force actions report that a sync is already running.
- Encrypted batches use bounded packs for large file counts; payloads over 50 MiB use ordered 48 MiB parts with full-file hash verification.
- The modification guard applies to normal and force operations. A blocked force operation requires a separate one-time override confirmation.

### Live Sync Status

The status bar shows the current sync phase with separate pull and push counts; its tooltip includes the complete logical vault path plus completed, total, and remaining work in each direction. The Sync Center keeps the same live status above commit and current-file history, including operation, trigger, attempt, failure context, total duration, and an ordered per-phase timing summary. Repeated phases aggregate their duration and display the number of attempts.

Phase changes appear immediately. Rapid path and counter changes are published at most once every 400 ms, while an active phase's elapsed time refreshes once per second. The latest completed run remains visible until the next run begins. Logical paths and timing details exist only in runtime memory and are never saved to plugin settings, the local index, or GitHub.

### Files overview and interactive conflict review (unreleased audit branch)

Open **GitHub Sync Center → Files** after configuring a repository. File statuses are read-only; use **Refresh status** to query the current exact GitHub branch snapshot. **All**, **Changed**, **Local only**, **Remote** and **Synced** filters work with path search, expandable folders, and a flat-list toggle. **No per-file Remove or bulk Delete (N) buttons are provided or planned** in this read-only Files view. Use **Sync now** for the existing full-sync workflow and its safeguards; normal sync can propagate deletions or restore content depending on the last synchronized state. This does not remove existing V4 sync deletion handling.

**Changed** also includes *previously synchronized files that were deleted on only one side*. Select the file to see **Deleted locally** or **Deleted remotely** and a warning before syncing. **Synced** means the current file metadata matches the last synchronized index (size, mtime and remote version), **not** a fresh byte-for-byte file hash verification. The overview reflects a particular remote commit SHA; it is not a continuously live view.

For manual conflict resolution, choose the **Ask** conflict policy in Settings. Small UTF-8 text conflicts display Local and Remote side by side on desktop, or stacked in a narrow view. **Each changed line** has its own **Keep / Omit** decision, so you can combine individual lines from the same diff hunk instead of accepting an entire block. Whole-hunk shortcuts remain available. After reviewing all changed lines, you can **edit the merged result directly** (including changing the order or adding text), and **Apply reviewed merge** uses that exact visible text; manual edits are preserved when further line decisions change unless you explicitly reset them. **Keep both**, **Use local**, **Use remote** and **Cancel** remain available as whole-file decisions. Files that are binary, oversized or too complex for bounded line review use those whole-file choices instead. The UI does not bypass publication validation, cancellation or the change guard. See [per-line conflict UI acceptance](docs/engineering/conflict-line-merge-2026-10-17.md).

See [engineering UI qualification and limitations](docs/engineering/file-status-and-conflict-review-2026-10-17.md). These changes are in draft PR #8 and are **not a published release qualification**.

## 🧪 Qualification status

V4 uses three separate evidence layers; one layer never substitutes for another:

- **Deterministic CI/release gates** cover model behavior, recovery/crash handling, bounded resources, source snapshots, cancellation, transport pacing, and compile the destructive real-GitHub E2E harness. The official Windows Task 15 automated gate and separate 2 GiB + 5 GiB cryptographic virtual soak are recorded as passed.
- **Live real-GitHub qualification** is a credentialed exact-SHA workflow against a dedicated disposable repository. It exercises plaintext/encrypted multi-device conflicts, branch-head races, exact Copy-policy lineage, and encrypted out-of-band mutation refusal. A commit is not described as live-qualified until that workflow's `qualify` and `cleanup` jobs actually succeed for the exact SHA.
- **Physical-device/large-file evidence** remains separate. A physical encrypted 5 GiB Windows Force Push → no-op → clean-vault Force Pull round trip is not claimed until recorded in `tests/baselines/v4/windows.json`. Android currently lacks a supported bounded local read/final-stage-commit path for multi-gigabyte files, so Android 5 GiB is not a supported claim.

The current 48 MiB-part model for one 5 GiB revision is 107 data parts and about 114 modeled content/publication mutations with a minimum policy pacing floor of 113 seconds. Repeated full encrypted 5 GiB revisions are operationally limited by repository growth; see [the GitHub Free operational model](docs/engineering/v4-github-free-operational-model.md).

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
-   **同步中心**：可在“Files”中按 All / Changed / Local only / Remote / Synced 过滤已验证的远端文件快照，支持路径搜索、树形目录和展开/收起；保留提交与当前文件历史预览。
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

### 文件状态与交互式冲突处理（尚未发布的审计分支）

配置好仓库后，在 **GitHub Sync Center → Files** 查看只读文件状态。可筛选、搜索路径、使用树形/平铺列表，并手动刷新。**Changed** 包含以前已同步但仅在本地或远端被删除的文件：详情将提醒后续同步可能传播删除。**Synced** 只代表大小、修改时间和远端版本等元数据与上次同步索引一致，**不等于重新逐字节校验内容**。单文件 Push/Pull/Delete 功能尚未开放；**Sync now** 仍执行现有完整同步策略。

在设置中选择 **Ask** 冲突策略，小型 UTF-8 文本可在桌面端并排（窄窗口纵向）查看差异，逐段选择本地、远端、两者或丢弃两者，并确认合并预览后应用。二进制和大文件仍使用 Keep both / Use local / Use remote / Cancel 整文件选项。此功能位于 Draft PR #8，尚不代表正式发布或移动端真机验证。

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
