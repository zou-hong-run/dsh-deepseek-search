import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  Config,
  DEFAULT_BASE_URL,
  DeepSeekFetchProvider,
  DeepSeekSearchProvider,
  PROVIDER_ID,
  apply,
  boundedQuestion,
  name,
  mapFetchPage,
  mapSearchResults,
  optionsFromConfig,
  resolveApiKey,
  toSources,
  validateFetchUrl,
  validateSearchQuery,
} from '../lib/index.js'

const BASE_OPTIONS = Object.freeze({
  apiKey: 'test-key',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com/v1/tools',
  count: 10,
  maxRetries: 0,
  retryDelayMs: 0,
  sendOriginalQuestion: true,
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

/** A config whose fields are live references, as the Loader hands them to `apply`. */
function liveConfig(overrides = {}) {
  const values = { ...BASE_OPTIONS, apiKey: 'test-key', ...overrides }
  const config = {}
  for (const key of Object.keys(values)) config[key] = { get: () => values[key] }
  return { config, set: (key, value) => { values[key] = value } }
}

function searchProvider(overrides = {}) {
  return new DeepSeekSearchProvider(() => options(overrides), async () => 'test-key')
}

function mockFetch(handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return () => {
    globalThis.fetch = original
  }
}

/** Run `body` with selected environment variables, restoring them afterwards. */
async function withEnv(values, body) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await body()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('plugin identity: exported name and provider id are stable', () => {
  assert.equal(name, 'dsh-deepseek-search')
  assert.equal(PROVIDER_ID, 'deepseek-search')
  assert.equal(DEFAULT_BASE_URL, 'https://api.deepseek.com/v1/tools')
})

test('Config: every field is volatile and apiKeyEnv is a credential reference', () => {
  const schema = Config.toJSON()
  const dict = schema.refs[schema.uid].dict
  const fields = Object.fromEntries(Object.entries(dict).map(([key, id]) => [key, schema.refs[id]]))
  for (const key of ['apiKey', 'apiKeyEnv', 'baseURL', 'count', 'maxRetries', 'retryDelayMs', 'sendOriginalQuestion']) {
    assert.equal(fields[key]?.meta?.volatile, true, `${key} must be volatile`)
  }
  assert.equal(fields.apiKey.meta.role, 'secret')
  assert.equal(fields.apiKeyEnv.meta.role, 'credential-ref')
})

test('optionsFromConfig: applies defaults and reads live references', () => {
  assert.deepEqual(optionsFromConfig({}), {
    apiKey: '',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: 'https://api.deepseek.com/v1/tools',
    count: 10,
    maxRetries: 2,
    retryDelayMs: 800,
    sendOriginalQuestion: true,
  })

  const { config, set } = liveConfig({ count: 4 })
  assert.equal(optionsFromConfig(config).count, 4)
  set('count', 6)
  assert.equal(optionsFromConfig(config).count, 6)

  assert.equal(optionsFromConfig({ apiKeyEnv: 'not a ref' }).apiKeyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(optionsFromConfig({ count: 500 }).count, 50)
  assert.equal(optionsFromConfig({ count: 0 }).count, 10)
  assert.equal(optionsFromConfig({ sendOriginalQuestion: 'no' }).sendOriginalQuestion, true)
})

test('resolveApiKey: literal wins over the credential service and the environment', async () => {
  const ctx = { get: (key) => (key === 'credentials' ? { resolve: async () => ({ value: 'stored-key' }) } : undefined) }
  await withEnv({ DEEPSEEK_API_KEY: 'env-key' }, async () => {
    assert.equal(await resolveApiKey(ctx, options(), undefined), 'test-key')
    assert.equal(await resolveApiKey(ctx, options({ apiKey: '' }), undefined), 'stored-key')
  })
})

test('resolveApiKey: falls back to the launching environment when nothing is stored', async () => {
  const ctx = { get: () => undefined }
  await withEnv({ DEEPSEEK_API_KEY: 'env-key' }, async () => {
    assert.equal(await resolveApiKey(ctx, options({ apiKey: '' }), undefined), 'env-key')
  })
  const emptyStore = { get: (key) => (key === 'credentials' ? { resolve: async () => undefined } : undefined) }
  await withEnv({ DEEPSEEK_API_KEY: 'env-key' }, async () => {
    assert.equal(await resolveApiKey(emptyStore, options({ apiKey: '' }), undefined), 'env-key')
  })
  await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
    await assert.rejects(
      resolveApiKey(ctx, options({ apiKey: '' }), undefined),
      (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING' && error.message.includes('DEEPSEEK_API_KEY'),
    )
  })
})

test('resolveApiKey: a failing credential resolver is a provider error, not a missing key', async () => {
  const ctx = { get: (key) => (key === 'credentials' ? { resolve: async () => { throw new Error('vault offline') } } : undefined) }
  await assert.rejects(
    resolveApiKey(ctx, options({ apiKey: '' }), undefined),
    (error) => error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('vault offline'),
  )
})

test('resolveApiKey: an already-aborted signal fails as WEB_ABORTED before resolving', async () => {
  let resolved = false
  const ctx = { get: (key) => (key === 'credentials' ? { resolve: async () => { resolved = true } } : undefined) }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resolveApiKey(ctx, options({ apiKey: '' }), controller.signal), (error) => error.code === 'WEB_ABORTED')
  assert.equal(resolved, false)
})

test('available: local only, and a stored credential is not required up front', () => {
  assert.equal(searchProvider({ apiKey: '' }).available(), true)
  assert.equal(new DeepSeekFetchProvider(() => options({ apiKey: '' }), async () => '').available(), true)
  assert.equal(searchProvider({ baseURL: 'not-a-url' }).available(), false)
  assert.equal(searchProvider({ baseURL: 'ftp://example.com' }).available(), false)
  assert.equal(searchProvider({ count: 0 }).available(), false)
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

test('toSources: uses the snippet, never the long summary, and maps date to publishedAt', () => {
  assert.deepEqual(toSources(mapSearchResults(SEARCH_BODY)), [
    {
      url: 'https://example.com/a',
      title: 'First',
      snippet: 'short a',
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
    const result = await searchProvider().search({ query: '  spaced query  ', maxResults: 5 })
    assert.equal(seen.url, 'https://api.deepseek.com/v1/tools/search')
    assert.equal(seen.init.headers.authorization, 'Bearer test-key')
    assert.equal(seen.init.headers['accept-encoding'], 'identity')
    assert.deepEqual(seen.body, { query: 'spaced query', count: 5, need_content: false })
    assert.equal(result.sources.length, 2)
    assert.equal(result.truncated, false)
    assert.equal(result.content, undefined)
  } finally {
    restore()
  }
})

test('search: a long query is sent, not rejected locally', async () => {
  let body
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  try {
    const query = 'q'.repeat(400)
    await searchProvider().search({ query })
    assert.equal(body.query, query)
  } finally {
    restore()
  }
})

test('search: sends the triggering question as a bounded ori_question', async () => {
  let body
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  try {
    const provider = new DeepSeekSearchProvider(
      () => ({ ...options(), originalQuestion: () => '  first\n second   ' }),
      async () => 'test-key',
    )
    await provider.search({ query: 'q' })
    assert.equal(body.ori_question, 'first second')

    const long = new DeepSeekSearchProvider(
      () => ({ ...options(), originalQuestion: () => '字'.repeat(200) }),
      async () => 'test-key',
    )
    await long.search({ query: 'q' })
    assert.equal(body.ori_question.length, 128)
    assert.equal(boundedQuestion('  \n '), undefined)

    const off = new DeepSeekSearchProvider(
      () => ({ ...options({ sendOriginalQuestion: false }), originalQuestion: () => 'ignored' }),
      async () => 'test-key',
    )
    await off.search({ query: 'q' })
    assert.equal('ori_question' in body, false)
  } finally {
    restore()
  }
})

test('search: the configured count is the ceiling and the request can only lower it', async () => {
  let body
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  try {
    const provider = searchProvider({ count: 7 })
    await provider.search({ query: 'q' })
    assert.equal(body.count, 7)
    await provider.search({ query: 'q', maxResults: 5 })
    assert.equal(body.count, 5)
    await provider.search({ query: 'q', maxResults: 20 })
    assert.equal(body.count, 7)
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
    const result = await searchProvider({ maxRetries: 1 }).search({ query: 'q' })
    assert.equal(calls, 2)
    assert.equal(result.sources.length, 2)
  } finally {
    restore()
  }
})

test('search: a non-retryable failure keeps the status, the detail, and names the endpoint', async () => {
  let calls = 0
  const restore = mockFetch(async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })
  })
  try {
    await assert.rejects(
      searchProvider({ maxRetries: 2 }).search({ query: 'q' }),
      (error) =>
        error.code === 'WEB_PROVIDER_ERROR' &&
        error.message.includes('HTTP 401') &&
        error.message.includes('invalid api key') &&
        error.message.includes('https://api.deepseek.com/v1/tools/search') &&
        error.message.includes('dsh-deepseek-search.baseURL'),
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
    const result = await searchProvider().search({ query: 'q' })
    assert.equal(result.sources.length, 2)
  } finally {
    restore()
  }
})

test('search: validates the request before any request is made', async () => {
  let called = false
  const restore = mockFetch(async () => {
    called = true
    return new Response('{}', { status: 200 })
  })
  try {
    const provider = searchProvider()
    assert.throws(() => validateSearchQuery('   '), (error) => error.code === 'WEB_PROVIDER_ERROR')
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
    await withEnv({ DEEPSEEK_API_KEY: undefined }, async () => {
      const provider = new DeepSeekSearchProvider(
        () => options({ apiKey: '' }),
        (operation, signal) => resolveApiKey({ get: () => undefined }, operation, signal),
      )
      await assert.rejects(provider.search({ query: 'q' }), (error) => error.code === 'WEB_PROVIDER_CREDENTIAL_MISSING')
    })
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
      searchProvider().search({ query: 'q' }, controller.signal),
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
    const page = await new DeepSeekFetchProvider(() => options(), async () => 'test-key').fetch({
      url: 'https://example.com/article',
    })
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
    const provider = new DeepSeekFetchProvider(() => options(), async () => 'test-key')
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

test('apply: registers one search and one fetch provider and reads config live', async () => {
  const registered = { search: [], fetch: [] }
  const ctx = {
    get: () => undefined,
    web: {
      registerSearchProvider: (provider) => registered.search.push(provider),
      registerFetchProvider: (provider) => registered.fetch.push(provider),
    },
  }
  const { config, set } = liveConfig()
  apply(ctx, config)
  assert.equal(registered.search.length, 1)
  assert.equal(registered.fetch.length, 1)
  assert.equal(registered.search[0].id, 'deepseek-search')
  assert.equal(registered.fetch[0].id, 'deepseek-search')

  let body
  const restore = mockFetch(async (_url, init) => {
    body = JSON.parse(init.body)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  })
  try {
    await registered.search[0].search({ query: 'q' })
    assert.equal(body.count, 10)
    set('count', 3)
    await registered.search[0].search({ query: 'q' })
    assert.equal(body.count, 3)
  } finally {
    restore()
  }
})
