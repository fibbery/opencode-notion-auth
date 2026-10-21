import { mock } from 'bun:test'

mock.module('impit', () => ({ Impit: class { constructor() { throw new Error('local native dependency failure') } } }))
globalThis.fetch = () => { throw new Error('unexpected native fallback') }
const { NotionPlugin } = await import('../../index.mjs')
const plugin = await NotionPlugin({})
const provider = await plugin.auth.loader(async () => ({ key: 'local-fixture-only', metadata: { userId: 'local-user', spaceId: 'local-space', clientVersion: 'local-version' } }))
const response = await provider.fetch('', { body: JSON.stringify({ messages: [], stream: false }) })
console.log(JSON.stringify({ status: response.status, body: await response.json() }))
