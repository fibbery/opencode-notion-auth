import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, appendFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex')
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
  return JSON.stringify(value) ?? 'null'
}
function contentText(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map(p => typeof p === 'string' ? p : p?.text ?? '').join('\n') : ''
}
function stableText(message) {
  const text = contentText(message.content).trim()
  if (!['system', 'developer'].includes(message.role)) return text
  // Claude Code changes these telemetry/budget values on ordinary tool turns.
  return text.replace(/^x-anthropic-billing-header:.*(?:\r?\n|$)/gm, '')
    .replace(/(<total_tokens>)[\s\S]*?(<\/total_tokens>)/g, '$1[dynamic]$2').trim()
}
export function messageHash(message) {
  return hash({ role: message.role, content: stableText(message),
    ...(message.role === 'tool' ? { call: message.tool_call_id ?? '' } : {}),
    ...(message.tool_calls?.length ? { calls: message.tool_calls.map(c => {
      let args = c.function?.arguments ?? ''
      try { args = JSON.parse(args) } catch {}
      return { name: c.function?.name ?? '', args }
    }) } : {}),
  })
}
function splitMessages(messages = []) {
  let index = 0
  while (['system', 'developer'].includes(messages[index]?.role)) index++
  return { system: messages.slice(0, index), turns: messages.slice(index) }
}
function toolsIdentity(tools = []) {
  return tools.map(tool => ({type: tool.type ?? 'function', function: tool.function ?? tool}))
    .map(tool => ({...tool, function: {name: tool.function.name, description: tool.function.description ?? '', parameters: tool.function.parameters ?? tool.function.input_schema ?? {}}}))
}
function requestContext(body) {
  const {system} = splitMessages(body.messages)
  return hash({system: system.map(messageHash), tools: toolsIdentity(body.tools)})
}
export function requestFingerprint(body, webSearch) {
  return hash({ model: body.model, effort: body.reasoning_effort ?? body.reasoning?.effort ?? '', webSearch,
    context: requestContext(body),
  })
}
const rootPath = () => process.env.NOTION_SESSION_DIR || join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'magpie', 'notion-sessions')
const queues = new Map()
async function acquire(key, signal) {
  const previous = queues.get(key) ?? Promise.resolve()
  let unlock
  const current = new Promise(resolve => { unlock = resolve })
  queues.set(key, current)
  const release = () => { unlock(); if (queues.get(key) === current) queues.delete(key) }
  let abort
  try {
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason ?? new Error('Request cancelled while waiting for its Notion conversation'))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
    await Promise.race([previous, cancelled])
    return release
  } catch (error) {
    previous.then(release)
    throw error
  } finally { if (abort) signal?.removeEventListener('abort', abort) }
}

/** Persist only IDs, hashes and counters. Document text and credentials stay out. */
export async function beginSession({ sessionId, account, body, webSearch, signal }) {
  const identity = hash([account.userId, account.spaceId, hash(account.cookie)])
  const sessionKey = sessionId ? hash([identity, sessionId]) : ''
  const release = sessionKey ? await acquire(sessionKey, signal) : () => {}
  const root = rootPath()
  const path = sessionKey ? join(root, sessionKey + '.json') : ''
  let finished = false
  let saved
  let reason = sessionKey ? 'new_session' : 'no_session_id'
  const {system, turns} = splitMessages(body.messages)
  const hashes = turns.map(messageHash)
  const fingerprint = requestFingerprint(body, webSearch)
  const contextId = requestContext(body)
  try {
    if (path) {
      await mkdir(root, { recursive: true })
      try { saved = JSON.parse(await readFile(path, 'utf8')) } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e }
      if (saved && (typeof saved.threadId !== 'string' || !Array.isArray(saved.messageIds) || saved.pending)) saved = undefined
    }
    // Helpers, suggestions and real turns share a Claude session but branch from
    // different histories. Keep their accepted prefixes without replacing the
    // main conversation, and keep ONE server thread across all these branches.
    const anchors = saved?.version === 2 && Array.isArray(saved.anchors) ? saved.anchors : []
    const anchor = anchors.filter(a => Array.isArray(a.hashes) && a.hashes.length < hashes.length && a.hashes.every((h,i) => hashes[i] === h))
      .sort((a,b) => b.hashes.length-a.hashes.length)[0]
    const knownContext = saved?.contexts?.includes(contextId) ?? false
    const delta = saved ? [...(!knownContext ? system : []), ...turns.slice(anchor?.hashes.length ?? 0)] : body.messages
    const plan = { threadId: saved?.threadId, configId: saved?.configId ?? saved?.messageIds?.[0], resume: Boolean(saved), excludedIds: saved?.messageIds ?? [], previousSummary: saved?.summary, delta,
      contextId, contextRefresh: !knownContext, updateConfig: Boolean(saved && saved.fingerprint !== fingerprint),
      reason: saved ? anchor ? knownContext ? 'continued' : 'request_context_updated' : 'context_resynchronized' : reason }
    // A crash after submission must not silently replay the same turn on restart.
    if (path) await writeFile(path, JSON.stringify({ version: 1, pending: true, updatedAt: Date.now() }), { mode: 0o600 })
    return {
      ...plan,
      async finish({ result, threadId, configId, message, sentCharacters, fullCharacters, requestedModel }) {
        if (finished) return
        try {
          await mkdir(root, { recursive: true })
          const nextAnchor = {hashes: [...hashes, messageHash(message)], contextId}
          const data = { version: 2, pending: false, updatedAt: Date.now(), fingerprint, threadId, configId: configId ?? plan.configId,
            anchors: [...anchors, nextAnchor].slice(-64), contexts: [...new Set([...(saved?.contexts ?? []), contextId])].slice(-64),
            messageIds: result.messageIds, summary: result.summary }
          if (path) {
            const temp = path + '.next'
            await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, path)
          }
          await appendFile(join(root, 'diagnostics.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), session: sessionKey || null, threadId, mode: plan.resume ? 'resume' : 'create', reason: plan.reason, requestedModel,
            contextId, configurationUpdated: plan.updateConfig, sentCharacters, avoidedCharacters: Math.max(0, fullCharacters - sentCharacters), ...publicMetadata(result),
          }) + '\n', { mode: 0o600 })
        } finally { finished = true; release() }
      },
      async fail(error) {
        if (finished) return
        finished = true
        try {
          if (path) await unlink(path).catch(() => {})
          await mkdir(root, { recursive: true })
          await appendFile(join(root, 'diagnostics.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), session: sessionKey || null, threadId: plan.threadId ?? null, status: 'failed', error: error?.subType || error?.name || 'error' }) + '\n', { mode: 0o600 })
        } catch { /* Keep the original inference/cancellation error if logging fails. */ }
        finally { release() }
      },
    }
  } catch (error) { release(); throw error }
}

export function publicMetadata(result) {
  return { usageStatus: result.usageStatus, rawUsage: result.rawUsage, actualModels: result.actualModels, inferenceCount: result.inferenceCount, serverTools: result.serverTools ?? [], credits: result.credits ?? null }
}

export { hash }
