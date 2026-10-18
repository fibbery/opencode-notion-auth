// The email-code login, against a stand-in for Notion's login endpoints.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { createCookieJar, finishEmailLogin, startEmailLogin } from '../notion-login.mjs'
import { NotionPlugin } from '../index.mjs'

const USER_CONTENT = {
  recordMap: {
    notion_user: { 'user-1': { value: { value: { email: 'ada@example.com', name: 'Ada' } } } },
    user_root: { 'user-1': { value: { value: { space_view_pointers: [{ spaceId: 'space-1', id: 'view-1' }] } } } },
    space: { 'space-1': { value: { value: { id: 'space-1', name: 'Test Space', plan_type: 'personal', settings: { enable_ai_feature: true } } } } },
  },
}

let server
let origin
let calls = []
let rejectCode = false

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : null
      calls.push({ path: url.pathname, body, cookie: request.headers.get('cookie') ?? '' })
      if (url.pathname === '/login') {
        return new Response('<html data-notion-version="25.10.16.1"></html>', {
          headers: { 'set-cookie': 'notion_browser_id=device-from-notion; Path=/; HttpOnly' },
        })
      }
      if (url.pathname === '/api/v3/getLoginOptions') {
        if (body?.email === 'nobody@example.com') return new Response('{"message":"no account"}', { status: 404 })
        return Response.json({ loginOptionsToken: 'options-token' })
      }
      if (url.pathname === '/api/v3/sendTemporaryPassword') return Response.json({ csrfState: 'csrf-state' })
      if (url.pathname === '/api/v3/loginWithEmail') {
        if (rejectCode) return new Response('that code is wrong', { status: 400 })
        return new Response(JSON.stringify({ userId: 'user-1' }), {
          headers: { 'set-cookie': 'token_v2=token-from-login; Path=/; HttpOnly' },
        })
      }
      if (url.pathname === '/api/v3/loadUserContent') return Response.json(USER_CONTENT)
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

afterEach(() => {
  rejectCode = false
  calls = []
})

describe('cookie jar', () => {
  test('keeps what a response set and sends it back', () => {
    const jar = createCookieJar()
    jar.absorb(new Response('', { headers: { 'set-cookie': 'a=1; Path=/; HttpOnly' } }))
    jar.absorb(new Response('', { headers: { 'set-cookie': 'b=2; Path=/' } }))
    expect(jar.get('a')).toBe('1')
    expect(jar.header()).toBe('a=1; b=2')
  })
})

describe('email login', () => {
  test('asks Notion for a code, then swaps the code for a cookie', async () => {
    const state = await startEmailLogin('ada@example.com')
    expect(state.clientVersion).toBe('25.10.16.1')
    expect(state.deviceId).toBe('device-from-notion')
    expect(state.csrfState).toBe('csrf-state')

    const sent = calls.find((call) => call.path === '/api/v3/sendTemporaryPassword')
    expect(sent.body).toMatchObject({
      email: 'ada@example.com',
      loginOptionsToken: 'options-token',
      deviceId: 'device-from-notion',
      loginRouteOrigin: 'login',
      native: false,
      isSignup: false,
    })
    expect(calls[0].path).toBe('/login')

    const done = await finishEmailLogin(state, '123456')
    expect(done.token).toBe('token-from-login')
    // the device cookie Notion set comes along: the session is more than the token
    expect(done.cookieHeader).toBe('token_v2=token-from-login; notion_browser_id=device-from-notion')
    expect(done.userId).toBe('user-1')
    const verify = calls.find((call) => call.path === '/api/v3/loginWithEmail')
    expect(verify.body).toEqual({ state: 'csrf-state', password: '123456', loginRouteOrigin: 'login' })
    expect(verify.cookie).toContain('notion_browser_id=device-from-notion')
  })

  test('refuses an address that is not one', async () => {
    await expect(startEmailLogin('not-an-email')).rejects.toThrow(/email address/)
  })

  test('reports a wrong code', async () => {
    const state = await startEmailLogin('ada@example.com')
    rejectCode = true
    await expect(finishEmailLogin(state, '000000')).rejects.toThrow(/400/)
  })
})

describe('sign-in methods', () => {
  test('offers the three ways in', async () => {
    const hooks = await NotionPlugin({ client: { auth: { set: async () => ({}) } } })
    const kinds = hooks.auth.methods.map((method) => method.type)
    expect(kinds).toEqual(['oauth', 'oauth', 'api'])
    expect(hooks.auth.methods[0].prompts[0].key).toBe('email')
  })

  test('the email method sends a code and saves what comes back', async () => {
    const hooks = await NotionPlugin({ client: { auth: { set: async () => ({}) } } })
    const method = hooks.auth.methods[0]
    expect(method.prompts[0].validate('ada@example.com')).toBeUndefined()
    expect(method.prompts[0].validate('nope')).toMatch(/email address/)

    const handoff = await method.authorize({ email: 'ada@example.com' })
    expect(handoff.method).toBe('code')
    expect(handoff.instructions).toContain('ada@example.com')

    const result = await handoff.callback('123456')
    expect(result.type).toBe('success')
    expect(result.key).toContain('token_v2=token-from-login')
    expect(result.metadata).toMatchObject({ spaceId: 'space-1', userId: 'user-1', email: 'ada@example.com' })
  })

  test('a failure while sending has to throw, not return', async () => {
    const hooks = await NotionPlugin({ client: { auth: { set: async () => ({}) } } })
    await expect(hooks.auth.methods[0].authorize({ email: 'nobody@example.com' })).rejects.toThrow(/404/)
  })
})
