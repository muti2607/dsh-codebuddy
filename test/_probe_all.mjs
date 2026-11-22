/**
 * 只读探测：兜底表里每个模型 id 在服务端是否还认。
 *
 * 背景（2026-11-22）：上一版把「远端目录没有、但兜底表里有」的模型全补回列表，
 * 结果 `hy4free` 一选就炸：HTTP 400 code 11102「model [hy4free] service info not found」。
 * 只探测过 hy3 / hy3-x 就以为整张表都还活着——这是错的。
 *
 * 这里对每个 id 发一次极小请求，把状态分成三类：
 *   alive    → 200 且能拿到内容/正常 SSE
 *   dead     → 400/404 且业务码 11102（service info not found）
 *   unknown  → 其它（限流、鉴权、超时），不能据此判定死活
 */
import fs from 'node:fs'
import path from 'node:path'

const YAML = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')
const IDS = fs.readFileSync('D:\\dfyqq\\dfyduihua消费记录\\_ids.txt', 'utf8').split(/\r?\n/).filter(Boolean)
const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_probe_result.json'

function readCredential(ref) {
  const all = fs.readFileSync(YAML, 'utf8').split(/\r?\n/)
  const start = all.findIndex((l) => l.includes(ref + ':'))
  if (start < 0) return null
  let acc = ''
  for (let i = start; i < all.length && i < start + 40; i++) {
    const seg = i === start ? all[i].slice(all[i].indexOf(':') + 1) : all[i]
    acc += (acc ? ' ' : '') + seg.trim()
    if (acc.trim().endsWith("'")) break
  }
  let v = acc.trim()
  if (v.startsWith("'")) v = v.slice(1)
  if (v.endsWith("'")) v = v.slice(0, -1)
  return JSON.parse(v.replace(/''/g, "'"))
}

const cred = readCredential('BUDDY_ACCOUNT_A81E3A3F')
if (!cred) {
  fs.writeFileSync(OUT, JSON.stringify({ error: 'no credential' }), 'utf8')
  process.exit(2)
}

const headers = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'user-agent': 'CodeBuddyIDE/1.106.1',
  authorization: 'Bearer ' + cred.access_token,
  'x-domain': 'copilot.tencent.com',
  'x-product': 'SaaS',
  'x-product-code': 'codebuddy',
  'x-agent-purpose': 'conversation',
  'x-ide-name': 'CodeBuddy',
  'x-ide-type': 'CodeBuddy',
  'x-ide-version': '1.106.1',
}
if (cred.user_id) headers['x-user-id'] = cred.user_id

async function probe(model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 4,
  })
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST', headers, body, signal: ctrl.signal,
    })
    const text = await res.text()
    if (res.ok && !/^\s*\{/.test(text)) return { model, verdict: 'alive', status: res.status, note: 'sse' }
    let code = null
    try { code = JSON.parse(text)?.code } catch { /* not json */ }
    if (res.ok) return { model, verdict: 'alive', status: res.status, note: 'json-ok' }
    if (code === 11102) return { model, verdict: 'dead', status: res.status, code, note: 'service info not found' }
    return { model, verdict: 'unknown', status: res.status, code, note: text.replace(/\s+/g, ' ').slice(0, 160) }
  } catch (e) {
    return { model, verdict: 'unknown', status: 0, note: 'ERR ' + (e?.message || String(e)) }
  } finally {
    clearTimeout(timer)
  }
}

const results = []
// 串行，避免并发把限流误判成死
for (const id of IDS) {
  const r = await probe(id)
  results.push(r)
  console.log(`${r.verdict.padEnd(7)} ${id.padEnd(24)} ${r.status} ${String(r.code ?? '')} ${r.note || ''}`)
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
const dead = results.filter((r) => r.verdict === 'dead').map((r) => r.model)
const alive = results.filter((r) => r.verdict === 'alive').map((r) => r.model)
const unknown = results.filter((r) => r.verdict === 'unknown').map((r) => r.model)
console.log('\nALIVE   : ' + alive.join(', '))
console.log('DEAD    : ' + dead.join(', '))
console.log('UNKNOWN : ' + unknown.join(', '))
