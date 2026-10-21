import { test, expect } from 'bun:test'
import { _internal, NotionPlugin } from '../index.mjs'
import { applyTranscriptLine, createTranscript } from '../ndjson.mjs'

const errorStep = { type: 'error', message: 'Something went wrong. Please try again later.', subType: 'temporarily-unavailable', isRetryable: false, traceId: 'local-fixture' }
const answer = (content = 'OK-END') => ({ type: 'agent-inference', id: 'answer', finishedAt: 1, value: [{ type: 'text', content }] })
const ndjson = (...events) => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n').body
const record = (step, threadId = 'current') => ({ type: 'record-map', recordMap: { thread: { [threadId]: { value: { value: { messages: ['message'] } } } }, thread_message: { message: { value: { value: { step } } } } } })

for (const [name, event] of [
  ['original patch-start sample', { type: 'patch-start', data: { s: [errorStep] } }],
  ['direct error', errorStep],
  ['appended patch', { type: 'patch', v: [{ o: 'a', p: '/s/-', v: errorStep }] }],
  ['step replacement patch', { type: 'patch', v: [{ o: 'p', p: '/s/0', v: errorStep }] }],
  ['steps array patch', { type: 'patch', v: [{ o: 'p', p: '/s', v: [errorStep] }] }],
  ['current thread record-map', record(errorStep)],
]) {
  test(`upstream ${name} rejects with error metadata`, async () => {
    await expect(_internal.consumeTranscript(ndjson(event), null, { threadId: 'current' })).rejects.toMatchObject({ name: 'NotionUpstreamError', status: 502, subType: errorStep.subType, traceId: 'local-fixture', isRetryable: false })
  })
}

test('partial text followed by an error rejects and cancels its reader', async () => {
  let cancelled = false
  let timer
  const progress = []
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(answer('partial')) + '\n' + JSON.stringify(errorStep) + '\n')); timer = setTimeout(() => c.close(), 100) }, cancel() { cancelled = true; clearTimeout(timer) } })
  await expect(_internal.consumeTranscript(stream, text => progress.push(text))).rejects.toThrow('temporarily-unavailable')
  expect(progress).toEqual(['partial'])
  expect(cancelled).toBe(true)
})

test('patch type transition to error rejects', () => {
  const state = createTranscript()
  applyTranscriptLine(state, { type: 'patch-start', data: { s: [answer()] } })
  expect(() => applyTranscriptLine(state, { type: 'patch', v: [{ o: 'p', p: '/s/0/type', v: 'error' }] })).toThrow('error step')
})

for (const content of ['', '  \n\t']) {
  test(`empty assistant output ${JSON.stringify(content)} is not success`, async () => {
    await expect(_internal.consumeTranscript(content ? ndjson(answer(content)) : new Response('').body, null)).rejects.toThrow('no assistant text')
  })
}

test('normal assistant text and reasoning survive parsing', async () => {
  const event = answer('A complete answer. OK-END')
  event.value.unshift({ type: 'thinking', content: 'Reasoning' })
  expect(await _internal.consumeTranscript(ndjson(event), null)).toMatchObject({ text: 'A complete answer. OK-END', reasoning: 'Reasoning', usageStatus: 'unknown' })
})

test('record-map backfill survives historical errors in another thread', async () => {
  const event = record(answer('Record-map OK-END'))
  event.recordMap.thread.history = { value: { value: { messages: ['old-error'] } } }
  event.recordMap.thread_message['old-error'] = { value: { value: { step: errorStep } } }
  expect((await _internal.consumeTranscript(ndjson(event), null, { threadId: 'current' })).text).toBe('Record-map OK-END')
})

test('ordinary content and nested objects mentioning error are accepted', async () => {
  const event = answer('The word error is ordinary text. OK-END')
  event.metadata = { type: 'error', message: 'not a protocol step' }
  expect((await _internal.consumeTranscript(ndjson(event, { type: 'patch', v: [{ o: 'p', p: '/s/0/value/0/metadata', v: errorStep }] }), null)).text).toBe(event.value[0].content)
})

async function localProvider(handler, action) {
  const oldOrigin = process.env.NOTION_API_BASE
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  process.env.NOTION_API_BASE = server.url.origin
  try {
    const plugin = await NotionPlugin({})
    const provider = await plugin.auth.loader(async () => ({ key: '', metadata: {} }))
    // Use complete synthetic account metadata so discovery never goes online.
    const signedIn = await plugin.auth.loader(async () => ({ key: 'local-fixture-only', metadata: { userId: 'local-user', spaceId: 'local-space', clientVersion: 'local-version' } }))
    return await action(signedIn, provider)
  } finally {
    if (oldOrigin === undefined) delete process.env.NOTION_API_BASE
    else process.env.NOTION_API_BASE = oldOrigin
    server.stop(true)
  }
}

test('buffered upstream business error becomes HTTP 502', async () => {
  await localProvider(() => new Response(ndjson({ type: 'patch-start', data: { s: [errorStep] } })), async provider => {
    const response = await provider.fetch('', { body: JSON.stringify({ messages: [], stream: false }) })
    expect(response.status).toBe(502)
    expect((await response.json()).error.message).toContain('temporarily-unavailable')
  })
})

test('SSE failure after partial text emits error without a successful finish', async () => {
  await localProvider(() => new Response(ndjson(answer('partial'), errorStep)), async provider => {
    const response = await provider.fetch('', { body: JSON.stringify({ messages: [], stream: true }) })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('temporarily-unavailable')
    expect(text).toContain('"code":"temporarily-unavailable"')
    expect(text).not.toContain('"finish_reason":"stop"')
    expect(text).toEndWith('data: [DONE]\n\n')
  })
})

test('tool-enabled stream emits reasoning before final answer for Claude Code', async () => {
  const event = answer('Visible final answer')
  event.value.unshift({ type: 'thinking', content: 'Earlier reasoning' })
  await localProvider(() => new Response(ndjson(event)), async provider => {
    const response = await provider.fetch('', { body: JSON.stringify({ messages: [], stream: true, tools: [{ type: 'function', function: { name: 'Read', parameters: {} } }] }) })
    const stream = await response.text()
    expect(stream.indexOf('"reasoning_content":"Earlier reasoning"')).toBeLessThan(stream.indexOf('"content":"Visible final answer"'))
    expect(stream).toContain('"finish_reason":"stop"')
  })
})

test('expired sign-in remains HTTP 401', async () => {
  await localProvider(() => new Response('unused'), async (_, provider) => {
    const response = await provider.fetch('', { body: '{}' })
    expect(response.status).toBe(401)
    expect(response.headers.get('x-magpie-sign-in')).toBe('expired')
  })
})

test('EOF after partial text rejects as an incomplete answer', async () => {
  const partial = answer('partial')
  delete partial.finishedAt
  await expect(_internal.consumeTranscript(ndjson(partial), null)).rejects.toThrow('before the assistant finished')
})

test('an earlier completed answer cannot validate a newer incomplete answer', async () => {
  const partial = { ...answer('new partial'), id: 'new-answer' }
  delete partial.finishedAt
  await expect(_internal.consumeTranscript(ndjson(answer('previous'), partial), null)).rejects.toThrow('before the assistant finished')
})

test('a complete matching current-thread record validates partial patches', async () => {
  const partial = answer('Record-map OK-END')
  delete partial.finishedAt
  expect((await _internal.consumeTranscript(ndjson(partial, record(partial)), null, { threadId: 'current' })).text).toBe('Record-map OK-END')
})

test('record-map from another thread cannot validate partial text', async () => {
  const partial = answer('partial')
  delete partial.finishedAt
  await expect(_internal.consumeTranscript(ndjson(partial, record(partial, 'other')), null, { threadId: 'current' })).rejects.toThrow('before the assistant finished')
})

test('abort while the transcript reader is locked immediately cancels the read', async () => {
  const abort = new AbortController()
  let cancelled = false
  let controller
  const stream = new ReadableStream({ start(c) { controller = c }, cancel() { cancelled = true } })
  const pending = _internal.consumeTranscript(stream, null, { signal: abort.signal }).then(() => 'success', e => e)
  abort.abort(new Error('local cancellation'))
  let timer
  const outcome = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('still pending'), 100) })])
  clearTimeout(timer)
  if (!cancelled) controller.close()
  await pending
  expect(outcome).toBeInstanceOf(Error)
  expect(outcome.message).toContain('local cancellation')
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})

test('reader stream timeout after partial text cannot return success', async () => {
  let timer
  const stream = new ReadableStream({ start(c) {
    c.enqueue(new TextEncoder().encode(JSON.stringify(answer('partial')) + '\n'))
    timer = setTimeout(() => c.error(new Error('local stream timeout')), 10)
  }, cancel() { clearTimeout(timer) } })
  await expect(_internal.consumeTranscript(stream, null)).rejects.toThrow('local stream timeout')
})

test('failed native dependency maps to HTTP 503 through the public provider', () => {
  const fixture = new URL('./fixtures/dependency-failure.mjs', import.meta.url)
  const child = Bun.spawnSync([process.execPath, Bun.fileURLToPath(fixture)], { env: { ...process.env, NOTION_API_BASE: 'http://127.0.0.1:1' } })
  expect(child.exitCode).toBe(0)
  expect(child.stderr.toString()).toBe('')
  const result = JSON.parse(child.stdout.toString())
  expect(result.status).toBe(503)
  expect(result.body.error.message).toBe('Notion browser transport could not load')
})

test('completed text tool envelope still becomes a tool call', async () => {
  const envelope = '<tool_call name="local_tool" id="local-call">{"value":"OK-END"}</tool_call>'
  const result = await _internal.consumeTranscript(ndjson(answer(envelope)), null)
  const parsed = _internal.bufferedMessage(result)
  expect(parsed.toolCalls).toHaveLength(1)
  expect(parsed.message.tool_calls[0].function).toEqual({ name: 'local_tool', arguments: '{"value":"OK-END"}' })
})

test('successful patch deltas rebuild the complete answer and final marker', async () => {
  const events = [
    { type: 'patch-start', data: { s: [{ type: 'agent-inference', id: 'answer', value: [{ type: 'text', content: 'Full ' }] }] } },
    { type: 'patch', v: [{ o: 'x', p: '/s/0/value/0/content', v: 'answer ' }] },
    { type: 'patch', v: [{ o: 'x', p: '/s/0/value/0/content', v: 'OK-END' }, { o: 'p', p: '/s/0/finishedAt', v: 1 }] },
  ]
  expect((await _internal.consumeTranscript(ndjson(...events), null)).text).toBe('Full answer OK-END')
})
