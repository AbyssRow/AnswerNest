<div align="center">
  <img src="docs/logo.png" alt="AnswerNest Logo" width="128">
  <br>
  <h2>AnswerNest</h2>
  <span>支持 OCS 网课助手的 AI 题库管理软件</span>
</div>

> AnswerNest 基于 [Miaozeqiu/ZError](https://github.com/Miaozeqiu/ZError) 修改而来，遵循 MIT 许可证。感谢原作者的开源工作。

## 项目简介

AnswerNest 是一款专为 OCS 网课助手设计的 AI 题库软件，可以方便地为 OCS 网课助手搭建**本地** AI 题库：OCS 提问 → 先查本地题库 → 没有再问 AI → 答案存回题库。软件基于 Tauri 开发，数据都在你自己的电脑上。

## 主要功能

- **先选提供商再填 Key**：内置 OpenAI、Anthropic、Gemini、DeepSeek、通义百炼、Kimi、智谱、OpenRouter 等常用提供商，也可以添加**自定义提供商**，只要兼容 OpenAI（Chat / Responses）或 Anthropic 标准 API 就能接入，适合各种中转站
- 按各家官方文档适配模型参数（思考开关、强度、采样限制等），中转站同样按模型名套用官方规则
- 提供商独立的 HTTP(S) / SOCKS5 代理和自定义请求头
- 上游异步 Batch API：OpenAI、Anthropic、Mistral、Groq、通义百炼、OpenRouter
- 图片题：OCS 的图片优化可以把图片一起发给支持视觉的模型
- 答题流程：所有答题模型完成后，答案一致直接提交；答案不一致时，用 Firecrawl、Exa 或 DeepSeek 搜索，再把答题结果和搜索资料一起交给总结模型，提交最终答案（需选择总结模型，搜索需开启并填写 Key）
- 本地题库管理与缓存：题目编辑、文件夹分类、导入导出

## 更干净

AnswerNest 把原项目里依赖作者服务器、带推广性质的部分都去掉了，应用本身不会连接任何作者的服务器：

- **不联网同步目录**：不会从任何服务器下载平台和模型列表。平台由你在「添加平台」里选择，数据只存在本地
- **不执行远程下发的代码**：删除了「云控」机制（原来会从服务器下载一段 JavaScript 来解析图片链接并直接执行），图片链接解析只用本地实现
- **没有广告和推广入口**：没有「校园题库」等外链，没有邀请码和邀请文案
- **没有自动更新**：不内置更新服务器，也不会静默替换程序；新版本请到 [Releases](https://github.com/AbyssRow/AnswerNest/releases) 下载
- **联网范围一目了然**：只会访问你自己配置的 AI 提供商（以及你填的代理，和你自己开启的搜索服务），和题目里带的图片 / 附件链接。获取 API Key 的链接直接指向各提供商自己的页面

## 快速开始

1. 设置 → 模型设置 → 点右上角 **+**，选一个提供商，填 API Key
2. 添加模型（或选已有的），在列表里勾选用于**答题**的模型
3. 回到首页点**启动**，复制弹出的 OCS 题库配置，粘贴到 OCS 的题库设置里

### 在 Windows 与 Mac 之间迁移配置

在「设置 → 常规设置 → 配置导入导出」点击「导出配置」，将生成的 JSON 文件复制到另一台电脑，在同一位置点击「导入配置」，核对平台和模型数量后确认导入。

配置包含所有 AI 平台、API Key、自定义请求头、代理、模型参数及答题／总结模型选择，也包含各搜索服务的独立连接配置和常规设置。文件含明文密钥，请妥善保管。不包含本地题库、窗口大小／位置或题库保存文件夹；这些保留目标电脑上的值。导入会覆盖文件中的配置，若题库服务正在运行，请在导入后停止并重新启动服务。

详细的提供商、代理、参数和 Batch 说明见 [模型提供商、代理、参数与 Batch API 配置](docs/model-providers.md)。

## 局域网访问

默认只监听本机（`127.0.0.1`）。在「常规设置」里打开局域网访问后会监听 `0.0.0.0`，同一网络里的设备都能访问题库服务，并用你的 AI 额度答题。题库查询接口**没有鉴权**，请只在可信的网络里开启，并配合防火墙使用。

## 系统要求

| 平台 | 系统版本 | 安装包架构 |
| --- | --- | --- |
| Windows | Windows 10 / 11 | x64 |
| Intel Mac | macOS 10.15 及以上 | x64 |
| Apple Silicon Mac（M 系列） | macOS 11 及以上 | ARM64（`aarch64`） |

macOS 版本号为安装包的最低部署目标，较旧系统的兼容性仍需实测。Intel 版已通过 Mac 实机运行验证；ARM64 版已完成交叉编译、架构、签名与安装包校验，尚待 Apple Silicon 实机运行验证。

## 安装方法

前往 [最新 Release](https://github.com/AbyssRow/AnswerNest/releases/latest) 下载对应平台的安装包。当前版本为 **1.4.1**：

| 平台 | 下载 |
| --- | --- |
| Windows x64 | [AnswerNest_1.4.1_x64-setup.exe](https://github.com/AbyssRow/AnswerNest/releases/download/v1.4.1/AnswerNest_1.4.1_x64-setup.exe) |
| Intel Mac | [AnswerNest_1.4.1_x64.dmg](https://github.com/AbyssRow/AnswerNest/releases/download/v1.4.1/AnswerNest_1.4.1_x64.dmg) |
| Apple Silicon Mac（M 系列） | [AnswerNest_1.4.1_aarch64.dmg](https://github.com/AbyssRow/AnswerNest/releases/download/v1.4.1/AnswerNest_1.4.1_aarch64.dmg) |

Release 同时提供 [SHA256SUMS.txt](https://github.com/AbyssRow/AnswerNest/releases/download/v1.4.1/SHA256SUMS.txt)，可用于核对下载文件的 SHA-256。

### Windows

运行 `.exe` 安装程序，按提示完成安装。安装包未经代码签名，Windows 可能提示「未知发布者」，确认下载来源后可点「更多信息 → 仍要运行」。

### macOS

1. 在「关于本机」中查看芯片类型：Intel 下载 `x64.dmg`，Apple M 系列下载 `aarch64.dmg`
2. 打开 `.dmg`，将 **AnswerNest.app** 拖入「应用程序」文件夹；升级时先退出正在运行的 AnswerNest，再替换应用
3. 从「应用程序」启动 AnswerNest。关闭主窗口后，默认仍会在菜单栏运行，可通过菜单栏图标显示窗口或退出，也可以点击 Dock 图标恢复窗口

macOS 安装包使用本地临时签名（ad-hoc），尚未进行 Apple Developer 签名和公证，首次打开可能出现开发者验证提示。替换应用不会清除下方列出的题库和配置目录。

### 在 Mac 上打包

需在 macOS 上安装 Node.js（版本见 [`.node-version`](.node-version)，可用 fnm 管理）、Rust 和 Xcode Command Line Tools。桌面构建前置依赖见 [Tauri 官方说明](https://v2.tauri.app/start/prerequisites/#macos)。

获取源码并安装前端依赖：

```sh
git clone https://github.com/AbyssRow/AnswerNest.git
cd AnswerNest
npm ci
```

按目标架构分别构建：

```sh
# Intel Mac
rustup target add x86_64-apple-darwin
npm run tauri:build:mac -- --target x86_64-apple-darwin

# Apple Silicon Mac（包括从 Intel Mac 交叉编译）
rustup target add aarch64-apple-darwin
npm run tauri:build:mac -- --target aarch64-apple-darwin --config '{"bundle":{"macOS":{"minimumSystemVersion":"11.0"}}}'
```

`.app` 和 `.dmg` 分别生成在 `src-tauri/target/<目标架构>/release/bundle/macos/` 和 `src-tauri/target/<目标架构>/release/bundle/dmg/`。其中 `<目标架构>` 为 `x86_64-apple-darwin` 或 `aarch64-apple-darwin`。交叉编译不等于目标机器上的运行验证，发布前应在对应架构的 Mac 上测试。

### 数据和配置位置

| 平台 | 数据目录 |
| --- | --- |
| Windows（1.1.0 起） | `%LOCALAPPDATA%\AnswerNest` |
| macOS | `~/.local/share/answernest` |

目录中包含题库 `airesponses.db`、常规配置 `config.json` 和模型配置 `model_config.json`。完整备份时，请先退出应用，再复制整个目录；只迁移配置可使用软件内的「配置导入导出」。配置文件包含你填写的 API Key，请妥善保管。

升级后首次读取配置时，如果数据目录没有对应文件，会从程序同级目录复制旧的 `config.json` 和 `model_config.json`，保留原文件；数据目录已有的配置优先。

### Windows 从 ZError 迁移

首次启动时，如果检测到旧版数据目录（`%LOCALAPPDATA%\ZError`），会自动把题库、设置和模型配置**复制**到 `%LOCALAPPDATA%\AnswerNest`，旧目录原样保留，不会被删除。

旧版从服务器同步下来的「内置平台」会转成普通平台：你填过 API Key 或添加过自己模型的会保留，并且可以随意编辑和删除；从没配置过的会被清掉。

## 许可证

本项目采用 MIT 许可证，保留上游 ZError 的版权声明，见 [LICENSE](LICENSE)。
