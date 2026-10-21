/** Browser TLS transport for inference only. Never fall back to native fetch. */
export function createNotionFetch(loadImpit = () => import('impit')) {
  let loading
  return async function notionFetch(url, init = {}) {
    let client
    try {
      loading ??= Promise.resolve().then(loadImpit).then(({ Impit }) => new Impit({
        browser: 'chrome',
        followRedirects: false,
        timeout: 180_000,
      }))
      client = await loading
    } catch (cause) {
      loading = undefined
      throw Object.assign(new Error('Notion browser transport could not load', { cause }), {
        name: 'NotionTransportError', status: 503,
      })
    }
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('Request aborted')
    const { redirect, ...options } = init
    return client.fetch(String(url), options)
  }
}

export const notionFetch = createNotionFetch()
