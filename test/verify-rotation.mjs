/**
 * 多账号轮换测试：限流(6004)/额度用尽(14018) 时是否自动换号重试。
 * 全程离线：假 ctx + 假 dshHome + 打桩 fetch。
 * Run: node test/verify-rotation.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

const SSE_OK = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
const RATE_BODY = JSON.stringify({ code: 6004, msg: '您的使用量已超出频率限制，将在 2026-11-08 18:24:35 UTC+8 重置，您也可以切换其他模型继续使用。' })
const QUOTA_BODY = JSON.stringify({ code: 14018, msg: '额度已用尽，请访问以下链接，购买加量包：https://www.codebuddy.cn/profile/usage' })

/** 建一个临时 dshHome，写入 n 个 buddy 账号。 */
function makeHome(n) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rot-'))
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  const accounts = []
  for (let i = 0; i < n; i++) {
    accounts.push({ id: 'a' + i, provider: 'buddy', enabled: true, credentialRef: 'BUDDY_' + String.fromCharCode(65 + i) })
  }
  fs.writeFileSync(path.join(home, 'channel-pack', 'state.json'), JSON.stringify({ accounts }))
  return home
}

function makeCtx() {
  const fake = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      registerAdapter(providers, adapter) { fake.adapter = adapter; return { dispose() {} } },
      registerConfigurableProviders() {},
    },
    credentials: {
      async resolve(ref) {
        const suffix = String(ref).replace('BUDDY_', '')
        return { value: JSON.stringify({ access_token: 'token-' + suffix, expires_at: String(Date.now() + 3_600_000) }) }
      },
      async set() {},
    },
    attachments: { async readImageRequest() { throw new Error('no image') } },
    inject(deps, callback) { callback(fake); return () => {} },
  }
  return fake
}

/** 用给定的响应序列跑一次 stream，返回 { usedTokens, error } */
async function runCase(accountCount, responses) {
  const home = makeHome(accountCount)
  const fake = makeCtx()
  apply(fake, { dshHome: home })

  const usedTokens = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    usedTokens.push(init.headers.Authorization)
    const spec = responses[Math.min(usedTokens.length - 1, responses.length - 1)]
    if (spec.status === 200) {
      return new Response(spec.body || SSE_OK, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(spec.body, { status: spec.status })
  }
  let error = null
  try {
    for await (const _c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { /* 吃掉 chunk */ }
  } catch (e) {
    error = String(e && e.message || e)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
  return { usedTokens, error }
}

// ---- 1. 两个账号：A 限流 → 自动换到 B 并成功 ----
{
  const r = await runCase(2, [{ status: 429, body: RATE_BODY }, { status: 200 }])
  if (r.error) fail('限流后换号应成功，实际报错: ' + r.error)
  if (r.usedTokens.length !== 2) fail('应恰好请求 2 次，实际 ' + r.usedTokens.length)
  if (r.usedTokens[0] !== 'Bearer token-A') fail('首次应使用账号 A，实际 ' + r.usedTokens[0])
  if (r.usedTokens[1] !== 'Bearer token-B') fail('应换到账号 B 重试，实际 ' + r.usedTokens[1])
}

// ---- 2. 两个账号：额度用尽(14018) 同样换号 ----
{
  const r = await runCase(2, [{ status: 429, body: QUOTA_BODY }, { status: 200 }])
  if (r.error) fail('额度用尽后换号应成功，实际报错: ' + r.error)
  if (r.usedTokens[1] !== 'Bearer token-B') fail('额度用尽也应换号，实际 ' + r.usedTokens[1])
}

// ---- 3. 只有一个账号：不换号，如实报频率限制 ----
{
  const r = await runCase(1, [{ status: 429, body: RATE_BODY }])
  if (!r.error) fail('单账号限流应报错')
  if (!/频率限制/.test(r.error || '')) fail('错误应说明是频率限制，实际: ' + r.error)
  if (r.usedTokens.length !== 1) fail('单账号不该重试，实际请求 ' + r.usedTokens.length + ' 次')
}

// ---- 4. 换号后仍失败：不连环换，直接抛出 ----
{
  const r = await runCase(2, [{ status: 429, body: RATE_BODY }, { status: 429, body: RATE_BODY }])
  if (!r.error) fail('换号后仍限流应报错')
  if (r.usedTokens.length !== 2) fail('不该连环换号打穿所有账号，实际请求 ' + r.usedTokens.length + ' 次')
}

// ---- 5. 死连接自愈：首次 chat fetch 抛 ECONNRESET，自动补发一次并成功 ----
{
  const home = makeHome(1)
  const fake = makeCtx()
  apply(fake, { dshHome: home })
  let first = true
  const chatAttempts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v2/chat/completions')) return new Response('{}', { status: 404 })
    chatAttempts.push(String(init?.headers?.Authorization || ''))
    if (first) {
      first = false
      const err = new TypeError('fetch failed')
      err.cause = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      throw err
    }
    return new Response(SSE_OK, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  let error = null
  try {
    const chunks = []
    for await (const c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(c)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    if (text !== 'ok') fail('死连接自愈后应拿到内容，实际: ' + JSON.stringify(text))
    if (chatAttempts.length !== 2) fail('应恰好补发一次（共 2 次 chat），实际 ' + chatAttempts.length)
  } catch (e) {
    error = String(e && e.message || e)
    fail('死连接自愈不应抛错: ' + error)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ---- 6. isConnectionDeath 判定 ----
{
  const { isConnectionDeath } = await import('../index.js')
  const wrap = (code) => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error(code), { code }); return e }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
    if (!isConnectionDeath(wrap(code))) fail(code + ' 应判为连接死亡')
  }
  // 流中途被掐：TypeError terminated / cause other side closed
  const term = new TypeError('terminated')
  term.cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  if (!isConnectionDeath(term)) fail('terminated/other side closed 应判为连接死亡')
  const term2 = new TypeError('terminated')
  if (!isConnectionDeath(term2)) fail('裸 terminated 也应判为连接死亡')
  if (isConnectionDeath(new Error('渠道校验失败 (code=11128)'))) fail('业务错误不该判为连接死亡')
  if (isConnectionDeath(Object.assign(new Error('bad json'), { code: 'SyntaxError' }))) fail('解析错误不该判为连接死亡')
}

// ---- 7. 流在输出前被 terminated：重试整轮并成功 ----
{
  const home = makeHome(1)
  const fake = makeCtx()
  apply(fake, { dshHome: home })
  let call = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/v2/chat/completions')) return new Response('{}', { status: 404 })
    call += 1
    if (call === 1) {
      // 一条 SSE 都不给就读到断流
      const body = new ReadableStream({ start(c) { c.error(new TypeError('terminated')) } })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(SSE_OK, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const chunks = []
    for await (const c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(c)
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    if (text !== 'ok') fail('输出前断流应重试并拿到内容，实际: ' + JSON.stringify(text))
    if (call !== 2) fail('应重试一次（共 2 次 chat），实际 ' + call)
  } catch (e) {
    fail('输出前断流应自愈，实际抛错: ' + String(e && e.message || e))
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ---- 8. 已输出后 terminated：从断点续写一次，拼接完整 ----
{
  const home = makeHome(1)
  const fake = makeCtx()
  apply(fake, { dshHome: home })
  let call = 0
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('/v2/chat/completions')) return new Response('{}', { status: 404 })
    call += 1
    bodies.push(String(init.body))
    if (call === 1) {
      const enc = new TextEncoder()
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"半"}}]}\n\n'))
          setTimeout(() => c.error(new TypeError('terminated')), 5)
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(SSE_OK, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  let error = null
  const chunks = []
  try {
    for await (const c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(c)
  } catch (e) {
    error = String(e && e.message || e)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
  if (error) fail('已输出后断流应续写而不是抛错: ' + error)
  if (call !== 2) fail('应续写一次（共 2 次 chat），实际 ' + call)
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  if (text !== '半ok') fail('续写应拼接在断点之后，实际: ' + JSON.stringify(text))
  // 块 index 不能冲突：两段 text 块必须是不同 index
  const starts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'text').map((c) => c.index)
  if (starts.length !== 2 || starts[0] === starts[1]) fail('续写块的 index 必须与上一段不同，实际: ' + JSON.stringify(starts))
  // 续写请求应带上断点回答 + 续写指令
  const second = JSON.parse(bodies[1])
  const msgs = second.messages
  const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
  if (!lastAssistant || !JSON.stringify(lastAssistant).includes('半')) fail('续写请求应包含断点回答')
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
  if (!lastUser || !/Continue exactly where/.test(JSON.stringify(lastUser))) fail('续写请求应带续写指令')
}

// ---- 9. 工具参数生成到一半断开：半截块从未下发，整轮重发安全 ----
{
  const home = makeHome(1)
  const fake = makeCtx()
  apply(fake, { dshHome: home })
  let call = 0
  const realFetch = globalThis.fetch
  const FULL_TOOL = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"pwsh","arguments":"{\\"command\\":\\"echo hi\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/v2/chat/completions')) return new Response('{}', { status: 404 })
    call += 1
    if (call === 1) {
      const enc = new TextEncoder()
      const body = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"pwsh","arguments":"{\\"command\\":\\"echo"}}]}}]}\n\n'))
          setTimeout(() => c.error(new TypeError('terminated')), 5)
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    }
    return new Response(FULL_TOOL, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  let error = null
  const chunks = []
  try {
    for await (const c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(c)
  } catch (e) {
    error = String(e && e.message || e)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
  if (error) fail('工具参数未完成时断流应安全重发，实际抛错: ' + error)
  if (call !== 2) fail('应整轮重发一次，实际请求 ' + call + ' 次')
  const toolEnds = chunks.filter((c) => c.type === 'block-end' && c.block && c.block.type === 'tool-call')
  if (toolEnds.length !== 1) fail('应只下发 1 个完整工具块，实际 ' + toolEnds.length)
  const args = toolEnds[0] && toolEnds[0].block && toolEnds[0].block.arguments
  let parsed = null
  try { parsed = JSON.parse(args) } catch { /* 坏 JSON */ }
  if (!parsed || parsed.command !== 'echo hi') fail('工具参数应是完整 JSON，实际: ' + String(args))
}

// ---- 10. 已下发完整工具块后再断：不可重试（否则二次执行） ----
{
  const home = makeHome(1)
  const fake = makeCtx()
  apply(fake, { dshHome: home })
  let call = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (!String(url).includes('/v2/chat/completions')) return new Response('{}', { status: 404 })
    call += 1
    const enc = new TextEncoder()
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"pwsh","arguments":"{\\"command\\":\\"echo hi\\"}"}}]}}]}\n\n'))
        setTimeout(() => c.error(new TypeError('terminated')), 5)
      },
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  let error = null
  const chunksSeen = []
  try {
    for await (const _c of fake.adapter.stream({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) { chunksSeen.push(_c) }
  } catch (e) {
    error = String(e && e.message || e)
  } finally {
    globalThis.fetch = realFetch
    fs.rmSync(home, { recursive: true, force: true })
  }
  if (!error) fail('工具块已下发后断流应报错')
  // 行为变更（1.4.5）：工具块下发后不再立刻放弃，而是进入**续写**（最多 3 次）。
  // 续写轮会 skipTools，所以不会出现「同一工具被执行两遍」；这里断言真正重要的
  // 不变量：工具块只下发一次、且恢复用尽后如实报错。
  if (!/已自动重试 3 次/.test(error)) fail('恢复用尽后应说明重试次数，实际: ' + error)
  if (call !== 4) fail('首次 + 3 次续写，应请求 4 次，实际 ' + call + ' 次')
  const toolStarts = chunksSeen.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  if (toolStarts.length !== 1) fail('工具块只能下发 1 次，实际 ' + toolStarts.length)
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
