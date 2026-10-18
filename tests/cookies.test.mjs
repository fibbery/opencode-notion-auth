// Which cookies make up a Notion session, and the jar a login fills.
import { describe, expect, test } from 'bun:test'
import { createCookieJar, hasToken, isSessionCookie, sessionCookieHeader } from '../cookies.mjs'

describe('isSessionCookie', () => {
  test('keeps the session and drops the rest', () => {
    for (const name of ['token_v2', 'token_v3', 'notion_browser_id', 'notion_user_id', 'notion_check_cookie_consent']) {
      expect(isSessionCookie(name)).toBe(true)
    }
    for (const name of ['__cf_bm', '_ga', '_fbp', 'tcm', 'g_state', 'notion_experiment_device_id', '', undefined]) {
      expect(isSessionCookie(name)).toBe(false)
    }
  })
})

describe('sessionCookieHeader', () => {
  test('puts the token first and drops what is not part of the session', () => {
    const header = sessionCookieHeader([
      { name: '_ga', value: 'x' },
      { name: 'notion_browser_id', value: 'device' },
      { name: '__cf_bm', value: 'bot' },
      { name: 'token_v2', value: 'the-token' },
    ])
    expect(header).toBe('token_v2=the-token; notion_browser_id=device')
    expect(hasToken(header)).toBe(true)
  })

  test('answers nothing when there is no token', () => {
    const header = sessionCookieHeader([{ name: 'notion_browser_id', value: 'device' }])
    expect(header).toBe('notion_browser_id=device')
    expect(hasToken(header)).toBe(false)
  })
})

describe('createCookieJar', () => {
  test('collects what responses set, in order', () => {
    const jar = createCookieJar()
    jar.absorb(new Response('', { headers: { 'set-cookie': 'notion_browser_id=device; Path=/; HttpOnly' } }))
    jar.absorb(new Response('', { headers: { 'set-cookie': 'token_v2=secret; Path=/' } }))
    expect(jar.sessionHeader()).toBe('token_v2=secret; notion_browser_id=device')
    expect(jar.header()).toBe('notion_browser_id=device; token_v2=secret')
    expect(jar.entries()).toHaveLength(2)
  })
})
