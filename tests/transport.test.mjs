import { test, expect } from 'bun:test'
import { runInferenceTranscript } from '../notion-api.mjs'

const transport = await import('../transport.mjs').catch(() => ({}))
function factory(loader) {
  expect(typeof transport.createNotionFetch).toBe('function')
  return transport.createNotionFetch(loader)
}

test('browser transport forwards headers body signal and strips per-request redirects', async () => {
  let settings
  const requests = []
  let loads = 0
  const browserFetch = factory(async () => {
    loads++
    return { Impit: class {
      constructor(options) { settings = options }
      async fetch(url, init) { requests.push({ url, init }); return new Response('OK') }
    } }
  })
  const signal = new AbortController().signal
  const headers = { accept: 'application/x-ndjson' }
  const body = '{}'
  const url = new URL('https://example.invalid/api/v3/runInferenceTranscript')
  expect(await (await browserFetch(url, { method: 'POST', headers, body, signal, redirect: 'follow' })).text()).toBe('OK')
  await browserFetch(url)
  expect(settings).toEqual({ browser: 'chrome', followRedirects: false, timeout: 180_000 })
  expect(requests[0]).toEqual({ url: String(url), init: { method: 'POST', headers, body, signal } })
  expect(requests[0].init.headers).toBe(headers)
  expect(requests[0].init.signal).toBe(signal)
  expect(loads).toBe(1)
})

test('dependency load failure is visible and retryable without native fetch fallback', async () => {
  const original = globalThis.fetch
  let fallbackCalls = 0
  globalThis.fetch = () => { fallbackCalls++; throw new Error('unexpected native fallback') }
  let loads = 0
  const cause = new Error('local dependency load failure')
  const browserFetch = factory(async () => { loads++; throw cause })
  try {
    await expect(browserFetch('https://example.invalid')).rejects.toMatchObject({ name: 'NotionTransportError', status: 503, cause })
    await expect(browserFetch('https://example.invalid')).rejects.toThrow('could not load')
    expect(loads).toBe(2)
    expect(fallbackCalls).toBe(0)
  } finally { globalThis.fetch = original }
})

test('synchronous dependency loader failure is visible', async () => {
  const browserFetch = factory(() => { throw new Error('synchronous loader failure') })
  await expect(browserFetch('https://example.invalid')).rejects.toMatchObject({ status: 503 })
})

test('pre-aborted transport does not send a request', async () => {
  let sent = false
  const browserFetch = factory(async () => ({ Impit: class { fetch() { sent = true; return new Response('unused') } } }))
  const abort = new AbortController()
  abort.abort(new Error('local abort'))
  await expect(browserFetch('https://example.invalid', { signal: abort.signal })).rejects.toThrow('local abort')
  expect(sent).toBe(false)
})

test('explicit inference fetch injection retains workflow model and tool flags', async () => {
  let request
  const signal = new AbortController().signal
  const result = await runInferenceTranscript({ userId: 'local-user', spaceId: 'local-space', cookie: 'local-fixture-only' }, {
    prompt: 'local prompt', notionModel: 'local-model', effort: 'high', signal,
    fetchImpl: async (url, init) => { request = { url, init }; return new Response('local-response') },
  })
  const payload = JSON.parse(request.init.body)
  const config = payload.transcript.find(step => step.type === 'config').value
  expect(payload.threadType).toBe('workflow')
  expect(payload.asPatchResponse).toBe(true)
  expect(config).toMatchObject({ type: 'workflow', model: 'local-model', reasoningEffort: 'high', enableScriptAgent: true, enableAgentThreadTools: false, useWebSearch: false })
  expect(request.init.signal).toBe(signal)
  expect(result.threadId).toBe(payload.threadId)
  expect(await result.response.text()).toBe('local-response')
})
