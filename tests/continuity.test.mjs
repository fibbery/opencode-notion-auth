import { test, expect } from 'bun:test'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotionPlugin, _internal } from '../index.mjs'
import { beginSession, messageHash } from '../sessions.mjs'
import { createTurnMetadata } from '../usage.mjs'

const account = { userId: 'continuity-user', spaceId: 'continuity-space', cookie: 'fake-only' }
const wrap = value => ({ value: { value } })
const step = (id, text, extra = {}) => ({ id, type: 'agent-inference', finishedAt: 1, value: [{ type: 'text', content: text }], model: 'local-model', ...extra })
function record(threadId, id, text, credits = 1) {
  return { type: 'record-map', recordMap: {
    thread: { [threadId]: wrap({ messages: [id], data: { usage_summary: { credits_by_type_unit: { basic: credits } } } }) },
    thread_message: { [id]: wrap({ step: step(id, text, { inputTokens: 100, outputTokens: 5, cachedTokensRead: 70, cachedTokensCreated: 10 }) }) },
  } }
}
async function local(action, answer = (_, i) => 'ANSWER-' + i) {
  const directory = await mkdtemp(join(tmpdir(), 'notion-continuity-'))
  const oldDir = process.env.NOTION_SESSION_DIR, oldOrigin = process.env.NOTION_API_BASE
  const requests = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const payload = await req.json(); requests.push(payload)
    const i = requests.length
    const text = answer(payload, i)
    return new Response(JSON.stringify(record(payload.threadId, 'message-' + i, text, i)) + '\n')
  } })
  process.env.NOTION_SESSION_DIR = directory; process.env.NOTION_API_BASE = server.url.origin
  try {
    const plugin = await NotionPlugin({})
    const provider = await plugin.auth.loader(async () => ({ key: account.cookie, metadata: { ...account, clientVersion: 'local-version' } }))
    const send = async (messages, sid = 'session-A', extra = {}) => {
      const response = await provider.fetch('', { headers: { 'x-notion-session': sid }, body: JSON.stringify({ model: 'local-model', messages, stream: false, ...extra }) })
      return { response, data: await response.json() }
    }
    return await action({ send, requests, directory, plugin })
  } finally {
    server.stop(true)
    if (oldDir === undefined) delete process.env.NOTION_SESSION_DIR; else process.env.NOTION_SESSION_DIR = oldDir
    if (oldOrigin === undefined) delete process.env.NOTION_API_BASE; else process.env.NOTION_API_BASE = oldOrigin
    await rm(directory, { recursive: true, force: true })
  }
}

test('same session appends only new messages and returns upstream usage', () => local(async ({send,requests,directory}) => {
  const initial = { role: 'user', content: 'INITIAL-UNIQUE-' + 'a'.repeat(1000) }
  const a = await send([initial])
  const next = { role: 'user', content: 'FOLLOWUP-ONLY' }
  const b = await send([initial, a.data.choices[0].message, next])
  expect(a.response.status).toBe(200); expect(b.response.status).toBe(200)
  expect(requests[0].createThread).toBe(true); expect(requests[0].saveAllThreadOperations).toBe(true)
  expect(requests[1].threadId).toBe(requests[0].threadId)
  expect(requests[1].createThread).toBe(false); expect(requests[1].isPartialTranscript).toBe(true)
  expect(requests[1].transcript).toHaveLength(1)
  const text = JSON.stringify(requests[1].transcript)
  expect(text).toContain('FOLLOWUP-ONLY'); expect(text).not.toContain('INITIAL-UNIQUE')
  expect(a.data.usage).toMatchObject({ prompt_tokens: 110, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 10 } })
  expect(b.data.notion.credits.basic).toBe(1)
  expect(requests[0].transcript[0].value.useWebSearch).toBe(true)
  const files = await readdir(directory)
  const state = await readFile(join(directory, files.find(n=>n.endsWith('.json'))), 'utf8')
  expect(state).not.toContain('INITIAL-UNIQUE'); expect(state).not.toContain('fake-only')
  const diag = (await readFile(join(directory,'diagnostics.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)
  expect(diag[1].avoidedCharacters).toBeGreaterThan(1000)
}))

test('tool result is appended to the same thread and used for final answer', () => local(async ({send,requests}) => {
  const first = { role: 'user', content: 'Read the diagnostic file.' }
  const tool = { type: 'function', function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' } } }
  const a = await send([first], 'tool-session', { tools: [tool] })
  const message = a.data.choices[0].message
  expect(message.tool_calls[0].function.name).toBe('Read')
  const b = await send([first, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'FILE-VALUE=violet' }], 'tool-session', { tools: [tool] })
  expect(b.data.choices[0].message.content).toContain('violet')
  expect(requests[1].createThread).toBe(false)
  expect(JSON.stringify(requests[1].transcript)).toContain('FILE-VALUE=violet')
  expect(JSON.stringify(requests[1].transcript)).not.toContain('Tool catalog:')
}, (_,i)=> i===1 ? '{"tool":"Read","arguments":{"file_path":"fixture.txt"}}' : 'The value is violet.'))

test('different client sessions never share Notion threads', () => local(async({send,requests})=>{
  await send([{role:'user',content:'A'}], 'isolation-A'); await send([{role:'user',content:'B'}], 'isolation-B')
  expect(requests[0].threadId).not.toBe(requests[1].threadId)
}))

test('consecutive tool calls get distinct IDs and their real results stay on the shared thread',()=>local(async({send,requests})=>{
  const tools=[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]
  const first={role:'user',content:'Read the first file, then a second file.'}
  const a=await send([first],'two-tools',{tools})
  const firstCall=a.data.choices[0].message
  const history=[first,firstCall,{role:'tool',tool_call_id:firstCall.tool_calls[0].id,content:'FIRST_RESULT'}]
  const b=await send(history,'two-tools',{tools})
  const secondCall=b.data.choices[0].message
  expect(firstCall.tool_calls[0].id).not.toBe(secondCall.tool_calls[0].id)
  await send([...history,secondCall,{role:'tool',tool_call_id:secondCall.tool_calls[0].id,content:'SECOND_RESULT'}],'two-tools',{tools})
  expect(new Set(requests.map(p=>p.threadId)).size).toBe(1)
  const last=JSON.stringify(requests[2].transcript)
  expect(last).toContain('SECOND_RESULT')
  expect(last).toContain(secondCall.tool_calls[0].id)
  expect(last).not.toContain('FIRST_RESULT')
},()=>'{"tool":"Read","arguments":{"file_path":"fixture.txt"}}'))

test('model changes and rewritten history keep the same task thread with updated config/context', () => local(async({send,requests})=>{
  const first={role:'user',content:'original'}; const a=await send([first])
  await send([first,a.data.choices[0].message,{role:'user',content:'next'}], 'session-A',{model:'another-model'})
  expect(requests[1].createThread).toBe(false)
  expect(requests[1].transcript[0].value.model).toBe('another-model')
  await send([{role:'user',content:'compacted summary'}])
  expect(requests[2].createThread).toBe(false)
  expect(requests[2].threadId).toBe(requests[0].threadId)
  expect(JSON.stringify(requests[2].transcript)).toContain('compacted summary')
}))

test('interleaved helpers, billing changes and effort changes cannot replace the primary task thread',()=>local(async({send,requests})=>{
  const tools=[{type:'function',function:{name:'Read',parameters:{type:'object'}}}]
  const sys=cch=>({role:'system',content:`x-anthropic-billing-header: cc_version=2.1.304; cch=${cch};\nMain coding instructions`})
  const first={role:'user',content:'MAIN_TASK_'+ 'a'.repeat(3000)}
  const a=await send([sys('one'),first],'task',{tools,reasoning_effort:'high'})
  await send([{role:'system',content:'Classify a command prefix'}, {role:'user',content:'type fixture.txt'}],'task')
  const history=[sys('two'),first,a.data.choices[0].message,{role:'system',content:'<total_tokens>90000 tokens left</total_tokens>'},{role:'user',content:'MAIN_CONTINUE'}]
  const b=await send(history,'task',{tools,reasoning_effort:'low'})
  await send([{role:'system',content:'Return a short title'},{role:'user',content:'Main task title'}],'task',{model:'title-model'})
  await send([...history,b.data.choices[0].message,{role:'user',content:'MAIN_FINAL'}],'task',{tools,reasoning_effort:'low'})
  expect(new Set(requests.map(p=>p.threadId)).size).toBe(1)
  expect(requests.slice(1).every(p=>p.createThread===false)).toBe(true)
  expect(requests[2].transcript[0].value.reasoningEffort).toBe('low')
  expect(requests[2].transcript[0].id).toBe(requests[0].transcript[0].id)
  expect(requests[4].transcript[0].id).toBe(requests[0].transcript[0].id)
  const continuation=JSON.stringify(requests[2].transcript)
  expect(continuation).not.toContain('MAIN_TASK_')
  expect(continuation).not.toContain('Tool catalog:')
  expect(continuation).toContain('MAIN_CONTINUE')
  expect(continuation).toContain('90000 tokens left')
  expect(requests[4].transcript[0].value.model).toBe('local-model')
  expect(JSON.stringify(requests[4].transcript)).not.toContain('MAIN_TASK_')
}))

test('a suggestion branch leaves the accepted main history available for the next user turn',()=>local(async({send,requests})=>{
  const user={role:'user',content:'MAIN_ORIGINAL'}
  const a=await send([user]);const main=[user,a.data.choices[0].message]
  await send([...main,{role:'user',content:'[SUGGESTION MODE: suggest the next user input]'}])
  await send([...main,{role:'user',content:'ACTUAL_FOLLOW_UP'}])
  expect(new Set(requests.map(p=>p.threadId)).size).toBe(1)
  expect(JSON.stringify(requests[2].transcript)).toContain('ACTUAL_FOLLOW_UP')
  expect(JSON.stringify(requests[2].transcript)).not.toContain('MAIN_ORIGINAL')
}))

test('pending state from a stopped process is not reused', () => local(async({send,requests,directory})=>{
  const first={role:'user',content:'original'}; const a=await send([first])
  const name=(await readdir(directory)).find(n=>n.endsWith('.json'))
  const p=join(directory,name);const state=JSON.parse(await readFile(p,'utf8'));state.pending=true;await writeFile(p,JSON.stringify(state))
  await send([first,a.data.choices[0].message,{role:'user',content:'next'}])
  expect(requests[1].createThread).toBe(true)
}))

test('an installed v1 state migrates without creating another Notion chat',()=>local(async({send,requests,directory})=>{
  const first={role:'user',content:'original'};const a=await send([first])
  const name=(await readdir(directory)).find(n=>n.endsWith('.json'))
  const path=join(directory,name),state=JSON.parse(await readFile(path,'utf8'))
  state.version=1;delete state.anchors;delete state.contexts;delete state.configId
  await writeFile(path,JSON.stringify(state))
  await send([first,a.data.choices[0].message,{role:'user',content:'next'}])
  expect(requests[1].createThread).toBe(false)
  expect(requests[1].threadId).toBe(requests[0].threadId)
}))

test('failed inference invalidates the saved workflow and the next turn can recover', () => local(async({send,requests})=>{
  const first={role:'user',content:'original'};const a=await send([first])
  expect(a.response.status).toBe(200)
  const history=[first,a.data.choices[0].message,{role:'user',content:'failed follow-up'}]
  const failed=await send(history)
  expect(failed.response.status).toBe(502)
  expect(requests[1].createThread).toBe(false)
  const recovered=await send(history)
  expect(recovered.response.status).toBe(200)
  expect(requests[2].createThread).toBe(true)
  expect(requests[2].threadId).not.toBe(requests[0].threadId)
  expect(JSON.stringify(requests[2].transcript)).toContain('original')
},(_,i)=>i===2?'':'RECOVERED'))

test('session hook forwards stable identity only for this provider', () => local(async({plugin})=>{
  const output={headers:{}};await plugin['chat.headers']({model:{providerID:'notion'},sessionID:'stable'},output)
  expect(output.headers['x-notion-session']).toBe('stable')
  const other={headers:{}};await plugin['chat.headers']({model:{providerID:'other'},sessionID:'stable'},other)
  expect(other.headers['x-notion-session']).toBeUndefined()
}))

test('usage excludes old steps and deduplicates repeated record events',()=>{
  const meta=createTurnMetadata('thread',['old'])
  const event=record('thread','new','OK',4)
  event.recordMap.thread.thread.value.value.messages.unshift('old')
  event.recordMap.thread_message.old=wrap({step:step('old','HISTORY',{inputTokens:9999,outputTokens:9999})})
  meta.feed(event);meta.feed(event)
  const result=meta.result({credits_by_type_unit:{basic:3}})
  expect(result.usage.prompt_tokens).toBe(110);expect(result.usage.completion_tokens).toBe(5)
  expect(result.inferenceCount).toBe(1);expect(result.credits.basic).toBe(1)
})

test('server web tool evidence excludes old and automatic preload steps',()=>{
  const meta=createTurnMetadata('thread',['old'])
  meta.feed({type:'record-map',recordMap:{thread:{thread:wrap({messages:['old','preload','search']})},thread_message:{
    old:wrap({step:{type:'agent-tool-result',state:'applied',input:{function:'old.tool'}}}),
    preload:wrap({step:{type:'agent-tool-result',state:'applied',autoLoadPhase:'initial',input:{function:'preload.tool'}}}),
    search:wrap({step:{type:'agent-tool-result',state:'applied',input:{function:'connections.web.search'}}}),
  }}})
  expect(meta.result().serverTools).toEqual(['connections.web.search'])
})

test('missing upstream usage remains unknown rather than fabricated zero',async()=>{
  const raw=JSON.stringify(step('new','OK'))+'\n'
  const result=await _internal.consumeTranscript(new Response(raw).body,null,{threadId:'thread'})
  expect(result.usageStatus).toBe('unknown');expect(result.usage).toBeUndefined()
})

test('old thread text cannot leak into progress or validate an unfinished new turn',async()=>{
  const events=[{type:'patch-start',data:{s:[step('old','OLD-ANSWER')]}},{type:'agent-inference',id:'new',value:[{type:'text',content:'new-partial'}]}]
  const progress=[]
  await expect(_internal.consumeTranscript(new Response(events.map(JSON.stringify).join('\n')).body,text=>progress.push(text),{threadId:'thread',excludedIds:['old']})).rejects.toThrow('before the assistant finished')
  expect(progress).toEqual(['new-partial'])
})

test('a cancelled queued turn cannot unlock another still-running turn',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'notion-lock-'));const old=process.env.NOTION_SESSION_DIR;process.env.NOTION_SESSION_DIR=directory
  try{
    const body={model:'test',messages:[{role:'user',content:'x'}]}
    const first=await beginSession({sessionId:'lock',account,body,webSearch:false})
    const ctl=new AbortController()
    const second=beginSession({sessionId:'lock',account,body,webSearch:false,signal:ctl.signal})
    ctl.abort(new Error('queued-cancel'))
    await expect(second).rejects.toThrow('queued-cancel')
    let acquired=false
    const third=beginSession({sessionId:'lock',account,body,webSearch:false}).then(s=>{acquired=true;return s})
    await Promise.resolve();expect(acquired).toBe(false)
    await first.fail(new Error('test complete'))
    const last=await third;expect(acquired).toBe(true);await last.fail(new Error('test complete'))
  }finally{if(old===undefined)delete process.env.NOTION_SESSION_DIR;else process.env.NOTION_SESSION_DIR=old;await rm(directory,{recursive:true,force:true})}
})
