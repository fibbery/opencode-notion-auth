// The plugin against a stand-in for Notion: no account, no network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { NotionPlugin, _internal } from '../index.mjs'
import { buildConfigValue, normalizeEffort } from '../notion-api.mjs'

const { mergeAccountModels, slugModelID, modelEntry, requestedEffort } = _internal
import { parseUserContent } from '../notion-api.mjs'

const USER_CONTENT = {
  recordMap: {
    notion_user: { 'user-1': { value: { value: { email: 'ada@example.com', name: 'Ada' } } } },
    user_root: { 'user-1': { value: { value: { space_view_pointers: [{ spaceId: 'space-1', id: 'view-1' }] } } } },
    space: {
      'space-1': {
        value: { value: { id: 'space-1', name: 'Test Space', plan_type: 'personal', settings: { enable_ai_feature: true } } },
      },
    },
  },
}

function ndjson(lines) {
  return lines.map((line) => `${JSON.stringify(line)}\n`)
}

const ANSWER_LINES = [
  { type: 'patch', v: [{ o: 'a', p: '/s/-', v: { id: 's1', type: 'agent-inference', value: [] } }] },
  { type: 'patch', v: [{ o: 'a', p: '/s/0/value/-', v: { type: 'text', content: 'Hel' } }] },
  { type: 'patch', v: [{ o: 'x', p: '/s/0/value/0/content', v: 'lo' }] },
  { type: 'agent-inference', id: 's1', finishedAt: 't', value: [{ type: 'text', content: 'Hello!' }] },
]

const TOOL_LINES = [
  { type: 'patch', v: [{ o: 'a', p: '/s/-', v: { id: 's1', type: 'agent-inference', value: [] } }] },
  {
    type: 'agent-inference',
    id: 's1',
    finishedAt: 't',
    value: [{ type: 'text', content: '{"tool":"Read","arguments":{"file_path":"a.txt"}}' }],
  },
]

// What the account's own model list looks like: the same shape Notion nests
// inside a string, with models our table has never heard of.
const AVAILABLE_MODELS = {
  models: JSON.stringify({
    models: [
      { model: 'oval-kumquat-medium', modelMessage: 'GPT-5.4', modelFamily: 'openai', workflow: { finalModelName: 'oval-kumquat-medium' } },
      { model: 'gingerbread', modelMessage: 'Gemini 3 Flash', modelFamily: 'gemini', displayGroup: 'fast' },
      { model: 'apricot-sorbet-high', modelMessage: 'Opus 4.7', modelFamily: 'anthropic', displayGroup: 'intelligent', modelConfiguration: { supportedReasoningEfforts: ['high'], defaultReasoningEffort: 'high' }, workflow: { finalModelName: 'apricot-sorbet-high' } },
      { model: 'albuquerque-quinn', modelMessage: 'Opus 5.5', modelFamily: 'anthropic', displayGroup: 'intelligent', modelConfiguration: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' }, workflow: { finalModelName: 'albuquerque-quinn', beta: true } },
      { model: 'achira-donut', modelMessage: 'Sonnet 5.5', modelFamily: 'anthropic', displayGroup: 'intelligent' },
      { model: 'retired-thing', modelMessage: 'Retired', isDisabled: true },
    ],
  }),
}

let server
let origin
let seen = []
let modelsFail = false

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/login') {
        return new Response('<html data-notion-version="25.10.16.1"></html>', { headers: { 'content-type': 'text/html' } })
      }
      const body = await request.json().catch(() => ({}))
      seen.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body })
      if (url.pathname === '/api/v3/loadUserContent') return Response.json(USER_CONTENT)
      if (url.pathname === '/api/v3/getAvailableModels') {
        if (modelsFail) return new Response('nope', { status: 500 })
        return Response.json(AVAILABLE_MODELS)
      }
      if (url.pathname === '/api/v3/runInferenceTranscript') {
        // The plugin sends Notion a transcript, not the client's request: the
        // tool catalog in its prompt is what says tools were declared.
        const lines = JSON.stringify(body).includes('Tool catalog:') ? TOOL_LINES : ANSWER_LINES
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            // Split lines across chunks on purpose: the reader must not care.
            const text = ndjson(lines).join('')
            for (const piece of text.match(/[\s\S]{1,17}/g) ?? []) controller.enqueue(encoder.encode(piece))
            controller.close()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })
      }
      return new Response('not found', { status: 404 })
    },
  })
  origin = `http://127.0.0.1:${server.port}`
  process.env.NOTION_API_BASE = origin
})

afterAll(() => {
  server.stop(true)
  delete process.env.NOTION_API_BASE
})

function stubClient() {
  const saved = []
  return {
    saved,
    client: {
      auth: {
        async set(input) {
          saved.push(input)
          return { data: undefined }
        },
      },
    },
  }
}

async function pluginFetch({ body, auth = { type: 'api', key: 'token-abc', metadata: {} } } = {}) {
  const { client, saved } = stubClient()
  const hooks = await NotionPlugin({ client })
  const loader = await hooks.auth.loader(async () => auth)
  const response = await loader.fetch(`${origin}/api/v3/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { response, saved, hooks }
}

describe('plugin', () => {
  test('declares the provider and its models', async () => {
    const hooks = await NotionPlugin({ client: {} })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    expect(cfg.provider.notion.name).toBe('Notion AI')
    expect(Object.keys(cfg.provider.notion.models)).toContain('opus-4.7')
    expect(cfg.provider.notion.models['opus-4.7'].id).toBe('apricot-sorbet-medium')
    expect(cfg.provider.notion.models['opus-4.7'].api).toEqual({ id: 'apricot-sorbet-medium' })
  })

  test('answers a non-streaming request', async () => {
    const { response, saved } = await pluginFetch({
      body: { model: 'apricot-sorbet-medium', messages: [{ role: 'user', content: 'hi' }], stream: false },
    })
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.choices[0].message.content).toBe('Hello!')
    expect(payload.choices[0].finish_reason).toBe('stop')
    // what Notion was sent
    const call = seen.at(-1)
    expect(call.path).toBe('/api/v3/runInferenceTranscript')
    expect(call.headers.cookie).toBe('token_v2=token-abc')
    expect(call.headers['notion-client-version']).toBe('25.10.16.1')
    expect(call.headers['x-notion-space-id']).toBe('space-1')
    expect(call.headers['x-notion-active-user-header']).toBe('user-1')
    expect(call.body.spaceId).toBe('space-1')
    expect(call.body.createThread).toBe(true)
    expect(call.body.transcript.at(-1).value[0][0]).toContain('Conversation:\nhi')
    expect(call.body.transcript.at(-1).value[0][0]).toContain('You plan for a coding agent')
    // the discovered account is kept, so the next request skips discovery
    expect(saved[0].body.metadata.spaceId).toBe('space-1')
  })

  test('streams a chat reply chunk by chunk', async () => {
    const { response } = await pluginFetch({
      body: { model: 'oval-kumquat-medium', messages: [{ role: 'user', content: 'hi' }], stream: true },
    })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const text = await response.text()
    expect(text).toContain('data: [DONE]')
    const deltas = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)))
      .map((chunk) => chunk.choices[0].delta.content)
      .filter(Boolean)
    expect(deltas.join('')).toBe('Hello!')
    expect(deltas.length).toBeGreaterThan(1)
  })

  test('holds the reply back and answers with a tool call', async () => {
    const { response } = await pluginFetch({
      body: {
        model: 'apricot-sorbet-medium',
        messages: [{ role: 'user', content: 'read a.txt' }],
        stream: true,
        tools: [
          { type: 'function', function: { name: 'Read', parameters: { type: 'object' } } },
        ],
      },
    })
    const text = await response.text()
    const chunks = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map((line) => JSON.parse(line.slice(6)))
    const call = chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])[0]
    expect(call.function.name).toBe('Read')
    expect(JSON.parse(call.function.arguments)).toEqual({ file_path: 'a.txt' })
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls')
  })

  test('marks the account when Notion refuses the sign-in', async () => {
    const { response } = await pluginFetch({
      body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
      auth: { type: 'api', key: '', metadata: {} },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-magpie-sign-in')).toBe('expired')
  })

  test('lists what the account has, asked about its space', async () => {
    modelsFail = false
    seen.length = 0
    const hooks = await NotionPlugin({ client: {} })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const base = cfg.provider.notion.models
    const models = await hooks.provider.models({ models: base }, { auth: { key: 'token-abc', metadata: {} } })

    expect(models['opus-5.5']).toMatchObject({ name: 'Opus 5.5', id: 'albuquerque-quinn', api: { id: 'albuquerque-quinn' } })
    expect(models['sonnet-5.5'].id).toBe('achira-donut')
    expect(models['opus-4.7'].id).toBe('apricot-sorbet-high')
    // a model our table knew keeps the id it had
    expect(models['gemini-3-flash'].id).toBe('gingerbread')
    expect(models.auto).toBeDefined()
    expect(models['retired-thing']).toBeUndefined()
    // a model the account does not list is not offered
    expect(models['minimax-m2.5']).toBeUndefined()
    // the list is asked for with the space, which Notion requires
    const asked = seen.find((call) => call.path === '/api/v3/getAvailableModels')
    expect(asked.body).toEqual({ spaceId: 'space-1' })
  })

  test('keeps the table it had when the list cannot be read', async () => {
    modelsFail = true
    try {
      const hooks = await NotionPlugin({ client: {} })
      const cfg = { provider: {} }
      await hooks.config(cfg)
      const base = cfg.provider.notion.models
      const models = await hooks.provider.models({ models: base }, { auth: { key: 'token-abc', metadata: {} } })
      expect(models).toBe(base)
    } finally {
      modelsFail = false
    }
  })

  test('offers the levels a model serves, and only when there is a choice', async () => {
    modelsFail = false
    const hooks = await NotionPlugin({ client: {} })
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const models = await hooks.provider.models(
      { models: cfg.provider.notion.models },
      { auth: { key: 'token-abc', metadata: {} } },
    )
    expect(Object.keys(models['opus-5.5'].variants)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    // a model with one level needs no choice: its code already carries it
    expect(models['opus-4.7'].variants).toBeUndefined()
    expect(models['auto'].variants).toBeUndefined()
  })

  test('sends the level the caller asked for, in the config step', async () => {
    const { response, saved } = await pluginFetch({
      body: {
        model: 'albuquerque-quinn',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        reasoning_effort: 'high',
      },
    })
    await response.json()
    const call = seen.at(-1)
    const config = call.body.transcript.find((item) => item.type === 'config')
    expect(config.value.reasoningEffort).toBe('high')
    expect(saved).toBeDefined()
  })

  test('leaves the level out when nothing asked, or the model serves one', async () => {
    await pluginFetch({ body: { model: 'apricot-sorbet-high', messages: [{ role: 'user', content: 'hi' }], stream: false } })
    const config = seen.at(-1).body.transcript.find((item) => item.type === 'config')
    expect('reasoningEffort' in config.value).toBe(false)
  })

  test('reads the level an agent asked for, however it names it', () => {
    expect(requestedEffort({ reasoning_effort: 'high' })).toBe('high')
    expect(requestedEffort({ reasoning: { effort: 'Medium' } })).toBe('medium')
    expect(requestedEffort({ reasoningEffort: 'ultra' })).toBe('max')
    expect(requestedEffort({ reasoning_effort: 'turbo' })).toBe('')
    expect(requestedEffort({})).toBe('')
  })

  test('knows the levels Notion has', () => {
    expect(normalizeEffort('ultra')).toBe('max')
    expect(normalizeEffort('off')).toBe('none')
    expect(normalizeEffort('xhigh', ['low', 'high'])).toBe('')
    expect(buildConfigValue({ effort: 'high' }).reasoningEffort).toBe('high')
    expect('reasoningEffort' in buildConfigValue({})).toBe(false)
    expect(modelEntry({ name: 'x', code: 'c', efforts: ['high'] }, 'x').variants).toBeUndefined()
  })

  test('names an unknown model after what Notion calls it', () => {
    expect(slugModelID('Opus 5.5')).toBe('opus-5.5')
    expect(slugModelID('Claude Opus 5.5')).toBe('opus-5.5')
    expect(slugModelID('GPT-5.4')).toBe('gpt-5.4')
    expect(slugModelID('GPT-6.1 Sol')).toBe('gpt-6.1-sol')
    expect(slugModelID('Grok Build 0.1')).toBe('grok-build-0.1')
    expect(slugModelID('')).toBe('')
    const models = mergeAccountModels(
      { 'opus-4.7': { id: 'apricot-sorbet-medium', name: 'Opus 4.7' } },
      [{ name: 'Opus 4.7', apiId: 'apricot-sorbet-medium' }, { name: 'Opus 5.5', apiId: 'albuquerque-quinn' }],
    )
    expect(Object.keys(models)).toEqual(['opus-4.7', 'opus-5.5'])
  })

  test('reads the space out of a record map', () => {
    const parsed = parseUserContent(USER_CONTENT)
    expect(parsed).toMatchObject({ userId: 'user-1', spaceId: 'space-1', spaceViewId: 'view-1', email: 'ada@example.com' })
  })
})
