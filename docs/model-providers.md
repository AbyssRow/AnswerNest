# 模型提供商、代理与 Batch API

## 使用入口

- 设置 → 模型设置 → 右上角 **+**：先**选择提供商**（国际 / 国内 / 聚合网关 / 本地分组，可搜索）。已知提供商只需填 API Key，名称、接口地址、代理、请求头都收在「更多设置」里。
- 没有你要的提供商时选 **自定义提供商**：说明它兼容哪种标准 API（OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages），再填接口地址和 API Key。自定义提供商默认不启用 Batch，也不会按地址套用其他厂商的参数方言；需要时可在模型的「更多参数」里手动选兼容方言。
- 添加 / 编辑本地模型：新模型默认使用所选提供商的 API 协议。**思考**相关设置（开关、Anthropic 的思考方式、强度、预算）集中在一组里；预算只在支持它的提供商（Anthropic、通义百炼、硅基流动、自定义提供商）上出现。**更多参数**里是 Token 上限、Temperature、Top P、频率 / 存在惩罚、随机种子、停止序列、Top K，以及额外 JSON 参数和省略字段。
- 模型右键 → **批量处理（Batch）**：只在有公开 Batch API 的提供商上出现（OpenAI、Anthropic、Mistral、Groq、通义百炼、OpenRouter）。选好模型，每行一个问题，提交后可关闭窗口，之后回来刷新状态、下载结果。

所有平台和模型都只保存在本地，可以随意编辑和删除；应用不会从任何服务器同步平台或模型目录。旧版同步下来的内置平台升级后会转成普通平台（填过 Key 或加过自己模型的保留，没配置过的清掉）。

## 网络与参数

代理支持 `http://`、`https://`、`socks5://`、`socks5h://`。空值沿用系统 / 插件默认行为，不表示强制直连。代理地址可以包含用户名和密码，按现有模型配置方式保存。代理覆盖答题和总结的上游请求、模型测试、模型列表，以及 Batch 上传、查询、取消和下载；不会改动本地题库服务器、更新检查或题目图片、附件文件下载的网络设置。

API Base URL 可以是根地址、带版本号的地址、网关前缀或完整 Chat / Responses / Messages 端点。根地址默认补 `/v1`，已有路径原样保留，不会重复追加 `/v1`；查询参数也保留。需要其他版本的上游应使用下表中的完整基础路径。

参数优先级：协议默认参数 → 上游适配 → 额外 JSON 参数（顶层合并）→ 省略字段。模型 ID、消息 / input 和流式开关由调用方控制，参数表单不允许覆盖或删除这些字段。

例如，输出 JSON 可在支持它的 Chat 模型上填写：

```json
{"response_format":{"type":"json_object"}}
```

要让服务器决定采样值，在省略字段中填写 `temperature,top_p`。Responses 使用 `max_output_tokens`，OpenAI 已知推理模型的 Chat 使用 `max_completion_tokens`。Anthropic 默认不发送采样参数；若所用模型支持，可通过额外参数显式设置。

开启思考不是所有模型都支持的开关：部分模型始终思考，部分不返回思考文本。自动适配只按官方域名和已知模型规则判断；中转、自建网关可手动选择上游适配，或用 `compatible` 与额外参数自行配置。自定义 JavaScript 仍需自行读取 config 中的参数，提供商代理则仍作用于传入的 fetch。

## 上游差异与官方参考

以下是本次实现覆盖的请求适配，不代表每个上游的每款模型都支持全部参数。核对日期：2026-10-16；模型能力仍由各提供商决定。

| 提供商 | API Base URL | 本次处理 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | Chat / Responses，GPT-5 / GPT-6 与 o 系列按推理模型处理（`max_completion_tokens`、不发采样参数，GPT-6 的强度可到 max，关闭思考时不发 none / minimal），普通模型不发送非标准思考参数 |
| Anthropic | `https://api.anthropic.com/v1` | `x-api-key`、`anthropic-version`，system 消息，工具与图像格式；思考按模型分别处理：4.7 及之后的模型（含 Haiku 5.5、Fable、Mythos）只支持自适应，旧模型和非 Claude 的兼容端点用固定预算；关不掉的模型（Opus 5.5、Fable、Mythos）不发 thinking，Sonnet 5.5 用 `between_tools`，Opus 5 / Sonnet 5 / Haiku 5.5 用 `disabled` |
| DeepSeek | `https://api.deepseek.com/v1` | `thinking.type`，推理强度映射，思考模式采样限制，工具续接保留 reasoning_content |
| 百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 保留 compatible-mode 路径，`enable_thinking`、`thinking_budget`、`top_k` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | 官方 OpenAI 兼容接口，保留版本路径，思考强度；仅已知可关闭思考的模型发送 none |
| OpenRouter | `https://openrouter.ai/api/v1` | `reasoning` 对象；可配置 HTTP-Referer 等额外请求头 |
| Groq | `https://api.groq.com/openai/v1` | 保留 openai 路径，零温度映射，GPT-OSS 思考强度 |
| Mistral | `https://api.mistral.ai/v1` | `random_seed`，思考参数与独立 Batch Jobs 接口 |
| xAI | `https://api.x.ai/v1` | 已知推理模型省略不支持的惩罚 / stop 字段，避免误发送其他厂商开关 |
| Kimi | `https://api.moonshot.cn/v1` | K2.5 / K2.6 思考开关，K3 思考强度，已知模型省略固定采样参数 |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | 保留 paas/v4 路径、thinking.type、已知 GLM 强度及不能关闭思考的模型 |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/v3` | 保留 api/v3 路径，Chat / Responses 的 thinking.type |
| 硅基流动 | `https://api.siliconflow.cn/v1` | enable_thinking、thinking_budget、top_k |
| Together AI / Fireworks / Cerebras / NVIDIA NIM | 各自官方 OpenAI 兼容地址 | 按通用 OpenAI 兼容处理，不发送厂商专有的思考开关 |
| Ollama / LM Studio（本地） | `http://localhost:11434/v1`、`http://localhost:1234/v1` | 通用 OpenAI 兼容，无需 API Key |

官方参考：[OpenAI Batch](https://developers.openai.com/api/reference/resources/batches/methods/create)、[Anthropic Batch](https://platform.claude.com/docs/en/api/messages/batches/create)、[Anthropic 思考](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)、[DeepSeek 思考](https://api-docs.deepseek.com/guides/thinking_mode/)、[百炼 Batch](https://help.aliyun.com/zh/model-studio/batch-inference)、[Gemini 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[OpenRouter 思考](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[Groq 兼容接口](https://console.groq.com/docs/openai)、[Mistral Batch](https://docs.mistral.ai/studio/batch-processing)、[xAI 思考](https://docs.x.ai/developers/model-capabilities/text/reasoning)、[Kimi 思考](https://platform.kimi.com/docs/guide/use-thinking-models)、[智谱思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[方舟思考](https://docs.volcengine.com/docs/ark/deep-thinking?lang=en)、[硅基流动思考](https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning)。

## Batch 支持范围

Batch 的规范由**提供商**决定，界面里不需要选协议。

| 提供商 | 规范 | 说明 |
| --- | --- | --- |
| OpenAI、Groq、通义百炼 | OpenAI 文件式 | 上传 `/files`（purpose=batch），创建 `/batches`（24h），查询 / 取消，下载 output / error 文件。一个文件只能有一个模型，提交前会检查 |
| Anthropic | Message Batches | `/messages/batches` 直接提交 requests；结束后下载 JSONL，成功和失败结果在同一个文件里 |
| Mistral | Batch Jobs | `/batch/jobs`、`input_files`、job 级 model；支持 Chat |
| OpenRouter | 自有 Batch API | 不上传文件，直接 `POST /batches`，body 为 `endpoint`、`model`、`requests:[{custom_id, body}]`；`endpoint` 和 `model` 必须写在 `requests` 之前，否则 400。传基础模型名，`:batch` 变体由 OpenRouter 自己解析（填了 `:batch` 会自动去掉）；`:online` 变体不支持。结果直接在查询响应的 `results` 里，没有取消接口，结果保留 30 天 |

以下提供商也有 Batch，但规范不同，**尚未实现**：Gemini（原生 `batchGenerateContent`，Files 不兼容 OpenAI）、xAI（自有任务协议）、Together AI 与 Fireworks（自有接口，OpenAI Batch 路径未实现）、火山方舟（基于 TOS 的签名接口）、智谱（端点只能是 `/v4/chat/completions`）、SiliconFlow、Cerebras（私有预览，取消方式为 `DELETE`）。DeepSeek、Kimi、Perplexity、NVIDIA、Ollama、LM Studio 没有查到公开的 Batch API。这些提供商的模型右键菜单里不会出现「批量处理」。

实时推理支持与 Batch 支持分开判断。没有加入 OAuth 登录、订阅会话或浏览器凭据复用。

输入示例（OpenAI 兼容）：

```jsonl
{"custom_id":"question-1","method":"POST","url":"/v1/chat/completions","body":{"model":"your-model-id","messages":[{"role":"user","content":"1+1 等于多少？"}]}}
```

Anthropic 输入示例：

```jsonl
{"custom_id":"question-1","params":{"model":"your-claude-model-id","max_tokens":1024,"messages":[{"role":"user","content":"1+1 等于多少？"}]}}
```

OpenRouter 输入示例（`model` 可省略，沿用所选模型）：

```jsonl
{"custom_id":"question-1","body":{"messages":[{"role":"user","content":"1+1 等于多少？"}]}}
```

客户端每批限制为 20 MiB / 50000 条，提交前验证全部 JSONL、唯一 custom_id、端点和非流式约束。导入的 body / params 原样使用，不自动套用当前选中模型参数；“从问题生成 JSONL”才会使用模型配置。上传 / 创建请求不会自动重试，创建结果不确定时会提示检查上游控制台，避免重复计费。

任务记录保存在本地 `answernest.batchJobs.v1`（会读取旧版 `zerror.batchJobs.v1`），仅包含任务 ID、提供商 ID / 地址、状态和文件 ID 等元数据。关闭应用后上游任务继续运行；重新打开后可手动刷新。可用任务 ID 找回记录。平台地址改变后必须恢复原地址才能操作旧任务。Batch 结果下载为 JSONL，当前不会自动写入题库。

## 总结时联网搜索（Firecrawl / Exa）

所有答题模型完成后，**答案一致直接提交**；**答案不一致**时，先搜索一次，再把各模型回答和网页资料一起交给**总结模型**，提交最终答案。在「设置 → 常规设置 → 联网搜索（总结时）」里开启搜索并填写 API Key，同时选择总结模型，和你用哪家 AI 提供商无关。

- **搜索服务**：[Firecrawl](https://www.firecrawl.dev)（注册有免费积分）或 [Exa](https://exa.ai)。软件直接调用它们的官方接口，Key 只保存在本机，只会发给对应的搜索服务。
- **只在总结时搜索，且一题只搜一次**：不是每个模型各搜一次；没有选总结模型就不搜索。带图片的题、题目是空的不搜索。
- **搜索词**：用题目文字，会去掉「【单选题】」「1.」这类题型和序号、填空的下划线。「搜索词是否带选项」默认「自动」：题目不足 12 个字（比如“下列说法正确的是”）才补上选项；也可以改成一律不带或总是带。
- **顺序执行**：等所有答题模型完成，再判断是否一致；一致时跳过搜索和总结。不一致时等待搜索结束，再开始总结。旧版「只在答案不一致时搜索」开关已移除，此流程固定生效。
- **异常处理**：失败或空答案不参与比较；只有一个有效答案时直接提交。搜索关闭、未配置或失败时，仅把答题结果交给总结模型。没有总结模型或总结全部失败时，按有效最终答案票数选择一个答案（同票按模型顺序），不会拼接多个互相冲突的答案提交。
- **结果显示在日志里**：和答题模型放在一起，名字是「搜索: Firecrawl」，里面是搜索词、耗时和发给总结模型的那段资料。搜索失败（Key 错误、额度不足、超时、没搜到）会显示原因，总结照常进行，只是没有这份资料。
- **提示词**：资料前会写明「仅供核对答案参考，可能与题目无关或有误，以题目本身和各模型的回答为准；最终答案里不要出现链接和来源」，避免链接混进返回给 OCS 的答案。
- **「测试」按钮**：用当前设置真的搜一次，确认 Key 和网络可用（会消耗一次额度）。

可以调整的参数（有些在「高级参数」里）：

| 参数 | 默认 | 说明 |
|---|---|---|
| 搜索条数 | 3 | 1–10。Firecrawl 每多一条约多耗 5 积分；Exa 每次请求含最多 10 条，条数只影响资料长度 |
| 每条结果最多字数 | 2000 | 超出截断 |
| 搜索超时 | 20 秒 | 超时就不带资料继续总结；OCS 默认 60 秒超时，要给总结留时间 |
| 搜索词最长字数 | 300 | |
| 只搜 / 不搜这些网站 | 空 | 域名用逗号或换行分隔；Firecrawl 两者互斥，同时填了只用「只搜」 |
| 抓取网页正文（Firecrawl） | 开 | 关闭则只用结果自带的摘要，省积分但资料更少 |
| 搜索模式（Exa） | auto | auto / fast / instant 较快；deep 系列慢很多也更贵 |
| 返回内容（Exa） | 摘录 | 「摘录」只返回和搜索词相关的片段，「全文」返回网页开头部分 |
| 服务地址 | 官方 | 自建 Firecrawl 或中转时填写 |
| 搜索代理 | 无 | 支持 HTTP / HTTPS / SOCKS5，只用于搜索请求，和各 AI 平台的代理互不影响 |

计费以各服务官方说明为准。Firecrawl 当前的计法是每 10 条结果 2 积分，外加每条被抓取的结果约 5 积分；Exa 的 auto 模式按次计费。

## 验证

```sh
npm ci --ignore-scripts --allow-remote=all
npm run test:model-api
npm run build
```

`--allow-remote=all` 仅在新版 npm 禁止锁文件中的远程 tarball URL 时需要。

本工作区的 Rust/Cargo 安装在 `.toolchains`（已加入 Git 忽略），未修改系统 PATH。后续在仓库根目录的 PowerShell 中使用：

```powershell
$env:RUSTUP_HOME = Join-Path $PWD '.toolchains/rustup'
$env:CARGO_HOME = Join-Path $PWD '.toolchains/cargo'
$env:PATH = "$env:CARGO_HOME/bin;$env:PATH"
cargo check --manifest-path src-tauri/Cargo.toml --locked
npm run tauri -- build --debug --no-bundle
```

这些环境变量仅影响当前 PowerShell 会话。`npm run tauri` 也会自动识别项目内工具链，显式设置的 `CARGO_HOME` 优先。Windows 编译还需安装 Visual Studio C++ 构建工具。

协议测试运行经压缩的产物，包含 URL / 鉴权 / 参数映射、SSE 分片和错误、工具续接、表单校验以及三个 Batch 协议的请求生命周期，均使用模拟上游。浏览器冒烟验证覆盖表单保存与校验、Batch 提交 / 刷新 / 下载 / 记录重开，HTTP 和原生文件操作使用测试替身。

没有使用真实付费 API 密钥进行联调，也未进行原生 HTTP 代理连接测试。已使用项目内 Rust 工具链及 Visual Studio 2026 通过 `cargo check --locked` 和 `npm run tauri -- build --debug --no-bundle`，生成 `src-tauri/target/debug/answernest.exe`；这是调试构建，未生成签名安装包。Rust 端为现有 reqwest 启用了 socks feature，HTTP 插件的代理配置沿用其官方 [ClientOptions.proxy](https://v2.tauri.app/reference/javascript/http/) 接口。
