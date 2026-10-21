import { test, expect } from 'bun:test'
import { createServer } from 'node:http'
import { Impit } from 'impit'
import { notionFetch } from '../transport.mjs'
import { NotionPlugin, _internal } from '../index.mjs'

const textEvent = (text, finishedAt) => JSON.stringify({ type: 'agent-inference', id: 'answer', ...(finishedAt ? { finishedAt } : {}), value: [{ type: 'text', content: text }] }) + '\n'
async function localServer(handler, action) {
  const sockets = new Set()
  const server = createServer(handler)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try { return await action(`http://127.0.0.1:${server.address().port}`) }
  finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
}

test('actual Bun loads native Impit and preserves local POST headers/body', async () => {
  expect(typeof Impit).toBe('function')
  await localServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ body, custom: request.headers['x-local-fixture'] }))
  }, async origin => {
    const response = await notionFetch(origin, { method: 'POST', body: '{"local":true}', headers: { 'x-local-fixture': 'test' } })
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ body: '{"local":true}', custom: 'test' })
  })
})

test('actual browser transport refuses redirects even if caller requests follow', async () => {
  let followed = false
  await localServer((request, response) => {
    if (request.url === '/next') { followed = true; response.end('should not arrive') }
    else { response.writeHead(302, { location: '/next' }); response.end('redirect') }
  }, async origin => {
    const response = await notionFetch(origin, { redirect: 'follow' })
    expect(response.status).toBe(302)
    await response.text()
    expect(followed).toBe(false)
  })
})

test('native stream timeout after completed-looking partial text fails visibly', async () => {
  await localServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write(textEvent('partial', 1))
  }, async origin => {
    const response = await notionFetch(origin, { timeout: 100 })
    await expect(_internal.consumeTranscript(response.body, null)).rejects.toThrow(/timeout|timed\s*out/i)
  })
})

test('native cancellation interrupts a locked body read', async () => {
  await localServer((request, response) => { response.writeHead(200); response.write('\n') }, async origin => {
    const abort = new AbortController()
    const response = await notionFetch(origin, { signal: abort.signal })
    const result = _internal.consumeTranscript(response.body, null, { signal: abort.signal })
    const timer = setTimeout(() => abort.abort(new Error('local native cancellation')), 30)
    try { await expect(result).rejects.toThrow('local native cancellation') }
    finally { clearTimeout(timer) }
    expect(response.body.locked).toBe(false)
  })
})

test('SSE consumer cancellation stops the locked upstream without controller errors', async () => {
  let closed
  const cancelled = new Promise(resolve => { closed = resolve })
  await localServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write(textEvent('partial'))
    response.on('close', () => closed(true))
  }, async origin => {
    const previousOrigin = process.env.NOTION_API_BASE
    process.env.NOTION_API_BASE = origin
    try {
      const plugin = await NotionPlugin({})
      const provider = await plugin.auth.loader(async () => ({ key: 'local-fixture-only', metadata: { userId: 'local-user', spaceId: 'local-space', clientVersion: 'local-version' } }))
      const response = await provider.fetch('', { body: JSON.stringify({ messages: [], stream: true }) })
      const reader = response.body.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('partial')
      await reader.cancel('local downstream cancellation')
      let timer
      const outcome = await Promise.race([cancelled, new Promise(resolve => { timer = setTimeout(() => resolve(false), 300) })])
      clearTimeout(timer)
      expect(outcome).toBe(true)
      reader.releaseLock()
    } finally {
      if (previousOrigin === undefined) delete process.env.NOTION_API_BASE
      else process.env.NOTION_API_BASE = previousOrigin
    }
  })
})

test('a local native stream survives more than 30 seconds and includes its full end marker', async () => {
  let timer
  const started = Date.now()
  await localServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    response.write(textEvent('Delayed '))
    timer = setTimeout(() => response.end(textEvent('Delayed complete response OK-END', 1)), 31_000)
    response.on('close', () => clearTimeout(timer))
  }, async origin => {
    const response = await notionFetch(origin)
    expect(await _internal.consumeTranscript(response.body, null)).toMatchObject({ text: 'Delayed complete response OK-END', reasoning: '' })
    expect(Date.now() - started).toBeGreaterThan(30_000)
  })
}, 40_000)
