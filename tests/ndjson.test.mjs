import { describe, expect, test } from 'bun:test'
import {
  applyTranscriptLine,
  readRecordMap,
  appendDelta,
  createLineReader,
  createTranscript,
  mergeCumulative,
  transcriptFinished,
  transcriptText,
} from '../ndjson.mjs'

function patch(...operations) {
  return { type: 'patch', v: operations }
}

describe('line reader', () => {
  test('splits chunks into whole lines and keeps the tail', () => {
    const reader = createLineReader()
    expect(reader.push('{"a":1}\n{"b":')).toEqual(['{"a":1}'])
    expect(reader.push('2}\n')).toEqual(['{"b":2}'])
    expect(reader.flush()).toEqual([])
  })

  test('flushes a last line without a newline', () => {
    const reader = createLineReader()
    reader.push('{"a":1}')
    expect(reader.flush()).toEqual(['{"a":1}'])
  })
})

describe('content merging', () => {
  test('takes whole-so-far content over the text it already has', () => {
    expect(mergeCumulative('Hel', 'Hello')).toBe('Hello')
    expect(mergeCumulative('Hello', 'Hel')).toBe('Hello')
    expect(mergeCumulative('Hello', ' world')).toBe('Hello world')
  })

  test('appends deltas without repeating one already applied', () => {
    expect(appendDelta('Hello', ' world')).toBe('Hello world')
    expect(appendDelta('Hello world', ' world')).toBe('Hello world')
    expect(appendDelta('', 'first')).toBe('first')
  })
})

describe('transcript', () => {
  test('reads a step Notion appends in one patch', () => {
    const state = createTranscript()
    applyTranscriptLine(
      state,
      patch({ o: 'a', p: '/s/-', v: { id: 'step-1', type: 'agent-inference', value: [{ type: 'text', content: 'Hello' }] } }),
    )
    expect(transcriptText(state)).toBe('Hello')
    expect(transcriptFinished(state)).toBe(false)
  })

  test('follows content patches and the end of the step', () => {
    const state = createTranscript()
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/-', v: { id: 'step-1', type: 'agent-inference', value: [] } }))
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/0/value/-', v: { type: 'text', content: 'Hel' } }))
    applyTranscriptLine(state, patch({ o: 'x', p: '/s/0/value/0/content', v: 'lo' }))
    expect(transcriptText(state)).toBe('Hello')
    applyTranscriptLine(state, patch({ o: 'p', p: '/s/0/value/0/content', v: 'Hello there' }))
    expect(transcriptText(state)).toBe('Hello there')
    applyTranscriptLine(state, patch({ o: 'p', p: '/s/0/finishedAt', v: '2026-10-18T00:00:00.000Z' }))
    expect(transcriptFinished(state)).toBe(true)
  })

  test('keeps thinking apart from the answer', () => {
    const state = createTranscript()
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/-', v: { id: 's1', type: 'agent-inference', value: [] } }))
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/0/value/-', v: { type: 'thinking', content: 'weighing it up' } }))
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/0/value/-', v: { type: 'text', content: 'The answer is 4.' } }))
    expect(transcriptText(state)).toBe('The answer is 4.')
  })

  test('takes an agent-inference event that names a step', () => {
    const state = createTranscript()
    applyTranscriptLine(state, { type: 'agent-inference', id: 'step-9', value: [{ type: 'text', content: 'first' }] })
    applyTranscriptLine(state, { type: 'agent-inference', id: 'step-9', value: [{ type: 'text', content: 'first and second' }] })
    applyTranscriptLine(state, { type: 'agent-inference', id: 'step-9', finishedAt: 'now', value: [] })
    expect(transcriptText(state)).toBe('first and second')
    expect(transcriptFinished(state)).toBe(true)
  })

  test('reads the newest step that has text', () => {
    const state = createTranscript()
    applyTranscriptLine(state, { type: 'agent-inference', id: 'c1', value: [{ type: 'text', content: 'draft' }] })
    applyTranscriptLine(state, { type: 'agent-inference', id: 'c2', value: [{ type: 'text', content: 'final' }] })
    expect(transcriptText(state)).toBe('final')
  })

  test('ignores lines it does not know', () => {
    const state = createTranscript()
    expect(applyTranscriptLine(state, { type: 'record-map', recordMap: {} })).toBe(false)
    expect(applyTranscriptLine(state, patch({ o: 'x', p: '/s/7/value/0/content', v: 'stray' }))).toBe(false)
    expect(transcriptText(state)).toBe('')
  })
})

describe('patch-start', () => {
  test('seeds the steps every later pointer counts from', () => {
    const state = createTranscript()
    applyTranscriptLine(state, {
      type: 'patch-start',
      data: { s: [{ id: 'first', type: 'agent-instruction-state' }] },
      version: 1,
    })
    // /s/1 is the second step: without the seeded one this lands on /s/1 of a
    // shorter list, and the answer ends up in the wrong place
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/-', v: { id: 'answer', type: 'agent-inference', value: [] } }))
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/1/value/-', v: { type: 'text', content: 'the answer' } }))
    expect(transcriptText(state)).toBe('the answer')
  })
})

describe('record-map', () => {
  const recordMap = {
    thread: { 't-1': { value: { value: { messages: ['m-1', 'm-2'] } } } },
    thread_message: {
      'm-1': { value: { value: { step: { type: 'user', value: [['hi']] } } } },
      'm-2': {
        value: {
          value: {
            step: {
              type: 'agent-inference',
              value: [
                { type: 'thinking', content: 'weighing' },
                { type: 'text', content: 'from the record' },
              ],
            },
          },
        },
      },
    },
  }

  test('reads the finished turn out of the thread record', () => {
    expect(readRecordMap(recordMap, 't-1')).toEqual({ text: 'from the record', reasoning: 'weighing' })
  })

  test('is what a reply falls back to when the patches gave nothing', () => {
    const state = createTranscript()
    state.threadId = 't-1'
    applyTranscriptLine(state, { type: 'record-map', recordMap })
    expect(transcriptText(state)).toBe('from the record')
  })

  test('loses to the patches, which arrive first', () => {
    const state = createTranscript()
    applyTranscriptLine(state, patch({ o: 'a', p: '/s/-', v: { id: 's1', type: 'agent-inference', value: [{ type: 'text', content: 'live' }] } }))
    applyTranscriptLine(state, { type: 'record-map', recordMap })
    expect(transcriptText(state)).toBe('live')
  })
})
