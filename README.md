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

-   **Native Mobile Support**: Full compatibility with iOS and Android without requiring Git binaries.
-   **Real-time Auto-Sync**: Intelligent event listening triggers synchronization on file modification with a 5-second debounce to optimize API usage.
-   **Serverless Architecture**: No middle-man server required. Your data goes directly to your private GitHub repository.
-   **Atomic two-way sync**: Pulls first, plans with a three-way index, and publishes all required remote updates in one Git commit.
-   **All vault file types**: Syncs notes, media, archives, Canvas files, and other files. Files over 50 MiB are split into verified parts automatically.
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

## ❓ FAQ

For detailed information about synchronization mechanisms, incremental sync, and conflict resolution, please refer to our [FAQ Document](docs/FAQ.md).

---

<a name="chinese"></a>

## 🚀 项目简介

**Encrypted GitHub Sync (Multi-Platform)** 是一款高性能、无服务器同步方案。它直接利用 GitHub REST API，在桌面端（Windows/macOS/Linux）与移动端（iOS/Android）之间提供流畅的实时笔记同步体验。

与传统的基于 Git 命令行工具的插件不同，本项目通过 API 直接操作，在移动端无需安装 Git 环境，运行更轻快、更稳定。

### ✨ 核心特性

-   **原生移动端支持**：完美适配 iOS 和 Android，无需复杂的 Git 环境配置。
-   **实时自动同步**：智能监听文件修改事件，内置 5 秒防抖（Debounce）逻辑，平衡实时性与 API 调用额度。
-   **无服务器架构**：数据直接点对点传输至您的私有 GitHub 仓库，隐私安全。
-   **冲突检测**：基于内容哈希的智能检测，最大限度减少同步冲突。
-   **全部文件类型**：同步笔记、图片、压缩包、Canvas 与其他附件；超过 50 MiB 的文件会自动拆分并校验。
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
    -   **Owner**: 您的 GitHub 用户名。
    -   **Repo**: 您的私有笔记仓库名称。
    -   **Branch**: 默认为 `main`。
3.  **Sync Options**: 开启“启用同步”即可享受实时同步体验。

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
