# dsh-deepseek-search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.2-blue)](package.json)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](package.json)
[![简体中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-red)](README.md)

**English** | [简体中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers **web search** and **page fetch** providers on the `ctx.web` seam, backed by DeepSeek's native Search and Fetch JSON APIs.

It plugs into the harness instead of owning a tool: `dsh-tool-web` keeps the model-facing `web_search` / `web_fetch` schemas, provider selection, and rendering; this package only supplies the two backends.

## Features

- **Search provider** — `POST /v1/tools/search`, mapped to `WebSearchResult` sources (`url`, `title`, `snippet`, `publishedAt`).
- **Fetch provider** — `POST /v1/tools/fetch`, returned as a `text` body containing the provider's Markdown extraction.
- **One id, both capabilities** — registered as `deepseek-search`; the bundled patch pins `searchProvider` and `fetchProvider` to it.
- **Credential handling** — explicit config first, then `DEEPSEEK_SEARCH_API_KEY`, then `DEEPSEEK_API_KEY`; no disk reads and no logging.
- **Retries** — exponential backoff on `408`, `429`, `500`, `502`, `503`, `504`, honoring `Retry-After` (capped at 8 s).
- **Cancellation** — honors the `AbortSignal` the seam passes in; aborts surface as `WEB_ABORTED`.
- **Bounded I/O** — request bodies capped at 8 MiB, decoded bodies at 16 MiB.
- **Robust decoding** — gzip/zlib identified by magic bytes, so a host-installed undici dispatcher cannot break `response.json()`.

## How it differs from the shipped DeepSeek provider

DSH ships `web-search-deepseek` (provider id `deepseek-official`), which drives DeepSeek's Anthropic-compatible endpoint with the native `web_search` server tool. This plugin instead calls DeepSeek's Search and Fetch JSON APIs directly and is the only one of the two that also supplies a **fetch** provider:

| | `deepseek-official` | this plugin |
| --- | --- | --- |
| Search backend | Anthropic-compatible `web_search` tool | Native `POST /v1/tools/search` |
| Structured fields | Sources from tool blocks | Title, URL, summary/snippet, date |
| Fetch provider | No | Native `POST /v1/tools/fetch` |
| Model turn | Yes | No — retrieval only |

Both can be installed; the bundle patch decides which provider ids the seam uses. The native fetch path is the reason to pick this plugin: page retrieval goes through DeepSeek's extractor and comes back as Markdown instead of raw HTML.

## Requirements

- DeepSeek Harness **0.2.1-rc.2** (`@deepseek-ai/dsh-web` / `@deepseek-ai/dsh-launch-environment` peer range).
- **Node.js 24+**. The DSH 0.2.1 CLI entry uses `import.meta.main`, which Node 22 does not provide; on Node 22 the CLI exits silently without doing anything.
- A DeepSeek API key with access to `/v1/tools/search` and `/v1/tools/fetch`. Calls are billed by DeepSeek.

## Install

### From npm (once published)

```bash
dsh plugin --profile web add dsh-deepseek-search
```

### From GitHub

```bash
dsh plugin --profile web add github:zou-hong-run/dsh-deepseek-search
```

### From a local checkout

```bash
dsh plugin --profile web add link:C:/path/to/dsh-deepseek-search
```

`dsh plugin` forwards to pnpm in the profile directory and appends the package to `dsh.profile.bundles`. The bundle patch is what registers the plugin and repoints the `web` row.

Restart the profile after installing:

```bash
dsh web
```

### Verify

```bash
dsh --profile web --dump-config | grep -A4 -- '- id: web'
```

Expected:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search
    fetchProvider: deepseek-search
```

Then call `web_search` or `web_fetch` from a session. The plugin has no model-facing names of its own — the tools still come from `dsh-tool-web`.

## Credentials

Resolved once per plugin load, in this order:

1. `apiKey` in the plugin config
2. `DEEPSEEK_SEARCH_API_KEY`
3. `DEEPSEEK_API_KEY`

`available()` is a cheap local check (`apiKey` non-empty and a valid http/https `baseURL`), as the seam requires; it never makes a network call. If no key is present the provider reports unavailable, and the seam surfaces `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` (or `WEB_PROVIDER_UNAVAILABLE` without an explicit id).

Set the key in the launching environment:

```bash
export DEEPSEEK_API_KEY=sk-...
dsh web
```

Or override the plugin entry in `$DSH_HOME/cordis.patch.yml`:

```yaml
- id: dsh-deepseek-search
  config:
    apiKey: sk-...
```

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `""` | Explicit credential; takes precedence over both environment variables |
| `baseURL` | `https://api.deepseek.com` | API base; `/v1/tools/search` and `/v1/tools/fetch` are appended |
| `count` | `10` | Default result count when the caller sends no `maxResults` |
| `maxRetries` | `2` | Retries after the first attempt |
| `retryDelayMs` | `800` | Base delay for exponential backoff |

Example override:

```yaml
- id: dsh-deepseek-search
  config:
    baseURL: https://api.deepseek.com
    count: 5
    maxRetries: 1
```

The bundle patch replaces the whole `web` row config, so if your deployment also needs keys on that row, restate them in your own patch layer (applied after bundles).

## Mapping notes

The seam has a narrower vocabulary than the DeepSeek response, so some fields are intentionally dropped:

- **Search** — `summary` becomes `snippet` (falling back to `snippet`), `date` becomes `publishedAt`. `authority`, `rerankScore`, `siteName`, `siteIcon`, and page `content` have no seam field and are not returned. `content` (provider-generated answer) is omitted because DeepSeek returns none.
- **Fetch** — returned as `{ kind: 'text', content }`. `WebFetchResult` has no title field, so the extracted title is dropped. `statusCode` is `200`: DeepSeek reports extraction status, not the origin page's HTTP status. `truncated` stays `false`; the seam owns result-count truncation.
- **Result count** — `request.maxResults` is sent as `count` and clamped to the API maximum of 50. `count` from config applies when the caller omits `maxResults`.

## Error codes

| Code | Source | Meaning |
| --- | --- | --- |
| `WEB_PROVIDER_ERROR` | this plugin | Invalid arguments, provider error, or an unprocessable response |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | this plugin | `search()`/`fetch()` called with no key configured |
| `WEB_ABORTED` | this plugin | The caller's signal fired, or the request was aborted |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | DSH seam | The configured id is registered but `available()` returned false |
| `WEB_PROVIDER_CONFIGURED_MISSING` | DSH seam | The configured id is not registered |

Provider error messages from DeepSeek are surfaced verbatim.

## Development

```bash
pnpm install
pnpm test
```

The suite uses `node:test` and mocks `globalThis.fetch`, so it needs no key and makes no network calls. Current coverage: option precedence, availability, result mapping, request bodies, retry and abort behavior, gzip decoding, validation, and provider registration.

Layout:

```text
dsh-deepseek-search/
  cordis.patch.yml      # bundle patch: insert plugin, repoint the web row
  package.json          # dsh.bundle.patch + peer ranges
  lib/index.js          # Config schema, providers, transport, plugin apply()
  test/providers.test.mjs
```

## Limitations

- `/v1/tools/search` and `/v1/tools/fetch` are provider-managed; they may change or be rate-limited. This plugin does not crawl or parse HTML itself.
- Fetch results are whatever DeepSeek's extractor returns. A page that the extractor cannot read fails as `WEB_PROVIDER_ERROR`.
- The plugin retrieves only; it does not run a model turn or generate answer text.
- Verified against DSH 0.2.1-rc.2 on Node 24.22. Other versions may change the loader or seam contracts.

## License

MIT. See [LICENSE](LICENSE).

This is a third-party plugin, not affiliated with DeepSeek.

---

[简体中文 README](README.md)
