# dsh-deepseek-search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![English](https://img.shields.io/badge/lang-English-blue)](README.en.md)

**简体中文** ｜ [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：在 `ctx.web` seam 上注册**网页搜索**和**网页抓取**两个 provider，后端使用 DeepSeek 原生的 Search / Fetch JSON API。

它接入 harness，而不是自带模型工具：模型侧 `web_search` / `web_fetch` 的 schema、provider 选择与结果渲染仍由 `dsh-tool-web` 负责；本包只提供两个后端。

## 功能

- **搜索 provider** — 调用 `POST /v1/tools/search`，映射为 `WebSearchResult` 的 sources（`url`、`title`、`snippet`、`publishedAt`）。
- **抓取 provider** — 调用 `POST /v1/tools/fetch`，返回 `text` 类型的正文，内容为服务方抽取出的 Markdown。
- **同一个 id 覆盖两类能力** — 都注册为 `deepseek-search`；自带的 bundle patch 把 `searchProvider` 和 `fetchProvider` 都指向它。
- **凭据处理** — 依次读取显式配置、`DEEPSEEK_SEARCH_API_KEY`、`DEEPSEEK_API_KEY`；不读磁盘、不写日志。
- **重试** — 对 `408`、`429`、`500`、`502`、`503`、`504` 指数退避，尊重 `Retry-After`（上限 8 秒）。
- **可取消** — 响应 seam 传入的 `AbortSignal`，取消后以 `WEB_ABORTED` 结束。
- **有上限的 I/O** — 原始响应 8 MiB，解压后 16 MiB。
- **稳健解码** — 按魔数识别 gzip/zlib，宿主安装不同版本的 undici dispatcher 也不会让 `response.json()` 失效。

## 与官方 DeepSeek provider 的区别

DSH 自带 `web-search-deepseek`（provider id 为 `deepseek-official`），走 DeepSeek 的 Anthropic 兼容接口和原生 `web_search` 工具。本插件直接调用 DeepSeek 的 Search / Fetch JSON API，并且是两者中唯一同时提供 **fetch** provider 的：

| | `deepseek-official` | 本插件 |
| --- | --- | --- |
| 搜索后端 | Anthropic 兼容的 `web_search` 工具 | 原生 `POST /v1/tools/search` |
| 结构化字段 | 工具块中的 sources | 标题、URL、summary/snippet、日期 |
| 抓取 provider | 无 | 原生 `POST /v1/tools/fetch` |
| 模型回合 | 有 | 无，只做检索 |

两者可以共存；最终用哪个 provider 由 bundle patch 决定。选择本插件的主要理由是抓取：页面由 DeepSeek 抽取后以 Markdown 返回，而不是原始 HTML。

## 环境要求

- DeepSeek Harness **0.2.1-rc.2**（peer 依赖 `@deepseek-ai/dsh-web` / `@deepseek-ai/dsh-launch-environment`）。
- **Node.js 24+**。DSH 0.2.1 的 CLI 入口使用 `import.meta.main`，Node 22 没有这个特性，CLI 会静默退出、什么都不做。
- 一个可访问 `/v1/tools/search` 与 `/v1/tools/fetch` 的 DeepSeek API key。调用由 DeepSeek 计费。

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile web add dsh-deepseek-search
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:zou-hong-run/dsh-deepseek-search
```

### 从本地目录安装

```bash
dsh plugin --profile web add link:C:/path/to/dsh-deepseek-search
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，并把包加入 `dsh.profile.bundles`。真正注册插件、改写 `web` 行的是包里的 bundle patch。

安装后重启 profile：

```bash
dsh web
```

### 验证

```bash
dsh --profile web --dump-config | grep -A4 -- '- id: web'
```

应看到：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search
    fetchProvider: deepseek-search
```

之后在会话里调用 `web_search` 或 `web_fetch` 即可。本插件没有自己的模型工具名，工具仍由 `dsh-tool-web` 提供。

## 凭据

插件加载时按以下顺序解析一次：

1. 插件配置里的 `apiKey`
2. `DEEPSEEK_SEARCH_API_KEY`
3. `DEEPSEEK_API_KEY`

`available()` 只做本地检查（`apiKey` 非空且 `baseURL` 是合法的 http/https 地址），这是 seam 的要求，不会发起网络请求。找不到 key 时 provider 报告不可用，seam 会返回 `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`（未显式指定 id 时为 `WEB_PROVIDER_UNAVAILABLE`）。

在启动环境里设置 key：

```bash
export DEEPSEEK_API_KEY=sk-...
dsh web
```

或在 `$DSH_HOME/cordis.patch.yml` 中覆盖插件条目：

```yaml
- id: dsh-deepseek-search
  config:
    apiKey: sk-...
```

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `apiKey` | `""` | 显式凭据，优先于两个环境变量 |
| `baseURL` | `https://api.deepseek.com` | API 基地址，自动拼接 `/v1/tools/search` 和 `/v1/tools/fetch` |
| `count` | `10` | 调用方未传 `maxResults` 时的默认结果数 |
| `maxRetries` | `2` | 首次尝试之后的重试次数 |
| `retryDelayMs` | `800` | 指数退避的基础延迟 |

覆盖示例：

```yaml
- id: dsh-deepseek-search
  config:
    baseURL: https://api.deepseek.com
    count: 5
    maxRetries: 1
```

bundle patch 会整行替换 `web` 的 config。如果你的部署还需要在 `web` 行上保留其他键，请在自己的 patch 层里一并写回（用户 patch 在 bundle 之后应用）。

## 字段映射说明

seam 的词汇比 DeepSeek 响应窄，部分字段会被有意丢弃：

- **搜索** — `summary` 映射为 `snippet`（没有时回退到 `snippet`），`date` 映射为 `publishedAt`。`authority`、`rerankScore`、`siteName`、`siteIcon` 和页面 `content` 在 seam 中没有对应字段，不会返回。`content`（服务方生成的答案）也不返回，因为 DeepSeek 不生成答案。
- **抓取** — 返回 `{ kind: 'text', content }`。`WebFetchResult` 没有标题字段，抽取出的 title 会被丢弃。`statusCode` 固定为 `200`：DeepSeek 报告的是自身抽取状态，不是源站 HTTP 状态。`truncated` 保持 `false`，按结果数截断由 seam 负责。
- **结果数** — `request.maxResults` 会作为 `count` 发送，并限制在 API 上限 50 以内；调用方未传 `maxResults` 时使用配置里的 `count`。

## 错误码

| 错误码 | 来源 | 含义 |
| --- | --- | --- |
| `WEB_PROVIDER_ERROR` | 本插件 | 参数非法、服务方报错，或响应无法解析 |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | 本插件 | 未配置 key 时直接调用了 `search()`/`fetch()` |
| `WEB_ABORTED` | 本插件 | 调用方 signal 触发，或请求被中止 |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | DSH seam | 配置的 id 已注册，但 `available()` 返回 false |
| `WEB_PROVIDER_CONFIGURED_MISSING` | DSH seam | 配置的 id 没有注册 |

DeepSeek 返回的错误信息会原样透出。

## 开发

```bash
pnpm install
pnpm test
```

测试使用 `node:test` 并 mock `globalThis.fetch`，不需要 key，也不会发起真实网络请求。当前覆盖：配置优先级、可用性判断、结果映射、请求体、重试与取消、gzip 解码、参数校验、provider 注册。

目录结构：

```text
dsh-deepseek-search/
  cordis.patch.yml      # bundle patch：插入插件、改写 web 行
  package.json          # dsh.bundle.patch 与 peer 版本范围
  lib/index.js          # Config schema、两个 provider、传输层、apply()
  test/providers.test.mjs
```

## 限制

- `/v1/tools/search` 与 `/v1/tools/fetch` 由服务方维护，可能变更或限流；本插件不做本地爬取或 HTML 解析。
- 抓取结果是 DeepSeek 抽取器的输出；抽取失败的页面会以 `WEB_PROVIDER_ERROR` 结束。
- 插件只做检索，不运行模型回合，也不生成答案文本。
- 已在 DSH 0.2.1-rc.2 + Node 24.22 上验证；其他版本可能改变 loader 或 seam 契约。

## 许可证

MIT，见 [LICENSE](LICENSE)。

这是第三方插件，与 DeepSeek 官方无隶属关系。

---

[English README](README.en.md)
