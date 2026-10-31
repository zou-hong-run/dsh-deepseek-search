# dsh-deepseek-search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-blue)](package.json)
[![English](https://img.shields.io/badge/lang-English-blue)](README.en.md)

**简体中文** ｜ [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 `ctx.web` seam 上注册**网页搜索**和**网页抓取**两个 provider，后端使用 DeepSeek 原生的 Search / Fetch JSON API。

它接入 harness，而不是自带模型工具：模型侧 `web_search` / `web_fetch` 的 schema、provider 选择与结果渲染仍由 `dsh-tool-web` 负责；本包只提供两个后端。

## 功能

- **搜索 provider** — `POST <baseURL>/search`，默认 `https://api.deepseek.com/v1/tools/search`，映射为 `WebSearchResult` 的 sources（`url`、`title`、`snippet`、`publishedAt`）。
- **抓取 provider** — `POST <baseURL>/fetch`，返回 `text` 类型的正文，内容为服务方抽取出的 Markdown。
- **同一个 id 覆盖两类能力** — 都注册为 `deepseek-search`；bundle patch 把 `searchProvider` 和 `fetchProvider` 都指向它。
- **凭据分层** — 显式 `apiKey` → `ctx.credentials`（设置页写入的就是这里）→ 启动环境；**每次调用解析**，换 key 不需要重启。
- **实时配置** — 所有字段都是 volatile，provider 每次操作读一次；保存即对下一次调用生效。
- **检索请求** — 固定发送 `need_content: false`（只要摘要，不拉整页正文），并可按配置附带 `ori_question`：发起本轮的人类提问，压空白后截 128 字。
- **重试** — 对 `408`、`429`、`500`、`502`、`503`、`504` 指数退避，尊重 `Retry-After`（上限 8 秒）。
- **可取消** — 响应 seam 传入的 `AbortSignal`，取消后以 `WEB_ABORTED` 结束。
- **有上限的 I/O** — 原始响应 8 MiB，解压后 16 MiB。
- **稳健解码** — 按魔数识别 gzip/zlib，宿主安装不同版本的 undici dispatcher 也不会让 `response.json()` 失效。

## 与自带 DeepSeek provider 的区别

DSH 0.2.1-rc.5 自带两个 DeepSeek 后端：

| | `deepseek-official` | `deepseek-search-api` / `deepseek-fetch-api` | 本插件 |
| --- | --- | --- | --- |
| 包 | `dsh-web-search-deepseek` | `dsh-web-deepseek-api` | `dsh-deepseek-search` |
| 搜索后端 | Anthropic 兼容的 `web_search` 工具 | 原生 `POST /v1/tools/search` | 原生 `POST /v1/tools/search` |
| 抓取后端 | 无 | 原生 `POST /v1/tools/fetch` | 原生 `POST /v1/tools/fetch` |
| 模型回合 | 有一次完整模型请求 | 无 | 无 |
| 自动重试 | 无 | 无 | 408/429/5xx 退避，可配 |
| DeepSeek Account 登录 | 支持 | 支持 | 不支持，只用 API key |
| 配置命名空间 | `web-search-deepseek` | `web-deepseek-api` | `dsh-deepseek-search` |

`deepseek-search-api` 自 0.2.1-rc.5 起覆盖了同样的两个端点，所以**能力上本插件与它基本等价**。选择本插件的理由只剩：需要可配置的重试/退避、希望使用独立的配置命名空间、或者不想动 profile 里官方行的配置。如果这些都不需要，直接用自带的 `web-deepseek-api` 即可（设置页 “Web search” 开关就能切换）。

## 环境要求

- DeepSeek Harness **0.2.1-rc.5** 或同一 minor 内的版本（`engines.dsh` 与 peer 范围都是 `^0.2.1-rc.5`）。
- 用 `dsh` CLI 操作时需要 **Node.js 24+**（CLI 入口用 `import.meta.main`，Node 22 会静默退出）；插件本身跑在宿主进程里，不额外要求 Node 版本。
- 一个可访问 `/v1/tools/search` 与 `/v1/tools/fetch` 的 DeepSeek API key。调用由 DeepSeek 计费。

## 安装

用 Plugins 页面或 `plugin_manager` 的 `install_bundle` 安装，本地目录传绝对路径（或 `link:<目录>`）。不要让 `install_bundle` 之外的手工 pnpm/清单修改代替它，那会绕开版本检查与回滚。

```text
plugin_manager install_bundle  target: C:\path\to\dsh-deepseek-search
```

安装后 bundle 会被选中，插件行立即出现（HMR 生效），无需重启。Plugins 清单里应显示 **DeepSeek 搜索与抓取**。

安装只会往 profile 里加这个包和它自己的依赖 `@deepseek-ai/schemastery`：profile 的 pnpm 配置是 `autoInstallPeers: false`，peer 不落盘；`@deepseek-ai/dsh-web` 等由 DSH 的运行时解析指向安装包自带的那一份，不会出现第二份，`WebError` 的类身份因此保持一致。

如果插件本身起不来，`web` 行仍然钉着 `deepseek-search`，`web_search` / `web_fetch` 会以 `WEB_PROVIDER_CONFIGURED_MISSING` 失败；在 Plugins 里禁用这个 bundle（或把自己 patch 里的 `web` 行改回官方 id）即可恢复，进程不受影响。

### 如果 profile 自己也钉了 `web` 行

profile 的 `cordis.patch.yml` 在**所有 bundle 之后**应用。如果那里已经把 `web.searchProvider` / `fetchProvider` 钉到官方 id，bundle patch 会被它覆盖 —— 插件装上了但不会被选中。把它改成 `deepseek-search`，或删掉那一行。

### 关于插件市场

插件市场（Discover）读的是**用户自己配置的 JSON 索引**（`plugin-market` 的 `indexes`），不是 npm 搜索。所以：

- 只把包发布到 npm 并不会让它出现在 Discover；
- 需要先发布（或托管 git 仓库），再让某个市场索引收录这个包和版本；
- 本机 desktop profile 默认没有挂载 `plugin-market`，也没有配置索引，Discover 里自然是空的。

## 验证

```bash
dsh --profile <profile> --dump-config
```

其中 `web` 行应包含：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search
    fetchProvider: deepseek-search
```

之后在会话里调用 `web_search` 或 `web_fetch` 即可。本插件没有自己的模型工具名。

## 凭据

每次操作按以下顺序解析：

1. 插件配置里的 `apiKey`（字面量，慎用）
2. `ctx.credentials` 中 `apiKeyEnv` 指向的引用（默认 `DEEPSEEK_API_KEY`；设置页/Models 页写入的就是这里，`.credentials.yaml` 也由它支撑）
3. 启动环境里的同名变量

`apiKeyEnv` 必须是 POSIX 标识符（`[A-Za-z_][A-Za-z0-9_]*`），否则回落到默认名。旧版的 `DEEPSEEK_SEARCH_API_KEY` 快捷方式已移除：要沿用就设 `apiKeyEnv: DEEPSEEK_SEARCH_API_KEY`。

`available()` 只做本地检查（`baseURL` 能解析成 http/https、`count` 合法），**不预检凭据**。这是刻意的：凭据库是异步的，同步可用性检查没法定论，所以缺 key 时 `search()`/`fetch()` 以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败，给出可操作的提示，而不是让 seam 报 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`。官方 provider 也是这个取舍。

在启动环境里设置 key：

```bash
export DEEPSEEK_API_KEY=sk-...
dsh web
```

或在 profile patch 里覆盖插件条目：

```yaml
- id: dsh-deepseek-search
  config:
    apiKey: sk-...
```

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `apiKey` | 未设置 | 字面量凭据，优先于凭据服务与环境变量 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 凭据引用名，经 `ctx.credentials` 解析，缺失时回落启动环境 |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API 基地址，**含路径前缀**；自动拼接 `/search` 和 `/fetch` |
| `count` | `10` | 每次搜索的结果数上限（1–50）；请求的 `maxResults` 只能把它调小 |
| `maxRetries` | `2` | 首次尝试之后的重试次数 |
| `retryDelayMs` | `800` | 指数退避的基础延迟 |
| `sendOriginalQuestion` | `true` | 是否把发起本轮的人类提问作为 `ori_question` 发送 |

`baseURL` 的语义与官方 `web-deepseek-api` 一致：填到操作名前为止，默认值已经包含 `/v1/tools`。填成裸域 `https://api.deepseek.com` 会得到 `/search`，那是错的。

这些字段也能在 **Plugins → 本 bundle 的详情页**里直接编辑（bundle 自带配置页，保存后对下一次调用生效）；headless 部署继续用下面的 patch 写法。

覆盖示例：

```yaml
- id: dsh-deepseek-search
  config:
    baseURL: https://api.deepseek.com/v1/tools
    count: 5
    maxRetries: 1
```

bundle patch 会整行替换 `web` 的 config。如果你的部署还需要在 `web` 行上保留其他键，请在自己的 patch 层里一并写回（用户 patch 在 bundle 之后应用）。

## 请求与字段映射

**搜索** 请求体：

```json
{ "query": "...", "count": 5, "need_content": false, "ori_question": "..." }
```

`ori_question` 取发起本轮会话里的最后一条人类消息，压空白后截 128 字；没有会话、没有人类消息或 `sendOriginalQuestion: false` 时省略该字段。

seam 的词汇比 DeepSeek 响应窄，部分字段会被有意丢弃：

- `snippet` → `snippet`，`date` → `publishedAt`、`title` → `title`。
- `summary` **不进入 seam**：服务方实测每条 1000–2300 字，作为 snippet 会把 `web_search` 的输出撑大好几倍；`content`（整页正文）同理。
- `authority`、`rerankScore`、`siteName`、`siteIcon` 在 seam 中没有对应字段。

**抓取** 返回 `{ kind: 'text', content }`。`WebFetchResult` 没有标题字段，抽取出的 title 会被丢弃。`statusCode` 固定为 `200`：DeepSeek 报告的是自身抽取状态，不是源站 HTTP 状态（服务方在目标页无可用内容时直接返回错误状态）。`truncated` 保持 `false`，按结果数截断由 seam 负责。

**结果数** — `count = min(配置 count, 请求 maxResults ?? 配置 count)`，再受 API 上限 50 约束。

## 错误码

| 错误码 | 来源 | 含义 |
| --- | --- | --- |
| `WEB_PROVIDER_ERROR` | 本插件 | 参数非法、服务方报错，或响应无法解析；派发后的失败会附上实际端点与 `dsh-deepseek-search.baseURL` 的修复指引 |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 本插件 | 字面量、凭据服务、启动环境都拿不到 key |
| `WEB_ABORTED` | 本插件 | 调用方 signal 触发，或请求被中止 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | DSH seam | 配置的 id 已注册，但 `available()` 返回 false（`baseURL` 或 `count` 非法） |
| `WEB_PROVIDER_CONFIGURED_MISSING` | DSH seam | 配置的 id 没有注册 |
| `WEB_PROVIDER_AMBIGUOUS` | DSH seam | 没有固定 id，且有多个可用 provider |

DeepSeek 返回的错误信息会拼在 `HTTP <status>` 之后透出。

## 开发

```bash
pnpm install
pnpm test
```

测试使用 `node:test` 并 mock `globalThis.fetch`，不需要 key，也不会发起真实网络请求。覆盖：配置快照与实时读取、凭据优先级与失败路径、可用性判断、结果映射、请求体（含 `need_content` / `ori_question`）、结果数上限、重试与取消、gzip 解码、参数校验、provider 注册。

在 DSH 沙箱里 `node --test` 可能因 `spawn EPERM` 失败（测试运行器要起子进程），可以直接把测试文件当普通 ESM 跑：`node test/providers.test.mjs`。

目录结构：

```text
dsh-deepseek-search/
  cordis.patch.yml      # bundle patch：插入插件、改写 web 行
  package.json          # dsh.bundle.patch、engines.dsh、peer 范围、locale/icon 导出
  lib/index.js          # Config schema、两个 provider、传输层、apply()
  locale/{en,zh}.json   # 插件清单里的标题与描述
  icon.svg              # 插件清单图标
  test/providers.test.mjs
```

## 限制

- **不支持 DeepSeek Account 登录令牌**，只用 API key；需要账号登录请用自带的 `web-deepseek-api` 或 `web-search-deepseek`。
- `/v1/tools/search` 与 `/v1/tools/fetch` 由服务方维护，可能变更或限流；本插件不做本地爬取或 HTML 解析。
- 抓取结果是 DeepSeek 抽取器的输出；抽取失败的页面会以 `WEB_PROVIDER_ERROR` 结束。
- 插件只做检索，不运行模型回合，也不生成答案文本。
- 已在 DSH 0.2.1-rc.5 上验证；其他版本可能改变 loader 或 seam 契约。

## 许可证

MIT，见 [LICENSE](LICENSE)。

这是第三方插件，与 DeepSeek 官方无隶属关系。

---

[English README](README.en.md)
