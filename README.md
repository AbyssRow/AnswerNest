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
- 总结时联网搜索：OpenRouter 的模型可以在被选为总结模型时先联网搜索这道题，再整理最终答案（普通答题不联网）
- 本地题库管理与缓存：题目编辑、文件夹分类、导入导出

## 更干净

AnswerNest 把原项目里依赖作者服务器、带推广性质的部分都去掉了，应用本身不会连接任何作者的服务器：

- **不联网同步目录**：不会从任何服务器下载平台和模型列表。平台由你在「添加平台」里选择，数据只存在本地
- **不执行远程下发的代码**：删除了「云控」机制（原来会从服务器下载一段 JavaScript 来解析图片链接并直接执行），图片链接解析只用本地实现
- **没有广告和推广入口**：没有「校园题库」等外链，没有邀请码和邀请文案
- **没有自动更新**：不内置更新服务器，也不会静默替换程序；新版本请到 [Releases](https://github.com/AbyssRow/AnswerNest/releases) 下载
- **联网范围一目了然**：只会访问你自己配置的 AI 提供商（以及你填的代理），和题目里带的图片 / 附件链接。获取 API Key 的链接直接指向各提供商自己的页面

## 快速开始

1. 设置 → 模型设置 → 点右上角 **+**，选一个提供商，填 API Key
2. 添加模型（或选已有的），在列表里勾选用于**答题**的模型
3. 回到首页点**启动**，复制弹出的 OCS 题库配置，粘贴到 OCS 的题库设置里

详细的提供商、代理、参数和 Batch 说明见 [模型提供商、代理、参数与 Batch API 配置](docs/model-providers.md)。

## 局域网访问

默认只监听本机（`127.0.0.1`）。在「常规设置」里打开局域网访问后会监听 `0.0.0.0`，同一网络里的设备都能访问题库服务，并用你的 AI 额度答题。题库查询接口**没有鉴权**，请只在可信的网络里开启，并配合防火墙使用。

## 系统要求

- Windows 10 / 11

## 安装方法

1. 从 [Releases](https://github.com/AbyssRow/AnswerNest/releases) 下载最新版本（也可自行克隆源码，用 `npm run tauri:build` 构建）
2. 运行安装程序。安装包未经代码签名，Windows 可能提示「未知发布者」，点「更多信息 → 仍要运行」
3. 运行软件

### 从 ZError 迁移

首次启动时，如果检测到旧版数据目录（`%LOCALAPPDATA%\ZError`），会自动把题库、设置和模型配置**复制**到 `%LOCALAPPDATA%\AnswerNest`，旧目录原样保留，不会被删除。

旧版从服务器同步下来的「内置平台」会转成普通平台：你填过 API Key 或添加过自己模型的会保留，并且可以随意编辑和删除；从没配置过的会被清掉。

## 许可证

本项目采用 MIT 许可证，保留上游 ZError 的版权声明，见 [LICENSE](LICENSE)。
