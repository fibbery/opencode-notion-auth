const unwrap = raw => raw?.value?.value ?? raw?.value ?? raw
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null

/** Read this request's inference steps, not the thread's cumulative token totals. */
export function createTurnMetadata(threadId, excludedIds = []) {
  const excluded = new Set(excludedIds)
  const steps = new Map()
  const tools = new Set()
  const messageIds = new Set(excludedIds)
  let summary
  return {
    feed(line) {
      if (line?.type === 'agent-inference' && line.id && !excluded.has(line.id)) steps.set(line.id, line)
      if (line?.type !== 'record-map') return
      const map = line.recordMap ?? {}
      const thread = unwrap(map.thread?.[threadId])
      if (!thread) return
      if (thread.data?.usage_summary) summary = thread.data.usage_summary
      for (const id of thread.messages ?? []) {
        messageIds.add(id)
        if (excluded.has(id)) continue
        const step = unwrap(map.thread_message?.[id])?.step
        if (step?.type === 'agent-inference') steps.set(id, step)
        if (step?.type === 'agent-tool-result' && !step.autoLoadPhase && step.state === 'applied' && typeof step.input?.function === 'string') tools.add(step.input.function)
      }
    },
    result(previousSummary) {
      const completed = [...steps.values()].filter(s => s.finishedAt != null)
      const metered = completed.filter(s => number(s.inputTokens) !== null && number(s.outputTokens) !== null)
      const known = completed.length > 0 && metered.length === completed.length
      const sum = key => metered.reduce((n, s) => n + (number(s[key]) ?? 0), 0)
      const raw = known ? { input_tokens: sum('inputTokens'), output_tokens: sum('outputTokens'), cached_input_tokens_read: sum('cachedTokensRead'), cached_input_tokens_created: sum('cachedTokensCreated') } : null
      // Notion's inputTokens includes cache reads but excludes newly written cache
      // tokens. OpenAI prompt_tokens includes both; retain the raw counters too.
      const prompt = raw ? raw.input_tokens + raw.cached_input_tokens_created : null
      const usage = raw ? {
        prompt_tokens: prompt, completion_tokens: raw.output_tokens, total_tokens: prompt + raw.output_tokens,
        prompt_tokens_details: { cached_tokens: raw.cached_input_tokens_read, cache_write_tokens: raw.cached_input_tokens_created },
      } : undefined
      let credits
      const currentCredits = summary?.credits_by_type_unit
      const priorCredits = previousSummary?.credits_by_type_unit
      if (currentCredits && Object.values(currentCredits).every(v => number(v) !== null)) {
        const delta = Object.fromEntries(Object.entries(currentCredits).map(([key, value]) => [key, value - (number(priorCredits?.[key]) ?? 0)]))
        if (Object.values(delta).every(v => v >= 0)) credits = delta
      }
      return {
        usage, rawUsage: raw, usageStatus: known ? 'reported' : 'unknown',
        actualModels: [...new Set(completed.map(s => s.model).filter(m => typeof m === 'string'))],
        inferenceCount: completed.length, serverTools: [...tools], credits, messageIds: [...messageIds], summary,
      }
    },
  }
}
