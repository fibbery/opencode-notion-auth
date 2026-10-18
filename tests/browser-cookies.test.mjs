// The browser cookie reader, against a cookie database built for the test.
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cookieExpiry, decryptChromeValue, listBrowserProfiles, readProfileCookies } from '../browser-cookies.mjs'

const PASSWORD = 'test-keychain-password'

function encrypt(hostKey, value, password = PASSWORD, prefix = 'v10') {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  const plain = Buffer.concat([createHash('sha256').update(hostKey).digest(), Buffer.from(value, 'utf8')])
  return Buffer.concat([Buffer.from(prefix, 'utf8'), cipher.update(plain), cipher.final()])
}

function chromeEpoch(secondsFromNow) {
  return Math.floor(((Date.now() + secondsFromNow * 1000) / 1000 + 11644473600) * 1000000)
}

function makeProfile(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'notion-profile-'))
  const db = new Database(join(dir, 'Cookies'))
  db.run('CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, expires_utc INTEGER)')
  for (const row of rows) {
    db.run('INSERT INTO cookies VALUES (?, ?, ?, ?, ?)', [
      row.host ?? '.notion.so',
      row.name ?? 'token_v2',
      row.value ?? '',
      row.encrypted ?? encrypt(row.host ?? '.notion.so', row.plain ?? ''),
      row.expires ?? chromeEpoch(3600),
    ])
  }
  db.close()
  return dir
}

describe('decryptChromeValue', () => {
  test('reads what Chrome wrote', () => {
    const encrypted = encrypt('.notion.so', 'v02%3Asecret')
    expect(decryptChromeValue(encrypted, PASSWORD, '.notion.so')).toBe('v02%3Asecret')
  })

  test('refuses a value written for another host', () => {
    const encrypted = encrypt('.example.com', 'v02%3Asecret')
    expect(decryptChromeValue(encrypted, PASSWORD, '.notion.so')).toBe('')
  })

  test('passes an unencrypted value through', () => {
    expect(decryptChromeValue(Buffer.from('plain-value', 'utf8'), PASSWORD, '.notion.so')).toBe('plain-value')
  })

  test('gives nothing back for a wrong key', () => {
    const encrypted = encrypt('.notion.so', 'v02%3Asecret', 'another-password')
    expect(decryptChromeValue(encrypted, PASSWORD, '.notion.so')).toBe('')
  })
})

describe('cookieExpiry', () => {
  test('converts Chrome time to seconds, and 0 to "no expiry"', () => {
    expect(cookieExpiry(0)).toBe(0)
    expect(cookieExpiry(chromeEpoch(0))).toBeCloseTo(Math.floor(Date.now() / 1000), -1)
  })
})

describe('readProfileCookies', () => {
  test('keeps the session cookies for Notion and nothing else', async () => {
    const dir = makeProfile([
      { plain: 'the-token' },
      { name: '_ga', plain: 'analytics' },
      { name: 'notion_browser_id', plain: 'device' },
      { host: '.example.com', plain: 'not-ours' },
    ])
    try {
      const rows = await readProfileCookies(dir, { password: PASSWORD, host: 'notion' })
      expect(rows.map((row) => row.name).sort()).toEqual(['notion_browser_id', 'token_v2'])
      expect(rows.find((row) => row.name === 'token_v2')).toMatchObject({ host: '.notion.so', value: 'the-token' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('skips an expired cookie', async () => {
    const dir = makeProfile([{ plain: 'stale', expires: chromeEpoch(-3600) }])
    try {
      expect(await readProfileCookies(dir, { password: PASSWORD, host: 'notion' })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('skips a row whose value cannot be decrypted', async () => {
    const dir = makeProfile([{ encrypted: encrypt('.notion.so', 'x', 'another-password') }])
    try {
      expect(await readProfileCookies(dir, { password: PASSWORD, host: 'notion' })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('listBrowserProfiles', () => {
  test('lists the profiles that have a cookie database', () => {
    const dir = makeProfile([{ plain: 'x' }])
    const parent = mkdtempSync(join(tmpdir(), 'notion-browser-'))
    try {
      // a browser directory is "Default" plus its Cookies file
      const { renameSync, mkdirSync } = require('node:fs')
      mkdirSync(join(parent, 'Default'), { recursive: true })
      renameSync(join(dir, 'Cookies'), join(parent, 'Default', 'Cookies'))
      mkdirSync(join(parent, 'Crashpad'), { recursive: true })
      const profiles = listBrowserProfiles({ dir: parent })
      expect(profiles.map((profile) => profile.name)).toEqual(['Default'])
      expect(listBrowserProfiles({ dir: join(parent, 'nowhere') })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(parent, { recursive: true, force: true })
    }
  })
})
