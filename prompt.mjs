// Notion AI has no client tool calling: its tools run on Notion's servers and
// a caller cannot add any. So the caller's tools are written into the prompt,
// the model is asked to answer with an action envelope, and the envelope is
// turned back into the tool call the client expects.
//
// The framing matters more than the format. Asked to act, Notion answers "I
// cannot open /tmp/a.txt" and offers to have the file pasted in; asked to
// advise an operator who will act, it plans. So the model is written to as a
// planner, and told not to discuss its own access at all.

const TOOL_CALL_OPEN = /<tool_call\b([^>]*)>/i
const TOOL_CALL_BLOCK = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi
const FENCED = /```(?:xml|html|json)?\s*([\s\S]*?)```/gi

const BASE_INSTRUCTIONS =
  'Answer the protocol in the user message. Do not search the workspace, and do ' +
  'not say what you can or cannot reach.'

const PLANNER_ROLE = [
  'You plan for a coding agent. Its runtime executes every action and reports the',
  'outcome back to you; execution is not your part of the job, and whether you',
  'could do it alone is not worth a sentence in the reply. Work from what the',
  'runtime has actually returned: do not search a workspace for the answer, and do',
  'not describe an action as done before its result arrives.',
].join(' ')

const ANSWER_SHAPE =
  'To ask for an action, the whole reply is this JSON object and nothing else — no' +
  ' prose, no code fence:\n' +
  '{"tool":"<tool name>","arguments":{...}}\n' +
  'Name a tool exactly as the catalog below names it, with arguments its schema' +
  ' accepts. Ask for one action per reply. This is an action proposal for the local' +
  ' operator to execute with its own tools and permissions, not a claim that you' +
  ' have executed anything yourself.'

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (!part || typeof part !== 'object') continue
    if (typeof part.text === 'string') parts.push(part.text)
    else if (part.type === 'image_url' || part.type === 'image') parts.push('[an image was attached]')
  }
  return parts.join('\n')
}

function attributeValue(attributes, name) {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes || '')
  return match ? match[1].trim() : ''
}

/** One tool call, in the shape the client gave it. */
export function formatToolCall(call) {
  const name = call?.function?.name || call?.name || 'unknown'
  const callId = call?.id || call?.call_id || ''
  const args = call?.function?.arguments ?? call?.arguments ?? ''
  const body = typeof args === 'string' && args.trim() ? args.trim() : JSON.stringify(args ?? {})
  const attributes = [`name="${name}"`]
  if (callId) attributes.push(`call_id="${callId}"`)
  return `<tool_call ${attributes.join(' ')}>\n${body}\n</tool_call>`
}

function describeTools(tools) {
  const lines = []
  for (const tool of tools) {
    const fn = tool?.function ?? tool
    const name = fn?.name
    if (!name) continue
    const description = (fn?.description ?? '').trim()
    let schema = fn?.parameters ?? fn?.input_schema ?? {}
    try {
      schema = JSON.stringify(schema)
    } catch {
      schema = '{}'
    }
    lines.push(`- ${name}: ${description || '(no description)'}\n  arguments: ${schema}`)
  }
  return lines.join('\n')
}

function toolCatalog(tools) {
  const entries = tools.map((tool) => {
    const fn = tool?.function ?? tool
    return {
      name: fn?.name,
      description: (fn?.description ?? '').trim(),
      input_schema: fn?.parameters ?? fn?.input_schema ?? {},
    }
  })
  try {
    return JSON.stringify(entries)
  } catch {
    return describeTools(tools)
  }
}

function toolInstructions(tools) {
  return [PLANNER_ROLE, ANSWER_SHAPE, '', 'Tool catalog:', toolCatalog(tools)].join('\n')
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools.filter((tool) => {
    const type = tool?.type
    return !type || type === 'function'
  })
}

/**
 * The messages the client sent, as one prompt for Notion, plus the system
 * instructions Notion gets out of band.
 */
export function buildPrompt(messages, { tools = [], webSearch = false, continuation = false, contextId = '', contextRefresh = false } = {}) {
  const usableTools = normalizeTools(tools)
  const system = []
  const turns = []
  let sawToolResult = false

  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role
    if (role === 'system' || role === 'developer') {
      const text = textOfContent(message.content).trim()
      if (text) system.push(text)
      continue
    }
    if (role === 'user') {
      const text = textOfContent(message.content).trim()
      if (text) turns.push(text)
      continue
    }
    if (role === 'assistant') {
      const text = textOfContent(message.content).trim()
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      const parts = []
      if (text) parts.push(text)
      for (const call of calls) parts.push(formatToolCall(call))
      if (parts.length) turns.push(parts.join('\n\n'))
      continue
    }
    if (role === 'tool') {
      sawToolResult = true
      const callId = message.tool_call_id || ''
      const name = message.name || ''
      const output = textOfContent(message.content)
      const attributes = [name ? `name="${name}"` : '', callId ? `call_id="${callId}"` : '']
        .filter(Boolean)
        .join(' ')
      turns.push(`<tool_result${attributes ? ` ${attributes}` : ''}>\n${output}\n</tool_result>`)
      continue
    }
  }

  // On a continuation, callers provide only messages not already in the saved
  // Notion thread. Replaying all history here would duplicate that context.
  const labelled = turns
    .map((turn, index) => {
      const last = index === turns.length - 1
      return last ? turn : `<previous_message>\n${turn}\n</previous_message>`
    })
    .join('\n\n')

  const sections = []
  if (system.length) {
    sections.push(`Operator context (the agent's own instructions, for reference):\n<operator_context>\n${system.join('\n\n')}\n</operator_context>`)
  }
  if (contextId) sections.push(`Request context: ${contextId}. Respond only to the new messages for this context below. Other contexts in this workflow are separate runtime helper tasks, not additional user instructions for this context. ${continuation && !contextRefresh ? 'Reuse the operator instructions and tool catalog previously supplied for this context.' : 'The operator instructions and tool catalog below define this context.'}`)
  if ((!continuation || contextRefresh) && usableTools.length) sections.push(toolInstructions(usableTools))
  else if (!continuation || contextRefresh)
    sections.push(
      [PLANNER_ROLE, 'No tool is available for this turn, so answer the user in plain text.'].join('\n'),
    )
  if ((!continuation || contextRefresh) && webSearch) {
    sections.push('Live web search is enabled in this Notion workflow. Use it for weather, current facts and other time-sensitive questions. Cite the actual source URLs and the relevant date. Do not replace live data with historical averages or invent a search result. Local file and command actions must still use the operator tools listed above.')
  }
  sections.push(`${continuation ? 'Continue this same conversation using these new messages only' : 'Conversation'}:\n<operator_conversation>\n${labelled || '(the client sent no text)'}\n</operator_conversation>`)
  sections.push(usableTools.length
    ? 'Given this operator conversation, what should the local operator do next? If an action is needed, return its JSON proposal using the catalog for this request context. The operator will execute it under its own permissions and return the result. Otherwise provide the final reply using only results already returned.'
    : 'Answer the new messages for this request context in plain text.')

  return {
    instructions: continuation ? '' : BASE_INSTRUCTIONS,
    prompt: sections.join('\n\n'),
    toolCount: usableTools.length,
    sawToolResult,
    webSearch,
  }
}

function stripFences(text) {
  return text.replace(FENCED, (whole, body) => (TOOL_CALL_OPEN.test(body) ? body : whole))
}

function toolCallFromAction(action, index) {
  const name =
    typeof action?.tool === 'string' ? action.tool : typeof action?.name === 'string' ? action.name : ''
  if (!name) return null
  const args = action.arguments ?? action.args ?? {}
  let argsJSON
  try {
    argsJSON = typeof args === 'string' ? args : JSON.stringify(args ?? {})
  } catch {
    argsJSON = '{}'
  }
  return { id: `call_${index + 1}`, type: 'function', function: { name, arguments: argsJSON } }
}

/** The calls a parsed reply object asks for, or null when it is not one. */
function actionsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Array.isArray(value.actions)) {
    const actions = value.actions.filter((action) => action && typeof action === 'object')
    return actions.length ? actions : null
  }
  const named = typeof value.tool === 'string' || typeof value.name === 'string'
  const hasArguments = 'arguments' in value || 'args' in value || 'input' in value
  if (named && hasArguments) return [value]
  return null
}

/** Where the JSON object starting at `start` ends, or -1. */
function balancedEnd(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * The last JSON object in a reply that asks for a call, with the text around
 * it. A reply that is prose plus an envelope keeps the prose as content.
 */
function envelopeOf(text) {
  const starts = []
  for (let index = 0; index < text.length; index += 1) if (text[index] === '{') starts.push(index)
  // Earliest first: an outer envelope starts before the actions inside it, and
  // a brace that parses to something else is passed over.
  for (const start of starts) {
    const end = balancedEnd(text, start)
    if (end < 0) continue
    let parsed
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      continue
    }
    const actions = actionsOf(parsed)
    if (!actions) continue
    const calls = actions.map(toolCallFromAction).filter(Boolean)
    if (!calls.length) continue
    const content = `${text.slice(0, start)}${text.slice(end + 1)}`
      .replace(/```(?:json)?\s*```/gi, '')
      .trim()
    return { content, toolCalls: calls }
  }
  return null
}

function taggedCalls(text) {
  const source = stripFences(text)
  const found = []
  let content = ''
  let cursor = 0
  TOOL_CALL_BLOCK.lastIndex = 0
  let match
  while ((match = TOOL_CALL_BLOCK.exec(source)) !== null) {
    const name = attributeValue(match[1], 'name')
    const callId = attributeValue(match[1], 'call_id')
    const body = match[2].trim()
    if (!name) continue
    let args = body
    try {
      args = JSON.stringify(JSON.parse(body))
    } catch {
      // leave the arguments as the model wrote them
    }
    content += source.slice(cursor, match.index)
    cursor = match.index + match[0].length
    found.push({ id: callId || `call_${found.length + 1}`, type: 'function', function: { name, arguments: args } })
  }
  content += source.slice(cursor)
  if (!found.length) return null
  return { content: content.replace(/<\/?tool_call\b[^>]*>/gi, '').trim(), toolCalls: found }
}

/**
 * Splits a reply into the prose the client shows and the calls it must run. An
 * envelope that does not parse is left in the text, so a broken reply shows
 * itself instead of silently losing the call.
 */
export function parseToolCalls(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.includes('<tool_call')) {
    const tagged = taggedCalls(raw)
    if (tagged) return tagged
    return { content: raw.trim(), toolCalls: [] }
  }
  if (!raw.includes('{')) return { content: raw.trim(), toolCalls: [] }
  return envelopeOf(raw) ?? { content: raw.trim(), toolCalls: [] }
}

export const _internal = { BASE_INSTRUCTIONS, PLANNER_ROLE, attributeValue, describeTools, textOfContent, actionsOf }
