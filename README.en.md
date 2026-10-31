# dsh-deepseek-search

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-blue)](package.json)
[![简体中文](https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-red)](README.md)

**English** | [简体中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers **web search** and **page fetch** providers on the `ctx.web` seam, backed by DeepSeek's native Search and Fetch JSON APIs.

It plugs into the harness instead of owning a tool: `dsh-tool-web` keeps the model-facing `web_search` / `web_fetch` schemas, provider selection, and rendering; this package only supplies the two backends.

## Features

- **Search provider** — `POST <baseURL>/search`, `https://api.deepseek.com/v1/tools/search` by default, mapped to `WebSearchResult` sources (`url`, `title`, `snippet`, `publishedAt`).
- **Fetch provider** — `POST <baseURL>/fetch`, returned as a `text` body containing the provider's Markdown extraction.
- **One id, both capabilities** — registered as `deepseek-search`; the bundle patch pins `searchProvider` and `fetchProvider` to it.
- **Layered credentials** — literal `apiKey` → `ctx.credentials` (what the settings pages write) → the launching environment, resolved **per operation**, so a rotated key needs no restart.
- **Live settings** — every field is volatile and read once per operation, so a saved change reaches the next call.
- **Lean retrieval request** — always sends `need_content: false` (snippets only, never a full page per result) and, when enabled, `ori_question`: the human prompt that started this turn, whitespace-collapsed and cut to 128 characters.
- **Retries** — exponential backoff on `408`, `429`, `500`, `502`, `503`, `504`, honoring `Retry-After` (capped at 8 s).
- **Cancellation** — honors the `AbortSignal` the seam passes in; aborts surface as `WEB_ABORTED`.
- **Bounded I/O** — raw bodies capped at 8 MiB, decoded bodies at 16 MiB.
- **Robust decoding** — gzip/zlib identified by magic bytes, so a host-installed undici dispatcher cannot break `response.json()`.

## How it differs from the shipped DeepSeek providers

DSH 0.2.1-rc.5 ships two DeepSeek backends:

| | `deepseek-official` | `deepseek-search-api` / `deepseek-fetch-api` | this plugin |
| --- | --- | --- | --- |
| Package | `dsh-web-search-deepseek` | `dsh-web-deepseek-api` | `dsh-deepseek-search` |
| Search backend | Anthropic-compatible `web_search` tool | Native `POST /v1/tools/search` | Native `POST /v1/tools/search` |
| Fetch backend | None | Native `POST /v1/tools/fetch` | Native `POST /v1/tools/fetch` |
| Model turn | One full model request | None | None |
| Automatic retry | No | No | 408/429/5xx backoff, configurable |
| DeepSeek Account sign-in | Yes | Yes | No — API key only |
| Config namespace | `web-search-deepseek` | `web-deepseek-api` | `dsh-deepseek-search` |

Since 0.2.1-rc.5, `deepseek-search-api` covers the same two endpoints, so **this plugin is capability-equivalent to it**. What remains as a reason to pick this one: a configurable retry policy, a separate config namespace, or not wanting to touch the shipped provider rows in a profile. If none of that matters, use the shipped `web-deepseek-api` — the “Web search” switch in Settings selects it.

## Requirements

- DeepSeek Harness **0.2.1-rc.5** or another 0.2.x release (`engines.dsh` and the peer ranges are `^0.2.1-rc.5`).
- The **`dsh` CLI** needs **Node.js 24+** (its entry uses `import.meta.main`, which Node 22 silently skips); the plugin itself runs inside the Host process and adds no Node requirement.
- A DeepSeek API key with access to `/v1/tools/search` and `/v1/tools/fetch`. Calls are billed by DeepSeek.

## Install

**From npm (recommended)**

```text
Plugins → Add plugin → dsh-deepseek-search
```

Or from the CLI / the agent tool:

```bash
dsh plugin --profile <profile> add dsh-deepseek-search
```

```text
plugin_manager install_bundle  target: dsh-deepseek-search@0.1.0
```

**From GitHub** (without npm)

```bash
dsh plugin --profile <profile> add github:zou-hong-run/dsh-deepseek-search
```

**A local checkout**: pass an absolute path, or `link:<dir>`.

```text
plugin_manager install_bundle  target: C:\path\to\dsh-deepseek-search
```

> The package name is `dsh-deepseek-search` (unscoped). Some registries display it as `@zou-hong-run/dsh-deepseek-search` after the repository; both name the same repository. Install with the npm name or the `github:` address above.

Do not substitute hand-run pnpm or manifest edits for `install_bundle` — that bypasses the version check and the rollback.

The bundle is selected on install and the plugin row appears immediately through HMR; no restart is needed. The Plugins inventory shows **DeepSeek Search & Fetch**.

Installation adds only this package and its own dependency `@deepseek-ai/schemastery` to the profile: the profile’s pnpm config sets `autoInstallPeers: false`, so peers are not written to disk, and DSH’s runtime resolution points `@deepseek-ai/dsh-web` and friends at the copy shipped with the installation. There is no second copy, so `WebError` keeps its class identity.

If the plugin itself fails to load, the `web` row still pins `deepseek-search`, so `web_search` / `web_fetch` fail with `WEB_PROVIDER_CONFIGURED_MISSING`; disable this bundle in Plugins (or point the `web` row in your own patch back at a shipped id) to recover. The process is unaffected.

### If the profile also pins the `web` row

A profile's `cordis.patch.yml` is applied **after every bundle layer**. If it already pins `web.searchProvider` / `fetchProvider` to a shipped id, it overrides this bundle's patch — the plugin installs but is never selected. Change that row to `deepseek-search`, or remove it.

### About the plugin market

Discover reads **JSON indexes the user configures** (`plugin-market`'s `indexes`), not npm search. So:

- publishing to npm alone does not make a package appear in Discover;
- the package must be published (or hosted as a Git repository) and then listed by some market index;
- this desktop profile neither mounts `plugin-market` nor configures an index, so Discover has nothing to show.

This repository carries its own index at [market/index.json](market/index.json) — Pages serves this repository's root, so the file stays in `market/`. After publishing, add this URL under **Plugins → Discover → Add index source**:

```text
https://zou-hong-run.github.io/dsh-deepseek-search/market/index.json
```

Append each new version to the `versions` array when you release (`publishTimestamp` is Unix seconds).

## Verify

```bash
dsh --profile <profile> --dump-config
```

The `web` row should contain:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: deepseek-search
    fetchProvider: deepseek-search
```

Then call `web_search` or `web_fetch` from a session. The plugin has no model-facing names of its own.

## Credentials

Resolved per operation, in this order:

1. `apiKey` in the plugin config (a literal; prefer the other two)
2. the reference named by `apiKeyEnv` (default `DEEPSEEK_API_KEY`) through `ctx.credentials` — where the settings/Models pages store a key and what `.credentials.yaml` backs
3. the same variable in the launching environment

`apiKeyEnv` must be a POSIX identifier (`[A-Za-z_][A-Za-z0-9_]*`); anything else falls back to the default name. The old `DEEPSEEK_SEARCH_API_KEY` shortcut is gone — set `apiKeyEnv: DEEPSEEK_SEARCH_API_KEY` to keep using it.

`available()` is a cheap local check (`baseURL` parses as http/https and `count` is valid) and **does not pre-check the credential**. That is deliberate: the credential store is asynchronous, so a synchronous availability check cannot decide, and a missing key fails `search()`/`fetch()` with the actionable `WEB_PROVIDER_CREDENTIAL_MISSING` instead of the seam's `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. The shipped provider makes the same trade.

Set the key in the launching environment:

```bash
export DEEPSEEK_API_KEY=sk-...
dsh web
```

Or override the plugin entry in a profile patch:

```yaml
- id: dsh-deepseek-search
  config:
    apiKey: sk-...
```

## Configuration

| Key | Default | Purpose |
| --- | --- | --- |
| `apiKey` | unset | Literal credential; wins over the credential service and the environment |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved through `ctx.credentials`, falling back to the launching environment |
| `baseURL` | `https://api.deepseek.com/v1/tools` | API base **including its path prefix**; `/search` and `/fetch` are appended |
| `count` | `10` | Result ceiling per search (1–50); a request's `maxResults` can only lower it |
| `maxRetries` | `2` | Retries after the first attempt |
| `retryDelayMs` | `800` | Base delay for exponential backoff |
| `sendOriginalQuestion` | `true` | Send the triggering human prompt as `ori_question` |

`baseURL` means the same thing as in the shipped `web-deepseek-api`: stop before the operation name, and the default already includes `/v1/tools`. A bare origin such as `https://api.deepseek.com` would produce `/search`, which is wrong.

These fields are also editable on the bundle's own page under **Plugins → this bundle** (the bundle ships a configuration page; a saved edit reaches the next call). Headless deployments keep using the patch form below.

Example override:

```yaml
- id: dsh-deepseek-search
  config:
    baseURL: https://api.deepseek.com/v1/tools
    count: 5
    maxRetries: 1
```

The bundle patch replaces the whole `web` row config, so if your deployment also needs keys on that row, restate them in your own patch layer (applied after bundles).

## Request and mapping notes

**Search** request body:

```json
{ "query": "...", "count": 5, "need_content": false, "ori_question": "..." }
```

`ori_question` is the last human message of the initiating session, whitespace-collapsed and cut to 128 characters. It is omitted without a session, without a human message, or with `sendOriginalQuestion: false`.

The seam has a narrower vocabulary than the DeepSeek response, so some fields are intentionally dropped:

- `snippet` → `snippet`, `date` → `publishedAt`, `title` → `title`.
- `summary` **never reaches the seam**: it measured 1,000–2,300 characters per result, and preferring it would multiply what `web_search` returns for no better citation. The same goes for the full-page `content`.
- `authority`, `rerankScore`, `siteName`, and `siteIcon` have no seam field.

**Fetch** returns `{ kind: 'text', content }`. `WebFetchResult` has no title field, so the extracted title is dropped. `statusCode` is `200`: DeepSeek reports extraction status, not the origin page's HTTP status (the service answers with an error status when the target yields nothing usable). `truncated` stays `false`; the seam owns result-count truncation.

**Result count** — `count = min(configured count, request maxResults ?? configured count)`, further capped at the API maximum of 50.

## Error codes

| Code | Source | Meaning |
| --- | --- | --- |
| `WEB_PROVIDER_ERROR` | this plugin | Invalid arguments, provider error, or an unprocessable response; post-dispatch failures name the endpoint used and the `dsh-deepseek-search.baseURL` fix |
| `WEB_PROVIDER_CREDENTIAL_MISSING` | this plugin | Nothing resolved from the literal, the credential service, or the environment |
| `WEB_ABORTED` | this plugin | The caller's signal fired, or the request was aborted |
| `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` | DSH seam | The configured id is registered but `available()` returned false (bad `baseURL` or `count`) |
| `WEB_PROVIDER_CONFIGURED_MISSING` | DSH seam | The configured id is not registered |
| `WEB_PROVIDER_AMBIGUOUS` | DSH seam | No id pinned and several providers are usable |

DeepSeek's own message is surfaced after `HTTP <status>`.

## Development

```bash
pnpm install
pnpm test
```

The suite uses `node:test` and mocks `globalThis.fetch`, so it needs no key and makes no network calls. Coverage: config snapshots and live reads, credential precedence and failure paths, availability, result mapping, request bodies (including `need_content` / `ori_question`), the result-count ceiling, retry and abort behavior, gzip decoding, validation, and provider registration.

Inside the DSH sandbox `node --test` can fail with `spawn EPERM` (the runner spawns a child); run the file as plain ESM instead: `node test/providers.test.mjs`.

Layout:

```text
dsh-deepseek-search/
  cordis.patch.yml      # bundle patch: insert plugin, repoint the web row
  package.json          # dsh.bundle.patch, engines.dsh, peer ranges, locale/icon exports
  lib/index.js          # Config schema, both providers, transport, plugin apply()
  locale/{en,zh}.json   # inventory title and description
  icon.svg              # inventory icon
  test/providers.test.mjs
```

## Limitations

- **No DeepSeek Account sign-in** — API key only. Use the shipped `web-deepseek-api` or `web-search-deepseek` when account credentials are required.
- `/v1/tools/search` and `/v1/tools/fetch` are provider-managed; they may change or be rate-limited. This plugin does not crawl or parse HTML itself.
- Fetch results are whatever DeepSeek's extractor returns. A page it cannot read fails as `WEB_PROVIDER_ERROR`.
- The plugin retrieves only; it does not run a model turn or generate answer text.
- Verified against DSH 0.2.1-rc.5. Other versions may change the loader or seam contracts.

## License

MIT. See [LICENSE](LICENSE).

This is a third-party plugin, not affiliated with DeepSeek.

---

[简体中文 README](README.md)
