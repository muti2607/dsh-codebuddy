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
  if (isConnectionDeath(new Error('渠道校验失败 (code=11128)'))) fail('业务错误不该判为连接死亡')
  if (isConnectionDeath(Object.assign(new Error('bad json'), { code: 'SyntaxError' }))) fail('解析错误不该判为连接死亡')
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
