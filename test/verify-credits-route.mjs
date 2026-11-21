/**
 * route 层真机验证：不启动 DSH，直接把 installLoginRoutes 挂在一个假 webServer 上，
 * 然后打真实 HTTP，确认 /api/cb/credits 与 /api/cb/credits/claim 的端到端行为。
 *
 * 这条测试覆盖的是「路由参数解析 + 凭据解析 + 模块调用 + 汇总」，
 * 也就是单元测试碰不到的部分。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_route-credits.txt'
const lines = []
const log = (s) => lines.push(String(s))

const YAML = path.join(os.homedir(), '.dsh', '.credentials.yaml')

function readCredential(ref) {
  const all = fs.readFileSync(YAML, 'utf8').split(/\r?\n/)
  const startIdx = all.findIndex((l) => l.includes(ref + ':'))
  if (startIdx < 0) return null
  let acc = ''
  for (let i = startIdx; i < all.length && i < startIdx + 40; i++) {
    const seg = i === startIdx ? all[i].slice(all[i].indexOf(':') + 1) : all[i]
    acc += (acc ? ' ' : '') + seg.trim()
    if (acc.trim().endsWith("'")) break
  }
  let v = acc.trim()
  if (v.startsWith("'")) v = v.slice(1)
  if (v.endsWith("'")) v = v.slice(0, -1)
  return JSON.parse(v.replace(/''/g, "'"))
}

// 用临时 DSH_HOME，避免真实账号池被测试写入
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-route-'))
fs.mkdirSync(path.join(tmpHome, 'dsh-codebuddy'), { recursive: true })

const CREDS = {
  BUDDY_ACCOUNT_A81E3A3F: readCredential('BUDDY_ACCOUNT_A81E3A3F'),
  WORKBUDDY_ACCOUNT_05704C1E: readCredential('WORKBUDDY_ACCOUNT_05704C1E'),
}

// 造一个账号池：两个账号都启用
fs.writeFileSync(path.join(tmpHome, 'dsh-codebuddy', 'accounts.json'), JSON.stringify({
  schema: 'dsh-codebuddy/accounts/v1',
  accounts: [
    { id: 'buddy-test', provider: 'buddy', nickname: '测试CodeBuddy', credentialRef: 'BUDDY_ACCOUNT_A81E3A3F', enabled: true, refreshable: true, createdAt: 1, updatedAt: 1, expiresAt: 0 },
    { id: 'wb-test', provider: 'workbuddy', nickname: '测试WorkBuddy', credentialRef: 'WORKBUDDY_ACCOUNT_05704C1E', enabled: true, refreshable: true, createdAt: 1, updatedAt: 1, expiresAt: 0 },
  ],
}, null, 2), 'utf8')

const { apply } = await import('../index.js')

// 假 webServer：单条 prefix 路由表
const registrations = []
const fakeServer = {
  register(spec) {
    registrations.push(spec)
    return () => {}
  },
}

const credentialsStub = {
  async resolve(ref) {
    const cred = CREDS[ref]
    if (!cred) return null
    return { value: JSON.stringify(cred) }
  },
  async set() {},
  async unset() {},
}

// 极小的 cordis 壳：inject 直接调用，只暴露 webServer / credentials
const root = {
  logger: {
    info: (m) => lines.push('[info] ' + m),
    warn: (m) => lines.push('[warn] ' + m),
    error: (m) => lines.push('[error] ' + m),
  },
  inject(deps, cb) {
    cb({
      webServer: fakeServer,
      credentials: credentialsStub,
      logger: root.logger,
      get(name) {
        if (name === 'webServer') return fakeServer
        if (name === 'credentials') return credentialsStub
        return null
      },
    })
  },
}

const cleanup = apply(root, { dshHome: tmpHome, autoUpdate: false })
log('注册的路由数=' + registrations.length)
for (const r of registrations) log('  ' + r.kind + ' ' + r.path)

// 把 prefix 路由接成真 HTTP
const server = http.createServer(async (req, res) => {
  for (const spec of registrations) {
    if (req.url.startsWith(spec.path)) {
      try { await spec.handler(req, res) } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(e && e.message) }))
      }
      return
    }
  }
  res.writeHead(404); res.end('no-route')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function call(pathname, init) {
  const res = await fetch(base + pathname, init)
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = { raw: text.slice(0, 300) } }
  return { status: res.status, body }
}

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); }

// 1) GET /api/cb/credits —— 两个账号都查
{
  const r = await call('/api/cb/credits')
  log('')
  log('=== GET /api/cb/credits → ' + r.status)
  log(JSON.stringify(r.body, null, 2).slice(0, 2500))
  check('credits 返回 200', r.status === 200)
  check('ok=true', r.body.ok === true)
  check('两个账号都有结果', Array.isArray(r.body.accounts) && r.body.accounts.length === 2)
  check('有汇总 total', Number.isFinite(r.body.total))
  const buddy = (r.body.accounts || []).find((a) => a.provider === 'buddy')
  const wb = (r.body.accounts || []).find((a) => a.provider === 'workbuddy')
  check('buddy 余额查到', buddy && buddy.balance && buddy.balance.total > 0, buddy && buddy.balance && buddy.balance.total)
  check('buddy 签到状态有', buddy && buddy.checkin && typeof buddy.checkin.active === 'boolean')
  check('workbuddy 也有余额', wb && wb.balance && Number.isFinite(wb.balance.total))
  check('不回传 access_token', !JSON.stringify(r.body).includes('access_token'))
  check('不回传 eyJ（JWT 头）', !JSON.stringify(r.body).includes('eyJ'))
}

// 2) GET /api/cb/credits?accountId= 单个
{
  const r = await call('/api/cb/credits?accountId=buddy-test')
  log('')
  log('=== GET /api/cb/credits?accountId=buddy-test → ' + r.status)
  log('accounts 数量=' + (r.body.accounts || []).length)
  check('单账号只返回 1 条', (r.body.accounts || []).length === 1)
  check('单账号 accountId 对', (r.body.accounts || [])[0]?.accountId === 'buddy-test')
}

// 3) 不存在的 accountId
{
  const r = await call('/api/cb/credits?accountId=nope')
  log('')
  log('=== GET ?accountId=nope → ' + r.status + ' ' + JSON.stringify(r.body))
  check('不存在账号 ok=false', r.body.ok === false)
  check('不存在账号有中文提示', String(r.body.error || '').includes('账号'))
}

// 4) /api/cb/credits 用 POST → 405
{
  const r = await call('/api/cb/credits', { method: 'POST' })
  check('POST /credits 是 405', r.status === 405)
}

// 5) /api/cb/credits/claim 用 GET → 405
{
  const r = await call('/api/cb/credits/claim')
  check('GET /credits/claim 是 405', r.status === 405)
}

// 6) 未知路径 → 404（不能把 /api/cb/xxx 当成积分）
{
  const r = await call('/api/cb/unknown')
  check('未知路径 404', r.status === 404)
}

// 7) 真实领取：buddy 今天已领 → already-claimed（不消耗额度）
{
  const r = await call('/api/cb/credits/claim', { method: 'POST' })
  log('')
  log('=== POST /api/cb/credits/claim → ' + r.status)
  log(JSON.stringify(r.body, null, 2).slice(0, 1600))
  check('claim 返回 200', r.status === 200)
  check('claim ok=true', r.body.ok === true)
  check('claim 有 results', Array.isArray(r.body.results) && r.body.results.length === 2)
  const buddy = (r.body.results || []).find((x) => x.provider === 'buddy')
  check('buddy 已领取 → already-claimed', buddy && buddy.status === 'already-claimed', buddy && buddy.status)
  check('gained 是数字', Number.isFinite(r.body.gained))
}

// 8) 凭据失效的账号 → 明确报错，不崩
{
  fs.writeFileSync(path.join(tmpHome, 'dsh-codebuddy', 'accounts.json'), JSON.stringify({
    schema: 'dsh-codebuddy/accounts/v1',
    accounts: [
      { id: 'bad', provider: 'buddy', nickname: '坏凭据', credentialRef: 'MISSING_REF', enabled: true, refreshable: true, createdAt: 1, updatedAt: 1, expiresAt: 0 },
    ],
  }, null, 2), 'utf8')
  const r = await call('/api/cb/credits')
  log('')
  log('=== 坏凭据 → ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 400))
  check('坏凭据不 500', r.status === 200)
  check('坏凭据 ok=true（部分成功语义）', r.body.ok === true)
  check('坏凭据单项 ok=false', (r.body.accounts || [])[0]?.ok === false)
  check('坏凭据有原因', String((r.body.accounts || [])[0]?.error || '').length > 0)
}

// 9) 空账号池 → 明确提示
{
  fs.writeFileSync(path.join(tmpHome, 'dsh-codebuddy', 'accounts.json'), JSON.stringify({
    schema: 'dsh-codebuddy/accounts/v1', accounts: [],
  }, null, 2), 'utf8')
  const r = await call('/api/cb/credits')
  check('空账号池 ok=false', r.body.ok === false)
  check('空账号池有提示', String(r.body.error || '').length > 0)
}

server.close()
try { cleanup() } catch {}
try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch {}

log('')
let bad = 0
for (const { name, ok, detail } of results) {
  if (!ok) bad += 1
  log((ok ? 'OK   ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''))
}
log(bad === 0 ? `\n路由层 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
process.exit(bad ? 1 : 0)
