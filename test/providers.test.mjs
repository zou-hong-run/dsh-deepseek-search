import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  DeepSeekFetchProvider,
  DeepSeekSearchProvider,
  apply,
  mapFetchPage,
  mapSearchResults,
  resolveOptions,
  toSources,
  validateFetchUrl,
  validateSearchQuery,
} from '../lib/index.js'

const BASE_OPTIONS = Object.freeze({
  apiKey: 'test-key',
  baseURL: 'https://api.deepseek.com',
  count: 10,
  maxRetries: 0,
  retryDelayMs: 0,
})

const SEARCH_BODY = {
  results: [
    {
      rerank_score: 2.4,
      title: 'First',
      url: 'https://example.com/a',
      snippet: 'short a',
      summary: 'long a',
      content: '',
      site_name: 'Example',
      site_icon: 'https://example.com/favicon.ico',
      date: '2026-06-01T00:00:00+00:00',
      authority: 3,
    },
    { title: 'Second', url: 'https://example.com/b', snippet: 'snippet b' },
    { title: 'no url' },
    { title: 'duplicate', url: 'https://example.com/a' },
  ],
}

function options(overrides = {}) {
  return { ...BASE_OPTIONS, ...overrides }
}

function mockFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

function environment(values) {
  return { get: (key) => (values[key] === undefined ? undefined : { value: values[key] }) }
}

test('resolveOptions: explicit config wins over both environment variables', () => {
  const env = environment({ DEEPSEEK_SEARCH_API_KEY: 'plugin-env', DEEPSEEK_API_KEY: 'plain-env' })
  assert.equal(resolveOptions(env, { apiKey: 'literal' }).apiKey, 'literal')
  assert.equal(resolveOptions(env, {}).apiKey, 'plugin-env')
  assert.equal(resolveOptions(environment({ DEEPSEEK_API_KEY: 'plain-env' }), {}).apiKey, 'plain-env')
  assert.equal(resolveOptions(environment({}), {}).apiKey, '')

  const defaults = resolveOptions(environment({}), {})
  assert.equal(defaults.baseURL, 'https://api.deepseek.com')
  assert.equal(defaults.count, 10)
  assert.equal(defaults.maxRetries, 2)
  assert.equal(defaults.retryDelayMs, 800)
})

test('available: false without a key or with a non-http base URL, true otherwise', () => {
  assert.equal(new DeepSeekSearchProvider(options({ apiKey: '' })).available(), false)
  assert.equal(new DeepSeekSearchProvider(options({ baseURL: 'not-a-url' })).available(), false)
  assert.equal(new DeepSeekSearchProvider(options({ baseURL: 'ftp://example.com' })).available(), false)
  assert.equal(new DeepSeekSearchProvider(options()).available(), true)
  assert.equal(new DeepSeekFetchProvider(options()).available(), true)
})

test('mapSearchResults: maps fields, drops entries without a url and duplicate urls', () => {
  const results = mapSearchResults(SEARCH_BODY)
  assert.deepEqual(
    results.map((result) => result.url),
    ['https://example.com/a', 'https://example.com/b'],
  )
  assert.deepEqual(results[0], {
    url: 'https://example.com/a',
    title: 'First',
    snippet: 'short a',
    summary: 'long a',
    siteName: 'Example',
    siteIcon: 'https://example.com/favicon.ico',
    date: '2026-06-01T00:00:00+00:00',
    authority: 3,
    rerankScore: 2.4,
  })
  assert.equal('authority' in results[1], false)
})

test('mapSearchResults: rejects a body without a results array, accepts an empty one', () => {
  assert.deepEqual(mapSearchResults({ results: [] }), [])
  assert.throws(() => mapSearchResults({ error: 'nope' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
})

test('toSources: prefers the provider summary and maps date to publishedAt', () => {
  assert.deepEqual(toSources(mapSearchResults(SEARCH_BODY)), [
    {
      url: 'https://example.com/a',
      title: 'First',
      snippet: 'long a',
      publishedAt: '2026-06-01T00:00:00+00:00',
    },
    { url: 'https://example.com/b', title: 'Second', snippet: 'snippet b' },
  ])
})

test('search: posts the native search body and returns normalised sources', async () => {
  let seen
  const restore = mockFetch(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) }
    return new Response(JSON.stringify(SEARCH_BODY), { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options())
    const result = await provider.search({ query: '  spaced query  ', maxResults: 5 })
    assert.equal(seen.url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(seen.init.headers.authorization, 'Bearer test-key')
    assert.equal(seen.init.headers['accept-encoding'], 'identity')
    assert.deepEqual(seen.body, { query: 'spaced query', count: 5 })
    assert.equal(result.sources.length, 2)
    assert.equal(result.truncated, false)
    assert.equal(result.content, undefined)
  } finally {
    restore()
  }
})

test('search: falls back to the configured count and clamps to the API maximum', async () => {
  let body
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options({ count: 7 }))
    await provider.search({ query: 'q' })
    assert.equal(body.count, 7)
    await provider.search({ query: 'q', maxResults: 500 })
    assert.equal(body.count, 50)
  } finally {
    restore()
  }
})

test('search: retries a retryable status and honours retry-after', async () => {
  let calls = 0
  const restore = mockFetch(async () => {
    calls += 1
    if (calls === 1) {
      return new Response(JSON.stringify({ error: { message: 'qps limit' } }), {
        status: 429,
        headers: { 'retry-after': '0' },
      })
    }
    return new Response(JSON.stringify(SEARCH_BODY), { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options({ maxRetries: 1 }))
    const result = await provider.search({ query: 'q' })
    assert.equal(calls, 2)
    assert.equal(result.sources.length, 2)
  } finally {
    restore()
  }
})

test('search: surfaces a non-retryable provider error verbatim', async () => {
  let calls = 0
  const restore = mockFetch(async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options({ maxRetries: 2 }))
    await assert.rejects(
      provider.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_ERROR' && error.message === 'invalid api key',
    )
    assert.equal(calls, 1)
  } finally {
    restore()
  }
})

test('search: inflates a gzip body even though identity was requested', async () => {
  const restore = mockFetch(
    async () =>
      new Response(gzipSync(Buffer.from(JSON.stringify(SEARCH_BODY))), {
        status: 200,
        headers: { 'content-encoding': 'gzip' },
      }),
  )
  try {
    const result = await new DeepSeekSearchProvider(options()).search({ query: 'q' })
    assert.equal(result.sources.length, 2)
  } finally {
    restore()
  }
})

test('search: validates the query before any request is made', async () => {
  let called = false
  const restore = mockFetch(async () => {
    called = true
    return new Response('{}', { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options())
    assert.throws(() => validateSearchQuery('   '), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.throws(() => validateSearchQuery('a'.repeat(129)), (error) => error.code === 'WEB_PROVIDER_ERROR')
    await assert.rejects(provider.search({ query: '  ' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
    await assert.rejects(provider.search({ query: 'q', maxResults: 0 }), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.equal(called, false)
  } finally {
    restore()
  }
})

test('search: reports a missing credential instead of making a request', async () => {
  let called = false
  const restore = mockFetch(async () => {
    called = true
    return new Response('{}', { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(options({ apiKey: '' }))
    await assert.rejects(
      provider.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
    assert.equal(called, false)
  } finally {
    restore()
  }
})

test('search: an already-aborted signal fails as WEB_ABORTED before any request', async () => {
  let called = false
  const restore = mockFetch(async () => {
    called = true
    return new Response('{}', { status: 200 })
  })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      new DeepSeekSearchProvider(options()).search({ query: 'q' }, controller.signal),
      (error) => error.code === 'WEB_ABORTED',
    )
    assert.equal(called, false)
  } finally {
    restore()
  }
})

test('fetch: posts the url and returns a text WebFetchResult', async () => {
  let seen
  const restore = mockFetch(async (url, init) => {
    seen = { url, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ title: 'Example', content: '# Example\n\nbody' }), { status: 200 })
  })
  try {
    const page = await new DeepSeekFetchProvider(options()).fetch({ url: 'https://example.com/article' })
    assert.equal(seen.url, 'https://api.deepseek.com/v1/tools/fetch')
    assert.deepEqual(seen.body, { url: 'https://example.com/article' })
    assert.deepEqual(page, {
      url: 'https://example.com/article',
      statusCode: 200,
      body: { kind: 'text', content: '# Example\n\nbody' },
      truncated: false,
    })
  } finally {
    restore()
  }
})

test('fetch: rejects unusable urls and blank page bodies', async () => {
  let called = false
  const restore = mockFetch(async () => {
    called = true
    return new Response(JSON.stringify({ content: '   ' }), { status: 200 })
  })
  try {
    const provider = new DeepSeekFetchProvider(options())
    assert.throws(() => validateFetchUrl(''), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.throws(() => validateFetchUrl('ftp://example.com'), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.throws(() => validateFetchUrl('/relative'), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.throws(() => validateFetchUrl('https://user:pass@example.com'), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.throws(
      () => validateFetchUrl(`https://example.com/${'a'.repeat(8180)}`),
      (error) => error.code === 'WEB_PROVIDER_ERROR',
    )
    await assert.rejects(provider.fetch({ url: 'file:///etc/passwd' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.equal(called, false)
    await assert.rejects(provider.fetch({ url: 'https://example.com' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
    assert.equal(called, true)
  } finally {
    restore()
  }
})

test('mapFetchPage: keeps the title and requires a non-blank body', () => {
  assert.deepEqual(mapFetchPage({ title: 'T', content: '# T' }), { title: 'T', content: '# T' })
  assert.equal(mapFetchPage({ content: 'x' }).title, '')
  assert.throws(() => mapFetchPage({ title: 'T', content: '  ' }), (error) => error.code === 'WEB_PROVIDER_ERROR')
})

test('apply: registers one search and one fetch provider under the plugin id', () => {
  const registered = []
  const ctx = {
    get: () => undefined,
    web: {
      registerSearchProvider: (provider) => registered.push(['search', provider.id]),
      registerFetchProvider: (provider) => registered.push(['fetch', provider.id]),
    },
  }
  apply(ctx, { apiKey: 'k' })
  assert.deepEqual(registered, [
    ['search', 'deepseek-search'],
    ['fetch', 'deepseek-search'],
  ])
})
