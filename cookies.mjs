// The cookie side of a Notion session: what to keep from a login, and what to
// send with a request. Notion's web app authenticates with `token_v2`; the
// `notion_*` cookies beside it are what it saw the session as, so they go along.

const SESSION_EXACT = new Set(['token_v2', 'token_v3'])
const SESSION_PREFIXES = ['notion_']
// Analytics and Cloudflare's bot cookie are not part of the session, and a
// stale `__cf_bm` is likelier to draw a refusal than to help.
const NOT_SESSION = new Set(['notion_experiment_device_id'])

export function isSessionCookie(name) {
  const clean = (name || '').trim()
  if (!clean) return false
  if (NOT_SESSION.has(clean)) return false
  if (SESSION_EXACT.has(clean)) return true
  return SESSION_PREFIXES.some((prefix) => clean.startsWith(prefix))
}

/** `token_v2` first, then whatever else the session came with. */
export function sessionCookieHeader(entries) {
  const usable = entries.filter((entry) => entry && entry.name && entry.value && isSessionCookie(entry.name))
  const ordered = [
    ...usable.filter((entry) => SESSION_EXACT.has(entry.name)),
    ...usable.filter((entry) => !SESSION_EXACT.has(entry.name)),
  ]
  return ordered.map((entry) => `${entry.name}=${entry.value}`).join('; ')
}

export function hasToken(header) {
  return /(^|;\s*)token_v[23]=/.test(header || '')
}

/** Enough of a cookie jar for a login: what Notion sets, sent back as it came. */
export function createCookieJar(initial = {}) {
  const store = new Map(Object.entries(initial).filter(([, value]) => value != null))
  return {
    absorb(response) {
      const raw = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean)
      for (const line of raw) {
        const pair = line.split(';')[0]
        const cut = pair.indexOf('=')
        if (cut <= 0) continue
        store.set(pair.slice(0, cut).trim(), pair.slice(cut + 1).trim())
      }
      return this
    },
    get(name) {
      return store.get(name) ?? ''
    },
    entries() {
      return [...store].map(([name, value]) => ({ name, value }))
    },
    sessionHeader() {
      return sessionCookieHeader(this.entries())
    },
    header() {
      return [...store].map(([name, value]) => `${name}=${value}`).join('; ')
    },
    names() {
      return [...store.keys()]
    },
  }
}
