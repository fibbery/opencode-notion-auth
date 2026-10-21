function rejectStep(step) {
  if (step?.type !== 'error') return
  const subType = typeof step.subType === 'string' ? step.subType : 'unknown'
  const traceId = typeof step.traceId === 'string' ? step.traceId : ''
  const detail = typeof step.message === 'string' ? step.message : 'Inference failed'
  throw Object.assign(new Error(`Notion ${subType}: ${detail}${traceId ? ` (traceId: ${traceId})` : ''}`), {
    name: 'NotionUpstreamError', status: 502, subType, traceId, isRetryable: step.isRetryable,
  })
}

/** Inspect protocol step positions only; arbitrary response content is not an error. */
export function assertNoUpstreamError(line, { threadId, excludedIds } = {}) {
  if (!line || typeof line !== 'object') return
  rejectStep(line)
  if (line.type === 'patch-start') {
    for (const step of Array.isArray(line.data?.s) ? line.data.s : []) if (!excludedIds?.has(step.id)) rejectStep(step)
  }
  if (line.type === 'patch') {
    for (const op of Array.isArray(line.v) ? line.v : []) {
      if (/^\/s(?:\/(?:\d+|-))?$/.test(op?.p ?? '')) {
        for (const step of Array.isArray(op.v) ? op.v : [op.v]) rejectStep(step)
      }
      if (/^\/s\/\d+\/type$/.test(op?.p ?? '') && op.v === 'error') {
        rejectStep({ type: 'error', message: 'Inference entered an error step' })
      }
    }
  }
  if (line.type === 'record-map') {
    const threads = line.recordMap?.thread ?? {}
    const rawThread = threadId ? threads[threadId] : Object.values(threads)[0]
    const thread = rawThread?.value?.value ?? rawThread?.value ?? rawThread
    for (const id of Array.isArray(thread?.messages) ? thread.messages : []) {
      if (excludedIds?.has(id)) continue
      const raw = line.recordMap?.thread_message?.[id]
      rejectStep((raw?.value?.value ?? raw?.value ?? raw)?.step)
    }
  }
}
