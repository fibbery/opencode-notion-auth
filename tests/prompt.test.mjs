import { describe, expect, test } from 'bun:test'
import { buildPrompt, formatToolCall, parseToolCalls } from '../prompt.mjs'

const readTool = {
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  },
}

describe('buildPrompt', () => {
  const readTurn = [{ role: 'user', content: 'Read a.txt' }]

  test('writes to the model as a planner, not as the agent', () => {
    const built = buildPrompt([{ role: 'system', content: 'You are a coding agent.' }, ...readTurn])
    // the client's own prompt is context for the planner, not the last word
    expect(built.prompt).toContain("Operator context (the agent's own instructions, for reference):")
    expect(built.prompt).toContain('You are a coding agent.')
    expect(built.prompt).toContain('You plan for a coding agent')
    expect(built.prompt.toLowerCase()).toContain('its runtime executes every action')
    expect(built.instructions).not.toContain('You are a coding agent.')
  })

  test('puts the tool catalog and the answer shape in the prompt', () => {
    const built = buildPrompt(readTurn, { tools: [readTool] })
    expect(built.toolCount).toBe(1)
    expect(built.prompt).toContain('{"tool":"<tool name>","arguments":{...}}')
    expect(built.prompt).toContain('"name":"Read"')
    expect(built.prompt).toContain('Read a file')
    expect(built.prompt).toContain('file_path')
  })

  test('says so when there is no tool at all', () => {
    const built = buildPrompt(readTurn)
    expect(built.toolCount).toBe(0)
    expect(built.prompt).toContain('No tool is available for this turn')
  })

  test('turns an assistant tool call and its result into tags', () => {
    const built = buildPrompt([
      ...readTurn,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"a.txt"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'Read', content: 'hello' },
    ])
    expect(built.prompt).toContain('<tool_call name="Read" call_id="c1">')
    expect(built.prompt).toContain('<tool_result name="Read" call_id="c1">')
    expect(built.prompt).toContain('hello')
    expect(built.sawToolResult).toBe(true)
  })

  test('labels what came before the current turn', () => {
    const built = buildPrompt([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
    expect(built.prompt).toContain('<previous_message>\nfirst\n</previous_message>')
    expect(built.prompt).toContain('Conversation:\n<operator_conversation>\n<previous_message>\nfirst\n</previous_message>\n\n<previous_message>\nsecond\n</previous_message>\n\nthird\n</operator_conversation>')
  })

  test('reads content parts, and says an image was attached', () => {
    const built = buildPrompt([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'x' } }] },
    ])
    expect(built.prompt).toContain('look\n[an image was attached]')
  })
})

describe('parseToolCalls', () => {
  test('reads a call and keeps the prose', () => {
    const { content, toolCalls } = parseToolCalls('Reading it now.\n<tool_call name="Read" call_id="c1">{"file_path":"a.txt"}</tool_call>\n')
    expect(content).toBe('Reading it now.')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].id).toBe('c1')
    expect(toolCalls[0].function.name).toBe('Read')
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ file_path: 'a.txt' })
  })

  test('reads several calls', () => {
    const { toolCalls } = parseToolCalls(
      '<tool_call name="Read" call_id="c1">{"file_path":"a"}</tool_call><tool_call name="Read" call_id="c2">{"file_path":"b"}</tool_call>',
    )
    expect(toolCalls.map((call) => call.id)).toEqual(['c1', 'c2'])
  })

  test('reads a call inside a code fence', () => {
    const { toolCalls } = parseToolCalls('```xml\n<tool_call name="Bash" call_id="c1">{"command":"ls"}</tool_call>\n```')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].function.name).toBe('Bash')
  })

  test('invents a call id when the model leaves it out', () => {
    const { toolCalls } = parseToolCalls('<tool_call name="Read">{"file_path":"a"}</tool_call>')
    expect(toolCalls[0].id).toBe('call_1')
  })

  test('leaves an unclosed tag in the text rather than losing it', () => {
    const text = 'Here goes.\n<tool_call name="Read" call_id="c1">{"file_path":"a"'
    expect(parseToolCalls(text)).toEqual({ content: text, toolCalls: [] })
  })

  test('is a no-op for a plain answer', () => {
    expect(parseToolCalls('Just text.')).toEqual({ content: 'Just text.', toolCalls: [] })
  })
})

describe('formatToolCall', () => {
  test('writes arguments as JSON when they came as an object', () => {
    expect(formatToolCall({ id: 'c1', function: { name: 'Read', arguments: { file_path: 'a' } } })).toBe(
      '<tool_call name="Read" call_id="c1">\n{"file_path":"a"}\n</tool_call>',
    )
  })
})

describe('the action envelope', () => {
  test('reads a single action as a tool call', () => {
    const { content, toolCalls } = parseToolCalls('{"tool":"Read","arguments":{"file_path":"/tmp/a.txt"}}')
    expect(content).toBe('')
    expect(toolCalls[0].function.name).toBe('Read')
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ file_path: '/tmp/a.txt' })
  })

  test('keeps the reasoning a model writes before the envelope', () => {
    const { content, toolCalls } = parseToolCalls('先看一下这个文件。\n\n{"tool":"Read","arguments":{"file_path":"a"}}')  // non-ASCII prose, on purpose
    expect(content).toBe('先看一下这个文件。')
    expect(toolCalls).toHaveLength(1)
  })

  test('reads an actions list', () => {
    const { toolCalls } = parseToolCalls('{"actions":[{"tool":"Read","arguments":{"file_path":"a"}},{"tool":"Bash","arguments":{"command":"ls"}}]}')
    expect(toolCalls.map((call) => call.function.name)).toEqual(['Read', 'Bash'])
    expect(toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2'])
  })

  test('reads an envelope inside a code fence', () => {
    const { toolCalls } = parseToolCalls('```json\n{"tool":"Read","arguments":{"file_path":"a"}}\n```')
    expect(toolCalls).toHaveLength(1)
  })

  test('takes a string of arguments as they came', () => {
    const { toolCalls } = parseToolCalls('{"tool":"Read","arguments":"{\\"file_path\\":\\"a\\"}"}')
    expect(toolCalls[0].function.arguments).toBe('{"file_path":"a"}')
  })

  test('leaves JSON that is not a call alone', () => {
    const text = 'The config is {"model":"opus","temperature":0.2}.'
    expect(parseToolCalls(text)).toEqual({ content: text, toolCalls: [] })
  })

  test('leaves a broken envelope in the text rather than losing it', () => {
    const text = '{"tool":"Read","arguments":{'
    expect(parseToolCalls(text)).toEqual({ content: text, toolCalls: [] })
  })
})
