/**
 * dsh-deepseek-search — DeepSeek Search and Fetch API providers for the
 * DeepSeek Harness web capability seam (`ctx.web`).
 *
 * The plugin registers two providers under one id:
 *   - search: POST <baseURL>/search
 *   - fetch:  POST <baseURL>/fetch
 *
 * `baseURL` is the API base *including its path prefix*, so the default
 * `https://api.deepseek.com/v1/tools` reaches `/v1/tools/search` and
 * `/v1/tools/fetch`. That is the same convention
 * `@deepseek-ai/dsh-web-deepseek-api` uses, so one value means one thing on
 * both packages.
 *
 * It owns no model-facing tools: `dsh-tool-web` renders whatever the seam
 * returns. Settings are read once per operation and credentials resolve per
 * operation, so a saved change — a rotated key included — reaches the next
 * search or fetch without a restart.
 *
 * @module dsh-deepseek-search
 */
import { gunzipSync, inflateSync } from 'node:zlib'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-deepseek-search'
/** The web seam this plugin contributes to. */
export const inject = ['web']
/** Stable id both providers register under, one per capability kind. */
export const PROVIDER_ID = 'deepseek-search'
/** Default API base, path prefix included; `/search` and `/fetch` are appended. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/tools'
/** Default credential reference, resolved per operation. */
export const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'

const SEARCH_PATH = '/search'
const FETCH_PATH = '/fetch'
const USER_AGENT = 'dsh-deepseek-search/0.1.0'
const MAX_FETCH_URL_CHARS = 8192
const MAX_COUNT = 50
/** Longest `ori_question` the Search API accepts, in characters. */
const ORIGINAL_QUESTION_MAX_CHARS = 128
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_DECODED_BYTES = 16 * 1024 * 1024
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
/** A credential reference is a POSIX shell identifier, as `ctx.credentials` expects. */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u

export const DEFAULTS = Object.freeze({
  count: 10,
  maxRetries: 2,
  retryDelayMs: 800,
})

/**
 * Plugin configuration. Every field is volatile, so an edit reaches the next
 * operation without a remount.
 *
 * The bundle's browser half renders these fields on the Plugins page through
 * the `plugins.bundle.config` slot; a headless deployment edits the same
 * fields in the profile's `cordis.patch.yml`.
 */
export const Config = z.object({
  apiKey: z.string().role('secret').volatile(),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV).volatile(),
  baseURL: z.string().default(DEFAULT_BASE_URL).volatile(),
  count: z.number().step(1).min(1).max(MAX_COUNT).default(DEFAULTS.count).volatile(),
  maxRetries: z.number().step(1).min(0).default(DEFAULTS.maxRetries).volatile(),
  retryDelayMs: z.number().step(1).min(0).default(DEFAULTS.retryDelayMs).volatile(),
  sendOriginalQuestion: z.boolean().default(true).volatile(),
})

// #region configuration

/** Read one Config field, accepting both a live reference and a plain value. */
function configValue(config, key) {
  const field = config?.[key]
  return field !== undefined && typeof field.get === 'function' ? field.get() : field
}

/** Whether a raw string could name a credential reference at all. */
export function isCredentialRefName(value) {
  return typeof value === 'string' && CREDENTIAL_REF_PATTERN.test(value)
}

/**
 * Snapshot the current settings for one operation.
 *
 * Defaults are applied here rather than by `defaultValue` so a config written
 * before a field existed — or one refreshed by a live settings write — still
 * yields a complete option set.
 *
 * @param config - plugin config, live references or plain values.
 * @returns options for the next operation; never carries a secret beyond the literal `apiKey`.
 */
export function optionsFromConfig(config) {
  const apiKey = configValue(config, 'apiKey')
  const apiKeyEnv = configValue(config, 'apiKeyEnv')
  const baseURL = configValue(config, 'baseURL')
  const count = configValue(config, 'count')
  const maxRetries = configValue(config, 'maxRetries')
  const retryDelayMs = configValue(config, 'retryDelayMs')
  const sendOriginalQuestion = configValue(config, 'sendOriginalQuestion')
  return {
    apiKey: typeof apiKey === 'string' && apiKey.length > 0 ? apiKey : '',
    apiKeyEnv: isCredentialRefName(apiKeyEnv) ? apiKeyEnv : DEFAULT_API_KEY_ENV,
    baseURL: typeof baseURL === 'string' && baseURL.length > 0 ? baseURL : DEFAULT_BASE_URL,
    count: Number.isInteger(count) && count >= 1 ? Math.min(count, MAX_COUNT) : DEFAULTS.count,
    maxRetries: Number.isInteger(maxRetries) && maxRetries >= 0 ? maxRetries : DEFAULTS.maxRetries,
    retryDelayMs: Number.isInteger(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : DEFAULTS.retryDelayMs,
    sendOriginalQuestion: typeof sendOriginalQuestion === 'boolean' ? sendOriginalQuestion : true,
  }
}

/**
 * Resolve this operation's API key: literal config wins over the credential
 * service, which wins over the launching environment.
 *
 * The credential service is authoritative when mounted — it is what the
 * Models page writes and what `.credentials.yaml` backs — so a key saved in
 * the product is used without exporting anything. Reference strings are
 * validated before the lookup: an out-of-grammar name has no stored record
 * and would otherwise read as "not set" with no explanation.
 *
 * @param ctx - plugin context; the credentials service is optional.
 * @param options - the operation's snapshot.
 * @param signal - caller cancellation.
 * @returns the key value.
 * @throws {@link WebError} `WEB_PROVIDER_CREDENTIAL_MISSING` when nothing resolves.
 */
export async function resolveApiKey(ctx, options, signal) {
  throwIfAborted(signal)
  if (options.apiKey.length > 0) return options.apiKey
  const credentials = ctx?.get?.('credentials')
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    let resolved
    try {
      resolved = await credentials.resolve(options.apiKeyEnv)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      throw new WebError(`DeepSeek web credential resolution failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
    throwIfAborted(signal)
    if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
  }
  const ambient = launchEnvironmentOf(ctx)?.get?.(options.apiKeyEnv)
  if (typeof ambient?.value === 'string' && ambient.value.length > 0) return ambient.value
  throw new WebError(
    `DeepSeek web access has no API key for "${options.apiKeyEnv}": store it through the credentials service (the Web Models page writes it), export it in the launching environment, or set a literal "apiKey" in the ${name} config`,
    'WEB_PROVIDER_CREDENTIAL_MISSING',
  )
}

/**
 * Text of the latest human prompt, the question that triggered this turn.
 * Injected user-role context carries another source kind and is skipped.
 *
 * @param session - the initiating Session, when the call runs inside one.
 * @returns the prompt's joined text blocks, or undefined without a prompt.
 */
export function latestUserQuestion(session) {
  const messages = session?.deriveMessages?.()
  if (!Array.isArray(messages)) return undefined
  const prompt = messages.findLast?.((message) => message?.role === 'user' && message?.source?.kind === 'user')
  if (prompt === undefined) return undefined
  return prompt.content?.flatMap?.((block) => (block?.type === 'text' ? [block.text] : [])).join('\n')
}

/**
 * Bound the triggering question to what `ori_question` accepts: whitespace
 * collapses to single spaces and the first 128 characters remain.
 *
 * @param question - the user question, when one exists.
 * @returns the bounded question, or undefined when nothing remains.
 */
export function boundedQuestion(question) {
  const collapsed = typeof question === 'string' ? question.replace(/\s+/gu, ' ').trim() : ''
  if (collapsed.length === 0) return undefined
  return Array.from(collapsed).slice(0, ORIGINAL_QUESTION_MAX_CHARS).join('')
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

function assertUsableBaseURL(baseURL) {
  if (!isValidBaseURL(baseURL)) {
    throw new WebError(`"baseURL" must be an absolute http or https URL, got: ${String(baseURL)}`, 'WEB_PROVIDER_ERROR')
  }
}

function endpointOf(baseURL, path) {
  return `${baseURL.replace(/\/+$/u, '')}${path}`
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0
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
 * `/search` body -> results, minus entries without a URL. Duplicate URLs are
 * removed; an empty array is a legitimate "no matches" answer.
 *
 * Fields the seam has no room for (`site_name`, `site_icon`, authority,
 * rerank score, the long `summary`) are mapped here for diagnostics but never
 * leave `toSources`.
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

/**
 * Map mapped results to the seam's portable source shape.
 *
 * Only `snippet` becomes `snippet`: the Search API's `summary` measured
 * 1,000–2,300 characters per result, so preferring it would multiply the
 * tokens `web_search` returns for no better citation.
 */
export function toSources(results) {
  return results.map((result) => ({
    url: result.url,
    ...(result.title !== undefined ? { title: result.title } : {}),
    ...(result.snippet !== undefined ? { snippet: result.snippet } : {}),
    ...(result.date !== undefined ? { publishedAt: result.date } : {}),
  }))
}

/** `/fetch` body -> page; a blank body is unprocessable. */
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

function throwIfAborted(signal) {
  if (signal?.aborted === true) throw requestAborted(signal)
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

/**
 * Give a post-dispatch failure the endpoint it used and the setting that
 * controls it, so the model can tell the user what to change instead of
 * retrying blindly. Provider failures are otherwise opaque.
 */
function endpointError(subject, endpoint, message, cause) {
  return new WebError(
    `${message}\n\nThe ${subject} request used endpoint ${JSON.stringify(endpoint)}; that endpoint is configured separately from chat. If it is not intended, the user can set ${name}.baseURL to the DeepSeek Search and Fetch API base (default ${DEFAULT_BASE_URL}) and save it. Only the user should choose or change it.`,
    'WEB_PROVIDER_ERROR',
    cause === undefined ? undefined : { cause },
  )
}

async function postJson(endpoint, apiKey, body, signal, options, subject) {
  const attempts = Math.max(0, options.maxRetries)
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal)
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
      throw endpointError(subject, endpoint, `DeepSeek web request failed: ${String(error)}`, error)
    }

    if (!response.ok) {
      let message = `DeepSeek API error (HTTP ${response.status})`
      try {
        const parsed = await readJsonResponse(response)
        const detail = typeof parsed.error === 'string' ? parsed.error : (parsed.error?.message ?? parsed.message)
        if (typeof detail === 'string' && detail.length > 0) message += `: ${detail}`
      } catch (error) {
        if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        const delay = retryAfterMs(response) ?? options.retryDelayMs * 2 ** attempt
        await sleep(delay, signal)
        continue
      }
      throw endpointError(subject, endpoint, message)
    }

    try {
      return await readJsonResponse(response)
    } catch (error) {
      if (signal?.aborted === true || isAbortError(error)) throw requestAborted(signal, error)
      throw endpointError(subject, endpoint, `DeepSeek returned an unprocessable response body: ${String(error)}`, error)
    }
  }
}

// #endregion

// #region request validation

/**
 * Apply the request's result bound. The configured count is the ceiling and a
 * request can only lower it, matching the Search API's documented `count`
 * field; the seam truncates the returned sources regardless.
 */
function normalizeCount(requested, configured) {
  if (requested === undefined) return configured
  if (!isPositiveInteger(requested)) {
    throw new WebError('"maxResults" must be a positive integer', 'WEB_PROVIDER_ERROR')
  }
  return Math.min(configured, requested, MAX_COUNT)
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

/**
 * The Search API bounds `query` itself, so no local cap is imposed here: a
 * long query is a legitimate query, not a caller error.
 */
export function validateSearchQuery(raw) {
  const query = typeof raw === 'string' ? raw.trim() : ''
  if (query.length === 0) throw new WebError('web search requires a non-empty "query"', 'WEB_PROVIDER_ERROR')
  return query
}

// #endregion

// #region providers

/** DeepSeek `/search` as a `WebSearchProvider`. */
export class DeepSeekSearchProvider {
  id = PROVIDER_ID

  /**
   * @param resolveOptions - settings for the NEXT operation, read once at each
   * entry so one call never mixes two settings sections.
   * @param resolveApiKey - credential resolution for one operation.
   */
  constructor(resolveOptions, resolveApiKey) {
    this.resolveOptions = resolveOptions
    this.resolveApiKey = resolveApiKey
  }

  available() {
    const options = this.resolveOptions()
    return isValidBaseURL(options.baseURL) && isPositiveInteger(options.count)
  }

  async search(request, signal) {
    const options = this.resolveOptions()
    const query = validateSearchQuery(request?.query)
    assertUsableBaseURL(options.baseURL)
    throwIfAborted(signal)
    const apiKey = await this.resolveApiKey(options, signal)
    const count = normalizeCount(request?.maxResults, options.count)
    const question = options.sendOriginalQuestion ? boundedQuestion(options.originalQuestion?.()) : undefined
    const endpoint = endpointOf(options.baseURL, SEARCH_PATH)
    const data = await postJson(
      endpoint,
      apiKey,
      {
        query,
        count,
        // Snippets only: the default would return a full extracted page per
        // result, which the seam has nowhere to put.
        need_content: false,
        ...(question === undefined ? {} : { ori_question: question }),
      },
      signal,
      options,
      'Search',
    )
    return { sources: toSources(mapSearchResults(data)), truncated: false }
  }
}

/** DeepSeek `/fetch` as a `WebFetchProvider`. */
export class DeepSeekFetchProvider {
  id = PROVIDER_ID

  /** @param resolveOptions - settings for the NEXT operation. @param resolveApiKey - credential resolution for one operation. */
  constructor(resolveOptions, resolveApiKey) {
    this.resolveOptions = resolveOptions
    this.resolveApiKey = resolveApiKey
  }

  available() {
    return isValidBaseURL(this.resolveOptions().baseURL)
  }

  async fetch(request, signal) {
    const options = this.resolveOptions()
    const url = validateFetchUrl(request?.url)
    assertUsableBaseURL(options.baseURL)
    throwIfAborted(signal)
    const apiKey = await this.resolveApiKey(options, signal)
    const data = await postJson(endpointOf(options.baseURL, FETCH_PATH), apiKey, { url }, signal, options, 'Fetch')
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

/**
 * Register both providers against the live plugin config.
 *
 * The option snapshot is built per operation rather than once at mount: the
 * settings are volatile and a credential can be rotated without restarting
 * the profile.
 */
export function apply(ctx, config) {
  const resolveOptions = () => ({
    ...optionsFromConfig(config),
    originalQuestion: () => latestUserQuestion(ctx.get?.('agents')?.currentInitiator?.()?.session),
  })
  const resolveApiKeyFor = (options, signal) => resolveApiKey(ctx, options, signal)
  ctx.web.registerSearchProvider(new DeepSeekSearchProvider(resolveOptions, resolveApiKeyFor))
  ctx.web.registerFetchProvider(new DeepSeekFetchProvider(resolveOptions, resolveApiKeyFor))
}

// #endregion
