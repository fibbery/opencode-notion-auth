// Reading the user's own Notion session out of a local browser, so nobody has
// to copy a cookie by hand. Chrome and the browsers built on it keep cookies
// in a SQLite file, encrypted with a key macOS keeps in the login keychain;
// that is what this decrypts.
//
// Nothing here is sent anywhere: the cookie is read, checked against Notion,
// and handed to magpie to keep as the account's sign-in.

import { hasToken, isSessionCookie, sessionCookieHeader } from './cookies.mjs'
import { execFile } from 'node:child_process'
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const SUPPORT = join(homedir(), 'Library', 'Application Support')

// Where each browser keeps its profiles, and which keychain item holds its
// cookie key. Arc nests its profiles one level deeper than the others.
const BROWSERS = [
  { name: 'Chrome', dir: join(SUPPORT, 'Google/Chrome'), service: ['Chrome Safe Storage', 'Chrome'] },
  { name: 'Chrome Canary', dir: join(SUPPORT, 'Google/Chrome Canary'), service: ['Chrome Safe Storage', 'Chrome'] },
  { name: 'Chrome Beta', dir: join(SUPPORT, 'Google/Chrome Beta'), service: ['Chrome Safe Storage', 'Chrome'] },
  { name: 'Chromium', dir: join(SUPPORT, 'Chromium'), service: ['Chromium Safe Storage', 'Chromium'] },
  { name: 'Brave', dir: join(SUPPORT, 'BraveSoftware/Brave-Browser'), service: ['Brave Safe Storage', 'Brave'] },
  { name: 'Edge', dir: join(SUPPORT, 'Microsoft Edge'), service: ['Microsoft Edge Safe Storage', 'Microsoft Edge'] },
  { name: 'Vivaldi', dir: join(SUPPORT, 'Vivaldi'), service: ['Vivaldi Safe Storage', 'Vivaldi'] },
  { name: 'Arc', dir: join(SUPPORT, 'Arc/User Data'), service: ['Arc Safe Storage', 'Arc'] },
]

/** The cookie key macOS keeps for a browser, or '' when it is not readable. */
export function browserKey([service, account], { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-w', '-s', service, '-a', account], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve('')
        return
      }
      resolve(String(stdout ?? '').replace(/\n$/, ''))
    })
  })
}

/**
 * Chrome's cookie values: AES-128-CBC under a key derived from the keychain
 * password, with the cookie's host hashed in front of the value so a cookie
 * cannot be moved between sites.
 */
export function decryptChromeValue(encrypted, password, hostKey) {
  const raw = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted ?? [])
  if (raw.length < 3) return ''
  const prefix = raw.subarray(0, 3).toString('utf8')
  if (prefix !== 'v10' && prefix !== 'v11') return raw.toString('utf8')
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  let plain
  try {
    plain = Buffer.concat([decipher.update(raw.subarray(3)), decipher.final()])
  } catch {
    return ''
  }
  if (plain.length <= 32) return ''
  const hostHash = createHash('sha256').update(hostKey).digest()
  // Chrome puts the cookie's host in front of the value, so a cookie copied
  // into another site's row reads as nothing at all.
  if (!plain.subarray(0, 32).equals(hostHash)) return ''
  return plain.subarray(32).toString('utf8')
}

/** Chrome counts microseconds from 1601; 0 means "when the browser closes". */
export function cookieExpiry(expiresUtc) {
  const value = Number(expiresUtc ?? 0)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.floor(value / 1000000 - 11644473600)
}

function profileDirs(browserDir) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(browserDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name) && entry.name !== 'Guest Profile') continue
    const dir = join(browserDir, entry.name)
    if (existsSync(join(dir, 'Cookies'))) out.push({ name: entry.name, dir })
  }
  return out
}

/**
 * Reads one profile's Notion cookies, on a copy so a running browser is safe.
 * `bun:sqlite` is imported here rather than at the top so that a host without
 * it still loads the plugin: only this method goes without.
 */
export async function readProfileCookies(profileDir, { password, host }) {
  const { Database } = await import('bun:sqlite')
  const temp = mkdtempSync(join(tmpdir(), 'notion-cookie-'))
  try {
    const copy = join(temp, 'Cookies')
    copyFileSync(join(profileDir, 'Cookies'), copy)
    for (const suffix of ['-wal', '-shm']) {
      const from = join(profileDir, `Cookies${suffix}`)
      if (existsSync(from)) copyFileSync(from, `${copy}${suffix}`)
    }
    const db = new Database(copy, { readonly: true })
    try {
      const rows = db
        .query('SELECT host_key, name, value, encrypted_value, expires_utc FROM cookies WHERE host_key LIKE ?')
        .all(`%${host}%`)
      const out = []
      for (const row of rows) {
        if (!isSessionCookie(row.name)) continue
        const value = row.value || decryptChromeValue(row.encrypted_value, password, row.host_key)
        if (!value) continue
        const expires = cookieExpiry(row.expires_utc)
        if (expires && expires * 1000 < Date.now()) continue
        out.push({ name: row.name, host: row.host_key, value, expires })
      }
      return out
    } finally {
      db.close()
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

export function listBrowserProfiles(browser) {
  if (!existsSync(browser.dir) || !statSync(browser.dir).isDirectory()) return []
  return profileDirs(browser.dir)
}

/**
 * The first Notion session found on this machine, as the cookie header a
 * request would carry. Never the keychain password, and never a cookie it
 * could not read: what it cannot use, it says so about instead.
 */
export async function readBrowserSession({ host = 'notion', signal } = {}) {
  const tried = []
  for (const browser of BROWSERS) {
    const profiles = listBrowserProfiles(browser)
    if (!profiles.length) continue
    let password = ''
    for (const profile of profiles) {
      if (signal?.aborted) return { cookieHeader: '', tried }
      if (!password) {
        password = await browserKey(browser.service)
        if (!password) {
          tried.push(`${browser.name}: its cookie key is not readable from the keychain`)
          break
        }
      }
      let cookies = []
      try {
        cookies = await readProfileCookies(profile.dir, { password, host })
      } catch (error) {
        tried.push(`${browser.name}/${profile.name}: ${error?.message ?? error}`)
        continue
      }
      const cookieHeader = sessionCookieHeader(cookies)
      if (!hasToken(cookieHeader)) {
        if (cookies.length) tried.push(`${browser.name}/${profile.name}: it has Notion cookies but no token_v2 (not signed in)`)
        continue
      }
      return {
        cookieHeader,
        browser: browser.name,
        profile: profile.name,
        names: cookies.map((cookie) => cookie.name),
        tried,
      }
    }
  }
  return { cookieHeader: '', tried }
}

export { isSessionCookie }

export const _internal = { BROWSERS, SUPPORT }
