

<div align="center">
  <img src="docs/logo.png" alt="AnswerNest Logo" width="128">
  <br>
  <h2>AnswerNest</h2>
  <span>支持OCS网课助手的AI题库管理软件</span>
</div>

> AnswerNest 基于 [Miaozeqiu/ZError](https://github.com/Miaozeqiu/ZError) 修改而来，遵循 MIT 许可证。
> 感谢原作者的开源工作；下文截图来自上游项目，界面与本版本可能略有差异。

## 项目简介

AnswerNest是一款专为OCS网课助手设计的AI题库软件，可以方便地为OCS网课助手搭建本地AI题库。软件由Tauri架构开发，支持AI平台以及模型的自定义。

![软件首页](https://free.picui.cn/free/2025/11/09/691031b4dd824.png)

## 主要功能

- OCS题库配置
- 自定义AI供应商以及AI模型
- 提供商独立 HTTP(S) / SOCKS5 代理、自定义请求头与高级模型参数
- 上游异步 Batch API（OpenAI 兼容、Anthropic、Mistral）
- 本地题库管理与缓存

## 题库管理

软件内置题库管理功能，支持题目编辑，文件夹分类。

![题库页面](https://free.picui.cn/free/2025/11/09/691031f9db6f9.png)

## 使用教程

[模型提供商、代理、参数与 Batch API 配置](docs/model-providers.md)

https://www.bilibili.com/video/BV12PSQBLE5G

## 系统要求

- Windows 10/11

## 安装方法

1. 从 [Releases](https://github.com/AbyssRow/AnswerNest/releases) 下载最新版本（也可自行克隆源码用 `npm run tauri:build` 构建）
2. 运行安装程序
3. 运行软件

从 ZError 迁移：首次启动时，如果检测到旧版数据目录（`%LOCALAPPDATA%\ZError`），会自动把题库、设置和模型配置**复制**到 `%LOCALAPPDATA%\AnswerNest`，旧目录原样保留，不会被删除。

## 许可证

本项目采用MIT许可证
