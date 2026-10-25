# ZError 上游与 OCS 兼容性检查

核对日期：2026-10-25。上游：[Miaozeqiu/ZError](https://github.com/Miaozeqiu/ZError)，默认分支 `master`。

## ZError 近期变动

当前分支头为 [`9a05051355c0627c5928175bc73a9afb5aada7b0`](https://github.com/Miaozeqiu/ZError/commit/9a05051355c0627c5928175bc73a9afb5aada7b0)，提交于 2026-10-22。

当日曾合入 [PR #37](https://github.com/Miaozeqiu/ZError/pull/37)，主要包含：

- [全局联网搜索 MCP](https://github.com/Miaozeqiu/ZError/commit/08f444cb196370e1e58821c0725186701cd3bd05)：AI 答题前统一搜索，支持远程 HTTP 和本地 stdio MCP，在请求详情展示结果。
- [Windows 云端构建与 Release](https://github.com/Miaozeqiu/ZError/commit/c61db1533f7fb2f15da51d9d04b26fe12ff91778)：推送版本标签时构建 NSIS 安装包，并曾将版本升至 2.2.8。
- [搜索超时、请求取消修复](https://github.com/Miaozeqiu/ZError/commit/4b961c5f19d2df1b567f085723f05ab6d4f4dfb6)，以及相关生命周期测试。

但当天后续的 `9a050513` 已**完整回退这次合并**：删除 MCP 模块、搜索设置页、相关测试与两份 GitHub Actions 工作流，并撤销对应版本与依赖改动。不能将这些功能或 2.2.8 当作上游当前仍保留的功能与版本。

本地 `git merge-base HEAD FETCH_HEAD` 得到共同分叉点 `7bb9e4457952a85f008dfc0ce6e3b3bf92fea302`。GitHub [比较结果](https://github.com/Miaozeqiu/ZError/compare/7bb9e4457952a85f008dfc0ce6e3b3bf92fea302...9a05051355c0627c5928175bc73a9afb5aada7b0)与本地 `git diff` 一致：提交历史有推进，但文件净差异为零。因此本次没有需要同步的上游净改动，也没有合并已撤销的功能。

截至检查时，GitHub Releases 最新公开条目仍为 [v2.2.5（2026-05-17）](https://github.com/Miaozeqiu/ZError/releases/tag/v2.2.5)。公开 Release 与源码分支进度应分别看待。

## OCS 当前脚本

- 来源：[用户提供的 CDN 地址](https://cdn.ocsjs.com/ocs.user.js)。
- 本次下载版本：**5.2.3**。
- SHA-256：`254802aec93a17ba6b4092eee8074ab9a8fe9a76fa86522a1469f2d729ee94de`。
- 从下载的脚本中提取实际 `defaultAnswerWrapperHandler`，连接 AnswerNest 1.3.0 release 程序的 HTTP 题库服务。
- 验证 HEAD 探测、配置端口、题干与选项优化字段、Base64 图片、多模型分歧总结、重复题命中缓存，全部通过。

此次为实际脚本 handler 与桌面 HTTP 服务的协议验证，模型上游使用本地模拟响应；未登录具体网课网站运行完整 OCS 脚本。
