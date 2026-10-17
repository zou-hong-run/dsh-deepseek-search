/**
 * dsh-deepseek-search — DeepSeek-backed search and fetch providers for the
 * DeepSeek Harness web capability seam (`ctx.web`).
 *
 * The plugin registers two providers:
 *   - `deepseek-search` (search): POST /v1/tools/search
 *   - `deepseek-search` (fetch):  POST /v1/tools/fetch
 *
 * It owns no model-facing tools: `dsh-tool-web` renders whatever the seam
 * returns. Credentials come from the plugin config or the launching
 * environment, never from disk.
 *
 * @module dsh-deepseek-search
 */
import { gunzipSync, inflateSync } from 'node:zlib'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'deepseek-search'
/** The web seam this plugin contributes to. */
export const inject = ['web']
/** Stable id both providers register under, one per capability kind. */
export const PROVIDER_ID = 'deepseek-search'
/** Default DeepSeek API base URL; the operation paths are appended. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'

const SEARCH_PATH = '/v1/tools/search'
const FETCH_PATH = '/v1/tools/fetch'
const USER_AGENT = 'dsh-deepseek-search/0.1.0'
const MAX_QUERY_CHARS = 128
const MAX_FETCH_URL_CHARS = 8192
const MAX_COUNT = 50
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_DECODED_BYTES = 16 * 1024 * 1024
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export const DEFAULTS = Object.freeze({
  count: 10,
  maxRetries: 2,
  retryDelayMs: 800,
})

/** Plugin configuration, shown on the profile's plugin settings surface. */
export const Config = z.object({
  apiKey: z.string().role('secret').default(''),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  count: z.number().step(1).min(1).max(MAX_COUNT).default(DEFAULTS.count),
  maxRetries: z.number().step(1).min(0).default(DEFAULTS.maxRetries),
  retryDelayMs: z.number().step(1).min(0).default(DEFAULTS.retryDelayMs),
})

// #region configuration

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

function environmentValue(environment, key) {
  return environment?.get?.(key)?.value
}

/**
 * Resolve one provider's options. `environment` is the launching environment
 * (`launchEnvironmentOf(ctx)`); the explicit config wins over both variables.
 */
export function resolveOptions(environment, config = {}) {
  return {
    apiKey: firstNonEmpty(config.apiKey, environmentValue(environment, 'DEEPSEEK_SEARCH_API_KEY'), environmentValue(environment, 'DEEPSEEK_API_KEY')) ?? '',
    baseURL: firstNonEmpty(config.baseURL, DEFAULT_BASE_URL),
    count: config.count ?? DEFAULTS.count,
    maxRetries: config.maxRetries ?? DEFAULTS.maxRetries,
    retryDelayMs: config.retryDelayMs ?? DEFAULTS.retryDelayMs,
  }
}

// #endregion

// #region endpoint helpers

function parseBaseURL(baseURL) {
  try {
    return new URL(baseURL)
  } catch {
    return undefined
  }
}

function isValidBaseURL(baseURL) {
  const parsed = parseBaseURL(baseURL)
  return parsed !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
}

function endpointOf(baseURL, path) {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

function assertUsable(options) {
  if (options.apiKey.length === 0) {
    throw new WebError(
      'DeepSeek web access has no API key: set DEEPSEEK_SEARCH_API_KEY or DEEPSEEK_API_KEY, or configure apiKey on this plugin',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
  if (!isValidBaseURL(options.baseURL)) {
    throw new WebError(`"baseURL" must be an absolute http or https URL, got: ${String(options.baseURL)}`, 'WEB_PROVIDER_ERROR')
  }
}

// #endregion

// #region decoding

/**
 * Bodies are inflated by magic number rather than through `response.json()`:
 * a host process may install an undici dispatcher from a different version
 * than the one backing Node's built-in fetch, and across that boundary
 * `response.json()` can receive still-compressed bytes.
 */
const GZIP_MAGIC_FIRST = 0x1f
const GZIP_MAGIC_SECOND = 0x8b
const ZLIB_CMF = 0x78

function isZlibStream(raw) {
  return raw[0] === ZLIB_CMF && ((raw[0] << 8) | (raw[1] ?? 0)) % 31 === 0
}

async function readBodyCapped(response, maxBytes) {
  const reader = response.body?.getReader()
  if (reader === undefined) return Buffer.alloc(0)
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done === true) break
    total += value.byteLength
    if (total > maxBytes) {
      let cancelError
      try {
        await reader.cancel()
      } catch (error) {
        cancelError = error
      }
      throw new Error(`response body exceeds ${maxBytes} bytes`, cancelError === undefined ? undefined : { cause: cancelError })
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

function inflateCapped(raw, maxBytes) {
  try {
    return raw[0] === GZIP_MAGIC_FIRST && raw[1] === GZIP_MAGIC_SECOND
      ? gunzipSync(raw, { maxOutputLength: maxBytes })
      : inflateSync(raw, { maxOutputLength: maxBytes })
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE') throw new Error(`decoded body exceeds ${maxBytes} bytes`, { cause: error })
    throw error
  }
}

async function readJsonResponse(response) {
  const raw = await readBodyCapped(response, MAX_RESPONSE_BYTES)
  const compressed = (raw[0] === GZIP_MAGIC_FIRST && raw[1] === GZIP_MAGIC_SECOND) || isZlibStream(raw)
  const json = compressed ? inflateCapped(raw, MAX_DECODED_BYTES) : raw
  return JSON.parse(json.toString('utf8'))
}

// #endregion

// #region response mapping

function copyString(target, key, value) {
  if (typeof value === 'string' && value.length > 0) target[key] = value
}

/**
 * `/v1/tools/search` body -> results, minus entries without a URL. Duplicate
 * URLs are removed; an empty array is a legitimate "no matches" answer.
 */
export function mapSearchResults(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new WebError('the search endpoint returned a body without a results array', 'WEB_PROVIDER_ERROR')
  }
  const results = []
  const seen = new Set()
  for (const item of data.results) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.url !== 'string' || item.url.length === 0 || seen.has(item.url)) continue
    seen.add(item.url)
    const result = { url: item.url }
    copyString(result, 'title', item.title)
    copyString(result, 'snippet', item.snippet)
    copyString(result, 'summary', item.summary)
    copyString(result, 'siteName', item.site_name)
    copyString(result, 'siteIcon', item.site_icon)
    copyString(result, 'date', item.date)
    if (Number.isInteger(item.authority) && item.authority >= 0) result.authority = item.authority
    if (typeof item.rerank_score === 'number' && Number.isFinite(item.rerank_score)) result.rerankScore = item.rerank_score
    results.push(result)
  }
  return results
}

/** Map mapped results to the seam's portable source shape. */
export function toSources(results) {
  return results.map((result) => ({
    url: result.url,
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.summary !== undefined ? { snippet: result.summary } : result.snippet !== undefined ? { snippet: result.snippet } : {}),
    ...(result.date !== undefined ? { publishedAt: result.date } : {}),
  }))
}

/** `/v1/tools/fetch` body -> page; a blank body is unprocessable. */
export function mapFetchPage(data) {
  if (data === null || typeof data !== 'object' || typeof data.content !== 'string' || data.content.trim().length === 0) {
    throw new WebError('the fetch endpoint returned no extractable page body', 'WEB_PROVIDER_ERROR')
  }
  return {
    title: typeof data.title === 'string' ? data.title : '',
    content: data.content,
  }
}

// #endregion

// #region transport

function isAbortError(error) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function requestAborted(signal, fallback) {
  return new WebError('web request aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(requestAborted(signal))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(requestAborted(signal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryAfterMs(response) {
  const header = response.headers?.get?.('retry-after')
  if (typeof header !== 'string') return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8000)
  return undefined
}

async function postJson(endpoint, apiKey, body, signal, options) {
  const attempts = Math.max(0, options.maxRetries)
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted === true) throw requestAborted(signal)
    let response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Ask gateways not to compress: the primary defence, with magic-byte
          // inflation as the net.
          'accept-encoding': 'identity',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      if (attempt < attempts) {
        await sleep(options.retryDelayMs * 2 ** attempt, signal)
        continue
      }
      throw new WebError(`DeepSeek web request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      try {
        const parsed = await readJsonResponse(response)
        const detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
        if (typeof detail === 'string' && detail.length > 0) message = detail
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        const delay = retryAfterMs(response) ?? options.retryDelayMs * 2 ** attempt
        await sleep(delay, signal)
        continue
      }
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      return await readJsonResponse(response)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      throw new WebError(`DeepSeek returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

// #endregion

// #region request validation

function normalizeCount(requested, fallback) {
  const value = requested ?? fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new WebError('"maxResults" must be a positive integer', 'WEB_PROVIDER_ERROR')
  }
  return Math.min(value, MAX_COUNT)
}

export function validateFetchUrl(raw) {
  const url = typeof raw === 'string' ? raw.trim() : ''
  if (url.length === 0) throw new WebError('web fetch requires a non-empty "url"', 'WEB_PROVIDER_ERROR')
  if (url.length > MAX_FETCH_URL_CHARS) {
    throw new WebError(`"url" must be at most ${MAX_FETCH_URL_CHARS} characters`, 'WEB_PROVIDER_ERROR')
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new WebError(`"url" is not a valid absolute url: ${url}`, 'WEB_PROVIDER_ERROR')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebError(`"url" must be an http or https url, got: ${parsed.protocol}`, 'WEB_PROVIDER_ERROR')
  }
  if (parsed.host.length === 0) throw new WebError('"url" must include a host', 'WEB_PROVIDER_ERROR')
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new WebError('"url" must not carry a username or password', 'WEB_PROVIDER_ERROR')
  }
  return url
}

export function validateSearchQuery(raw) {
  const query = typeof raw === 'string' ? raw.trim() : ''
  if (query.length === 0) throw new WebError('web search requires a non-empty "query"', 'WEB_PROVIDER_ERROR')
  if (query.length > MAX_QUERY_CHARS) {
    throw new WebError(`"query" must be at most ${MAX_QUERY_CHARS} characters`, 'WEB_PROVIDER_ERROR')
  }
  return query
}

// #endregion

// #region providers

/** DeepSeek `/v1/tools/search` as a `WebSearchProvider`. */
export class DeepSeekSearchProvider {
  id = PROVIDER_ID
  options

  constructor(options) {
    this.options = options
  }

  available() {
    return this.options.apiKey.length > 0 && isValidBaseURL(this.options.baseURL)
  }

  async search(request, signal) {
    assertUsable(this.options)
    const query = validateSearchQuery(request?.query)
    if (signal?.aborted === true) throw requestAborted(signal)
    const count = normalizeCount(request?.maxResults, this.options.count)
    const data = await postJson(endpointOf(this.options.baseURL, SEARCH_PATH), this.options.apiKey, { query, count }, signal, this.options)
    return { sources: toSources(mapSearchResults(data)), truncated: false }
  }
}

/** DeepSeek `/v1/tools/fetch` as a `WebFetchProvider`. */
export class DeepSeekFetchProvider {
  id = PROVIDER_ID
  options

  constructor(options) {
    this.options = options
  }

  available() {
    return this.options.apiKey.length > 0 && isValidBaseURL(this.options.baseURL)
  }

  async fetch(request, signal) {
    assertUsable(this.options)
    const url = validateFetchUrl(request?.url)
    if (signal?.aborted === true) throw requestAborted(signal)
    const data = await postJson(endpointOf(this.options.baseURL, FETCH_PATH), this.options.apiKey, { url }, signal, this.options)
    const page = mapFetchPage(data)
    return {
      url,
      // DeepSeek reports its own extraction status, not the origin page's, so
      // a body returned here is presented as a successful retrieval.
      statusCode: 200,
      body: { kind: 'text', content: page.content },
      truncated: false,
    }
  }
}

// #endregion

// #region plugin

/** Register both DeepSeek providers with `ctx.web`. */
export function apply(ctx, config) {
  const options = resolveOptions(launchEnvironmentOf(ctx), config)
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(options))
  ctx.web.registerFetchProvider(new DeepSeekFetchProvider(options))
}

// #endregion
