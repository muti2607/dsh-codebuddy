/**
 * 只读调研：hy4flash-free 到底免不免费。
 *
 * 1. 从 /v3/config 抠出 hy4flash / hy4flash-free 的完整字段
 * 2. 抠出所有提到 hy4flash-free 的 trial/discount 活动配置（含 schedule）
 * 3. 查一次当前积分余额（作为基线）
 *
 * 不做任何写操作，不调 chat（避免真的消耗额度）。
 */
import fs from 'node:fs'
import path from 'node:path'

const YAML = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')
const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_freecheck.txt'

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
const baseHeaders = {
  accept: 'application/json',
  'content-type': 'application/json',
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
if (cred.user_id) baseHeaders['x-user-id'] = cred.user_id

const out = []
const log = (s) => out.push(String(s))

// ── 1. config ──
const cfgRes = await fetch('https://copilot.tencent.com/v3/config', { headers: baseHeaders })
const cfg = JSON.parse(await cfgRes.text())
const data = cfg.data || {}
const models = data.models || []

log('=== 目标模型完整字段 ===')
for (const id of ['hy4flash', 'hy4flash-free', 'hy4std']) {
  const m = models.find((x) => x.id === id)
  log('')
  log('--- ' + id + ' ---')
  if (!m) { log('（不在目录里）'); continue }
  log(JSON.stringify(m, null, 2))
}

// ── 2. 所有跟 free 相关的配置块 ──
log('')
log('=== 含 hy4flash-free / free 的活动配置 ===')
function walk(o, path, depth) {
  if (!o || typeof o !== 'object' || depth > 6) return
  const txt = JSON.stringify(o)
  if (txt.includes('hy4flash-free') || /免费|free_trial|每日赠送/.test(txt)) {
    // 只在「小对象」上打印，避免把整个 config 倒出来
    if (txt.length < 1200 && path) {
      log('')
      log('[' + path + ']')
      log(JSON.stringify(o, null, 2))
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object') walk(v, path + '.' + k, depth + 1)
  }
}
walk(data, '$.data', 0)

// ── 3. 当前余额 ──
log('')
log('=== 当前积分余额 ===')
const res = await fetch('https://copilot.tencent.com/v2/billing/meter/get-user-resource', {
  method: 'POST', headers: baseHeaders, body: '{}',
})
const j = JSON.parse(await res.text())
const accounts = j?.data?.Response?.Data?.Accounts || []
let total = 0
for (const a of accounts) {
  const status = a.Status
  const exp = a.ExpiredTime ? Date.parse(String(a.ExpiredTime).replace(' ', 'T')) : NaN
  const dedEnd = Number(a.DeductionEndTime) || 0
  const active = status !== 3 && !(Number.isFinite(exp) && Date.now() >= exp) && !(dedEnd > 0 && Date.now() >= dedEnd)
  if (active) total += Number.parseFloat(a.CycleCapacityRemainPrecise || a.CycleCapacityRemain || 0) || 0
}
log('有效剩余合计 = ' + (Math.round(total * 100) / 100))

fs.writeFileSync(OUT, out.join('\n'), 'utf8')
console.log('done bytes=' + out.join('\n').length)
