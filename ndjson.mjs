// Notion's runInferenceTranscript answers with NDJSON "patch" events. This
// module rebuilds the reply's text from them.
//
// Line shapes seen upstream:
//   {"type":"patch-start","data":{"s":[...steps...]},"version":1}
//   {"type":"patch","v":[{"o":"a","p":"/s/-","v":{...step...}}, ...]}
//   {"type":"agent-inference","id":"<step id>","finishedAt":…,"value":[{"type":"text","content":"…"}]}
//   {"type":"record-map","recordMap":{…}}
//
// An operation's `o` is add ("a"), extend ("x"), replace ("p") or remove ("r"),
// and its `p` a JSON pointer: "/s/-" appends a step, "/s/<i>/value/<j>/content"
// touches one value of one step, "/s/<i>/finishedAt" ends it.

const STEP_PREFIX = /^\/s\/(\d+)(\/[\s\S]*)?$/

/** A stream of bytes → complete lines, without holding a partial one. */
export function createLineReader() {
  let buffered = ''
  return {
    push(chunk) {
      buffered += chunk
      const out = []
      let index
      while ((index = buffered.indexOf('\n')) >= 0) {
        out.push(buffered.slice(0, index))
        buffered = buffered.slice(index + 1)
      }
      return out
    },
    flush() {
      const rest = buffered.trim()
      buffered = ''
      return rest ? [rest] : []
    },
  }
}

function normalizeType(value) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : ''
  switch (type) {
    case 'text':
      return 'text'
    case 'thinking':
    case 'reasoning':
      return 'reasoning'
    default:
      return ''
  }
}

function partContent(part) {
  if (!part || typeof part !== 'object') return ''
  if (typeof part.content === 'string') return part.content
  if (typeof part.text === 'string') return part.text
  return ''
}

// The model sends whole-so-far content on some events and deltas on others, so
// what arrives is merged rather than concatenated.
export function mergeCumulative(existing, next) {
  if (!next) return existing || ''
  if (!existing || next === existing) return next
  if (next.startsWith(existing)) return next
  if (existing.startsWith(next)) return existing
  return existing + next
}

export function appendDelta(existing, delta) {
  if (!delta) return existing || ''
  if (!existing) return delta
  if (existing.endsWith(delta)) return existing
  if (delta.startsWith(existing)) return delta
  return existing + delta
}

export function replaceContent(existing, next) {
  if (!next) return existing || ''
  if (!existing || next === existing) return next
  if (next.startsWith(existing)) return next
  return existing + next
}

function newStep(id, type) {
  return { id: id || '', type: type || 'agent-inference', values: [], finishedAt: null, completed: false }
}

export function createTranscript() {
  return { steps: [], byId: new Map(), lastTextIndex: -1, lineCount: 0, recordText: '', recordReasoning: '' }
}

// A stream opens by naming the steps that already exist. Every later pointer is
// an index into that list, so dropping this line would put each patch one step
// away from where it belongs.
function applyPatchStart(state, line) {
  const steps = Array.isArray(line?.data?.s) ? line.data.s : []
  for (const item of steps) {
    const step = registerStepFromItem(item)
    state.steps.push(step)
    rememberStep(state, state.steps.length - 1)
  }
  return steps.length > 0
}

function messageIDsOf(recordMap, threadId) {
  const threads = recordMap?.thread ?? {}
  const order = threadId && threads[threadId] ? [threadId, ...Object.keys(threads).filter((id) => id !== threadId)] : Object.keys(threads)
  for (const id of order) {
    const value = recordMap?.thread?.[id]?.value?.value
    if (Array.isArray(value?.messages)) return value.messages
  }
  return []
}

/**
 * The thread's own record of the turn, which answers with the finished text
 * even when the patches did not add up to one.
 */
export function readRecordMap(recordMap, threadId) {
  const messages = recordMap?.thread_message ?? {}
  let text = ''
  let reasoning = ''
  for (const id of messageIDsOf(recordMap, threadId)) {
    const step = messages?.[id]?.value?.value?.step
    if (!step || step.type !== 'agent-inference') continue
    const parts = Array.isArray(step.value) ? step.value : []
    let stepText = ''
    let stepReasoning = ''
    for (const part of parts) {
      const type = normalizeType(part?.type)
      const content = partContent(part)
      if (!content) continue
      if (type === 'text') stepText = mergeCumulative(stepText, content)
      else if (type === 'reasoning') stepReasoning = mergeCumulative(stepReasoning, content)
    }
    if (stepText.trim()) text = stepText
    if (stepReasoning.trim()) reasoning = stepReasoning
  }
  return { text, reasoning }
}

function stepIndexFor(state, rawIndex) {
  const index = Number.parseInt(rawIndex, 10)
  return Number.isInteger(index) && index >= 0 && index < state.steps.length ? index : -1
}

function setValueType(step, valueIndex, rawType) {
  const type = normalizeType(rawType)
  if (!type) return false
  const existing = step.values[valueIndex] ?? { type: '', content: '' }
  if (existing.type === type) return false
  step.values[valueIndex] = { ...existing, type }
  return true
}

function setValueContent(step, valueIndex, operation, rawValue) {
  const text = typeof rawValue === 'string' ? rawValue : partContent(rawValue)
  if (!text) return false
  const existing = step.values[valueIndex] ?? { type: '', content: '' }
  let content
  switch (operation) {
    case 'x':
      content = appendDelta(existing.content, text)
      break
    case 'p':
      content = replaceContent(existing.content, text)
      break
    default:
      content = mergeCumulative(existing.content, text)
  }
  if (content === existing.content) return false
  step.values[valueIndex] = { ...existing, content }
  return true
}

function appendValue(state, step, rawValue) {
  const part = rawValue && typeof rawValue === 'object' ? rawValue : null
  if (!part) return false
  const type = normalizeType(part.type)
  const content = partContent(part)
  if (!type && !content) return false
  step.values.push({ type, content })
  return true
}

function registerStepFromItem(item) {
  const step = newStep(item?.id, item?.type)
  const values = Array.isArray(item?.value) ? item.value : []
  for (const part of values) {
    step.values.push({ type: normalizeType(part?.type), content: partContent(part) })
  }
  if (item?.finishedAt != null) {
    step.completed = true
    step.finishedAt = item.finishedAt
  }
  return step
}

function findStepByItemId(state, id) {
  if (!id) return -1
  const found = state.byId.get(id)
  return found == null ? -1 : found
}

function rememberStep(state, index) {
  const step = state.steps[index]
  if (step?.id) state.byId.set(step.id, index)
}

function applyPatchOperation(state, op) {
  if (!op || typeof op !== 'object') return false
  const path = typeof op.p === 'string' ? op.p : ''
  const operation = typeof op.o === 'string' ? op.o : ''
  if (path === '/s/-' || path === '/s') {
    const step = registerStepFromItem(op.v)
    state.steps.push(step)
    rememberStep(state, state.steps.length - 1)
    return true
  }
  const match = STEP_PREFIX.exec(path)
  if (!match) return false
  const index = stepIndexFor(state, match[1])
  if (index < 0) return false
  const rest = match[2] || ''
  const step = state.steps[index]

  if (operation === 'r') {
    const removal = /^\/value\/(\d+)$/.exec(rest)
    if (removal) {
      const valueIndex = Number.parseInt(removal[1], 10)
      if (valueIndex >= 0 && valueIndex < step.values.length) {
        step.values.splice(valueIndex, 1)
        return true
      }
    }
    return false
  }

  if (operation === 'a' && rest.startsWith('/value/-')) return appendValue(state, step, op.v)

  const content = /^\/value\/(\d+)\/content$/.exec(rest)
  if (content) return setValueContent(step, Number.parseInt(content[1], 10), operation, op.v)

  const type = /^\/value\/(\d+)\/type$/.exec(rest)
  if (type) return setValueType(step, Number.parseInt(type[1], 10), op.v)

  if (rest === '/finishedAt' && op.v != null) {
    step.completed = true
    step.finishedAt = op.v
    return true
  }
  if (rest === '/type' && typeof op.v === 'string') {
    step.type = op.v
    return true
  }
  return false
}

function applyAgentInference(state, line) {
  let index = findStepByItemId(state, line.id)
  if (index < 0) {
    state.steps.push(newStep(line.id, 'agent-inference'))
    index = state.steps.length - 1
    rememberStep(state, index)
  }
  const step = state.steps[index]
  if (!step.id && line.id) {
    step.id = line.id
    rememberStep(state, index)
  }
  const values = Array.isArray(line.value) ? line.value : []
  values.forEach((part, valueIndex) => {
    const type = normalizeType(part?.type)
    const text = partContent(part)
    if (!type) return
    const existing = step.values[valueIndex] ?? { type: '', content: '' }
    step.values[valueIndex] = {
      type,
      content: text ? mergeCumulative(existing.content, text) : existing.content,
    }
  })
  if (line.finishedAt != null) {
    step.completed = true
    step.finishedAt = line.finishedAt
  }
  return true
}

/** Applies one parsed NDJSON object; true when the reply's text may have moved. */
export function applyTranscriptLine(state, line) {
  if (!line || typeof line !== 'object') return false
  state.lineCount += 1
  switch (line.type) {
    case 'patch-start':
      return applyPatchStart(state, line)
    case 'patch': {
      let changed = false
      for (const op of Array.isArray(line.v) ? line.v : []) {
        if (applyPatchOperation(state, op)) changed = true
      }
      return changed
    }
    case 'agent-inference':
      return applyAgentInference(state, line)
    case 'record-map': {
      const found = readRecordMap(line.recordMap, state.threadId)
      const changed = Boolean(found.text && found.text !== state.recordText)
      state.recordText = found.text
      state.recordReasoning = found.reasoning
      return changed
    }
    default:
      return false
  }
}

function stepText(step, kind) {
  if (!step) return ''
  let out = ''
  for (const value of step.values) {
    if (value.type !== kind || !value.content) continue
    out = mergeCumulative(out, value.content)
  }
  return out
}

/** The text of the newest agent step that has one (what the user is reading). */
export function transcriptText(state) {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index]
    if (step.type !== 'agent-inference') continue
    const text = stepText(step, 'text')
    if (text.trim()) return text
  }
  // Nothing in the patches: the thread record is the last word on the turn.
  return state.recordText || ''
}

export function transcriptReasoning(state) {
  const fromRecord = () => state.recordReasoning || ''
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index]
    if (step.type !== 'agent-inference') continue
    const text = stepText(step, 'reasoning')
    if (text.trim()) return text
  }
  return fromRecord()
}

export function transcriptFinished(state) {
  for (let index = state.steps.length - 1; index >= 0; index -= 1) {
    const step = state.steps[index]
    if (step.type === 'agent-inference' && step.completed) return true
  }
  return false
}
