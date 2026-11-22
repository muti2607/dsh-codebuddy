/**
 * 原生登录流测试（不依赖 OFM）：协议字段解析 + 账号池 + 路由闭环。
 * 全程离线：假 fetch、autoOpenBrowser:false 拦住真开浏览器。
 * Run: node test/verify-login.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRODUCTS, beginBuddyLogin, completeBuddyLogin, buildCredential, parseTokenData } from '../src/buddy-login.js'
import { readAccounts, newCredentialRef, newAccountId } from '../src/account-store.js'
import { apply } from '../index.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

/** 造一个可被 jwtClaim 解出 sub/nickname/iat 的假 JWT。 */
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`
}
const IAT = 1_700_000_000
const JWT = fakeJwt({ sub: 'uid-from-jwt', nickname: 'JWT昵称', iat: IAT, exp: IAT + 3600 })

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })

// ---- 1. begin：state 端点、平台参数与请求头 ----
{
  const seen = []
  const fetcher = async (url, init) => {
    seen.push({ url, headers: init.headers, method: init.method })
    return jsonResponse({ code: 0, data: { state: 'STATE123', authUrl: 'https://copilot.tencent.com/oauth?x=1' } })
  }
  const begun = await beginBuddyLogin({ product: PRODUCTS.buddy, fetcher })
  if (begun.state !== 'STATE123') fail('state 解析不对: ' + begun.state)
  if (!begun.loginUrl.includes('oauth?x=1')) fail('authUrl 不对: ' + begun.loginUrl)
  if (!seen[0].url.includes('/v2/plugin/auth/state?platform=ide')) fail('state 端点/平台不对: ' + seen[0].url)
  if (seen[0].method !== 'POST') fail('state 应为 POST')
  const h = seen[0].headers
  if (h['X-Domain'] !== 'copilot.tencent.com') fail('X-Domain 不对: ' + h['X-Domain'])
  if (h['X-No-Authorization'] !== 'true') fail('缺 X-No-Authorization')
  if (h['X-No-User-Id'] !== 'true') fail('缺 X-No-User-Id')
  if (h['X-No-Enterprise-Id'] !== 'true') fail('缺 X-No-Enterprise-Id')
  if (h['User-Agent'] !== 'CodeBuddyIDE/1.106.1') fail('UA 不对: ' + h['User-Agent'])
}

// ---- 2. workbuddy 装饰 URL，buddy 不装饰 ----
{
  const fetcher = async () => jsonResponse({ code: 0, data: { state: 'S', authUrl: 'https://www.workbuddy.ai/oauth?a=1' } })
  const u = new URL((await beginBuddyLogin({ product: PRODUCTS.workbuddy, fetcher })).loginUrl)
  if (u.searchParams.get('version') !== '5.5.2') fail('workbuddy 应带 version=5.5.2: ' + u)
  if (!u.searchParams.get('loginSessionId')) fail('workbuddy 应带 loginSessionId: ' + u)
  const f2 = async () => jsonResponse({ code: 0, data: { state: 'S', authUrl: 'https://copilot.tencent.com/oauth?a=1' } })
  const b2 = await beginBuddyLogin({ product: PRODUCTS.buddy, fetcher: f2 })
  if (b2.loginUrl.includes('loginSessionId')) fail('buddy 不该追加会话参数: ' + b2.loginUrl)
}

// ---- 3. complete：未就绪继续轮询 → 成功；请求头正确 ----
{
  const urls = []
  let tokenTries = 0
  let accountTries = 0
  const fetcher = async (url, init) => {
    urls.push({ url, headers: init.headers })
    if (url.includes('/v2/plugin/auth/token')) {
      tokenTries++
      if (tokenTries === 1) return jsonResponse({ code: 11217, message: 'not ready' }, 400)
      return jsonResponse({
        code: 0,
        data: { accessToken: JWT, refreshToken: 'RT-1', expiresIn: 7200, tokenType: 'Bearer', scope: 'acr', domain: 'copilot.tencent.com' },
      })
    }
    if (url.includes('/v2/plugin/login/account')) {
      accountTries++
      if (accountTries === 1) return jsonResponse({ code: 12151, message: 'not ready' }, 400)
      return jsonResponse({ code: 0, data: { uid: 'uid-real', nickname: '有充电宝', enterpriseId: '', type: 'personal' } })
    }
    return jsonResponse({}, 404)
  }
  const done = await completeBuddyLogin('STATE123', { product: PRODUCTS.buddy, fetcher, pollIntervalMs: 5, timeoutMs: 5000 })
  if (tokenTries !== 2) fail('token 应在未就绪后重试，实际 ' + tokenTries + ' 次')
  if (accountTries !== 2) fail('account 应在未就绪后重试，实际 ' + accountTries + ' 次')
  if (done.nickname !== '有充电宝') fail('昵称应取 account: ' + done.nickname)
  if (done.userId !== 'uid-real') fail('uid 应取 account: ' + done.userId)
  if (!done.expiresAt) fail('expiresAt 应非 0')
  if (!done.refreshable) fail('有 refresh_token 应 refreshable')
  const cred = JSON.parse(done.credentialJson)
  if (cred.access_token !== JWT) fail('凭据 access_token 不对')
  if (cred.refresh_token !== 'RT-1') fail('凭据 refresh_token 不对')
  // 与现有 loadCredential/isExpired/refreshCredential 兼容：expires_at 必须是字符串
  if (typeof cred.expires_at !== 'string') fail('expires_at 必须是字符串')
  if (!('enterprise_id' in cred)) fail('必须含 enterprise_id 键（buildHeaders 依赖）')
  const tok = urls.find((u) => u.url.includes('/auth/token'))
  if (!tok.url.includes('state=STATE123')) fail('token 请求要带 state')
  if (tok.headers['X-No-Authorization'] !== 'true') fail('token 请求要声明无鉴权')
  const acc = urls.find((u) => u.url.includes('/login/account'))
  if (acc.headers.Authorization !== `Bearer ${JWT}`) fail('account 请求要带 Bearer')
  if (acc.headers['X-Domain'] !== 'copilot.tencent.com') fail('account X-Domain 应用服务端下发值')
}

// ---- 4. account 缺字段回落 JWT；无过期字段为空串 ----
{
  const empty = { uid: '', nickname: '', enterpriseId: '', accountType: 'personal' }
  const c = buildCredential(parseTokenData({ accessToken: JWT, refreshToken: 'R' }), empty)
  if (c.user_id !== 'uid-from-jwt') fail('uid 缺失应回落 JWT sub: ' + c.user_id)
  if (c.nickname !== 'JWT昵称') fail('昵称缺失应回落 JWT nickname: ' + c.nickname)
  if (parseTokenData({ accessToken: JWT }).expiresAt !== '') fail('无过期字段应为空串')
}

// ---- 5. 绝对 expiresAt 优先于相对 expiresIn ----
{
  const abs = Date.now() + 86_400_000
  const t = parseTokenData({ accessToken: JWT, expiresIn: 60, expiresAt: abs })
  if (t.expiresAt !== String(abs)) fail('绝对字段应优先: ' + t.expiresAt)
  const rel = parseTokenData({ accessToken: JWT, expiresIn: 60 })
  if (Number(rel.expiresAt) < IAT * 1000) fail('相对字段应以 JWT iat 为基准')
}

// ---- 6. 账号池读写与过滤 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-accounts-'))
  try {
    const ref = newCredentialRef('buddy')
    if (!/^BUDDY_ACCOUNT_[0-9A-F]{6,}$/.test(ref)) fail('ref 名不符约定: ' + ref)
    const id = newAccountId('buddy')
    if (!/^buddy-[0-9a-f]{6}$/.test(id)) fail('id 不符约定: ' + id)
    const { addAccount, updateAccount, removeAccount, availableAccounts } = await import('../src/account-store.js')
    addAccount(home, { id, provider: 'buddy', nickname: '测试号', credentialRef: ref, expiresAt: Date.now() + 60_000, refreshable: true })
    if (readAccounts(home).length !== 1) fail('应写入 1 个账号')
    if (availableAccounts(home, 'buddy').length !== 1) fail('未过期应可选')
    updateAccount(home, id, { enabled: false })
    if (availableAccounts(home, 'buddy').length !== 0) fail('停用后不应可选')
    updateAccount(home, id, { enabled: true, expiresAt: Date.now() - 1 })
    if (availableAccounts(home, 'buddy').length !== 0) fail('已过期不应可选')
    fs.writeFileSync(path.join(home, 'dsh-codebuddy', 'accounts.json'), '{ broken')
    if (readAccounts(home).length !== 0) fail('损坏文件应视为空池，不得抛')
    removeAccount(home, id)
    if (readAccounts(home).length !== 0) fail('删除后应为空')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 7. 路由闭环：起登录→轮询→凭据入库→通道能读到，且不回传令牌 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-login-route-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const saved = new Map()
  let tokenTries = 0
  const fetcher = async (url) => {
    if (url.includes('/auth/state')) return jsonResponse({ code: 0, data: { state: 'ST', authUrl: 'https://copilot.tencent.com/oauth?x=1' } })
    if (url.includes('/auth/token')) { tokenTries++; return jsonResponse({ code: 0, data: { accessToken: JWT, refreshToken: 'R', expiresIn: 7200, domain: 'copilot.tencent.com' } }) }
    if (url.includes('/login/account')) return jsonResponse({ code: 0, data: { uid: 'u1', nickname: '路由号', enterpriseId: '', type: 'personal' } })
    return jsonResponse({}, 404)
  }
  let route = null
  const routes = []
  const fake = {
    logger: { info: () => {}, warn: () => {} },
    llm: { registerAdapter() { return { dispose() {} } }, registerConfigurableProviders() {} },
    credentials: {
      async resolve(ref) { return saved.has(ref) ? { value: saved.get(ref) } : undefined },
      async set(ref, value) { saved.set(ref, value) },
      async unset(ref) { saved.delete(ref) },
    },
    attachments: { async readImageRequest() { throw new Error('no image') } },
    webServer: { register(r) { routes.push(r); if (r.path === '/api/cb') route = r; return () => {} } },
    inject(d, cb) { cb(fake); return () => {} },
  }
  const realFetch = globalThis.fetch
  try {
    apply(fake, { dshHome: home, autoOpenBrowser: false })
    if (!route) fail('/api/cb 登录路由未注册: ' + routes.map((r) => r.path).join(','))
    if (!routes.some((r) => r.path === '/api/codebuddy')) fail('更新路由必须仍在（两条路由不能互相遮蔽）')
    globalThis.fetch = fetcher
    const call = async (method, url, body) => {
      let status = 0, out = ''
      const req = { method, url, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)) } }
      await route.handler(req, { writeHead(c) { status = c }, end(t) { out = String(t) } })
      return { status, body: JSON.parse(out) }
    }
    const started = await call('POST', '/api/cb/login?provider=buddy')
    if (started.status !== 200 || !started.body.ok) fail('起登录应 200/ok: ' + JSON.stringify(started.body))
    if (!started.body.accountId) fail('应返回 accountId')
    if (!String(started.body.loginUrl).includes('oauth?x=1')) fail('应返回 loginUrl: ' + started.body.loginUrl)
    if (started.body.status !== 'pending') fail('初始应 pending')
    if (started.body.browserOpened !== false) fail('autoOpenBrowser:false 应不打开浏览器')

    let status = 'pending'
    for (let i = 0; i < 40 && status !== 'done'; i++) {
      const p = await call('GET', '/api/cb/login?accountId=' + encodeURIComponent(started.body.accountId))
      status = p.body.status
      if (status === 'failed') { fail('登录不应失败: ' + p.body.error); break }
      await new Promise((r) => setTimeout(r, 120))
    }
    if (status !== 'done') fail('轮询应到 done，实际 ' + status)
    if (saved.size !== 1) fail('应写入 1 份凭据，实际 ' + saved.size)
    const cred = JSON.parse([...saved.values()][0])
    if (cred.nickname !== '路由号') fail('凭据昵称不对: ' + cred.nickname)

    const list = await call('GET', '/api/cb/accounts')
    if (!list.body.ok || list.body.accounts.length !== 1) fail('账号列表不对: ' + JSON.stringify(list.body))
    if (list.body.accounts[0].nickname !== '路由号') fail('账号昵称不对')
    const listed = JSON.stringify(list.body)
    if (listed.includes(JWT) || listed.includes('refresh_token') || listed.includes('credentialRef')) {
      fail('账号列表不得回传令牌或 ref 明细: ' + listed.slice(0, 200))
    }

    // 停用后立即不参与选号（availableAccounts 过滤 enabled）
    const off = await call('POST', '/api/cb/accounts', { accountId: list.body.accounts[0].id, action: 'setEnabled', enabled: false })
    if (!off.body.ok) fail('停用失败: ' + JSON.stringify(off.body))
    const { availableAccounts } = await import('../src/account-store.js')
    if (availableAccounts(home, 'buddy').length !== 0) fail('停用后不该被选号逻辑取到')
    // 删除：账号与凭据一起清掉
    const del = await call('POST', '/api/cb/accounts', { accountId: list.body.accounts[0].id, action: 'delete' })
    if (!del.body.ok) fail('删除失败')
    if (readAccounts(home).length !== 0) fail('删除后账号池应为空')
    if (saved.size !== 0) fail('删除后凭据应一并清除，实际剩 ' + saved.size)

    // workbuddy 与未知 provider（回落 buddy）
    const wb = await call('POST', '/api/cb/login?provider=workbuddy')
    if (!wb.body.ok) fail('workbuddy 起登录失败: ' + JSON.stringify(wb.body))
    const un = await call('POST', '/api/cb/login?provider=nope')
    if (!un.body.ok) fail('未知 provider 应回落 buddy: ' + JSON.stringify(un.body))
    // 未知 accountId 轮询应明确告知重开
    const ghost = await call('GET', '/api/cb/login?accountId=nope')
    if (ghost.body.status !== 'unknown') fail('未知会话应报 unknown: ' + JSON.stringify(ghost.body))
    if (tokenTries < 1) fail('未真正发起 token 轮询')
  } finally {
    globalThis.fetch = realFetch
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ---- 8. 没有 credentials 服务时，/api/cb 路由仍须注册（回归闸门）----
//
// 曾经的写法是 root.inject(['webServer','credentials'], …)。只要组合里没有
// credentials 服务（精简组合、凭据服务未就绪、装载顺序），那个回调就不执行，
// 于是整组 /api/cb 路由一起失踪——连**完全不需要凭据**的 /models 也没了。
// 症状极像别的问题：设置区能打开、版本号正常（走 /api/codebuddy），
// 但模型清单固定报错。这条测试把这个耦合钉死。
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-nocred-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const routes = []
  let route = null
  const fake = {
    logger: { info: () => {}, warn: () => {} },
    llm: { registerAdapter() { return { dispose() {} } }, registerConfigurableProviders() {} },
    // 关键：**故意不提供 credentials**
    attachments: { async readImageRequest() { throw new Error('no image') } },
    webServer: { register(r) { routes.push(r); if (r.path === '/api/cb') route = r; return () => {} } },
    inject(deps, cb) {
      // 模拟真实注入语义：缺任一 required 依赖就**不执行**回调。
      const missing = deps.filter((d) => !(d in fake))
      if (missing.length === 0) cb(fake)
      return () => {}
    },
  }
  try {
    apply(fake, { dshHome: home, autoOpenBrowser: false })
    if (!route) fail('/api/cb 在缺少 credentials 时未注册（路由被凭据依赖拖死）: ' + routes.map((r) => r.path).join(','))
    if (!routes.some((r) => r.path === '/api/codebuddy')) fail('更新路由应在（只依赖 webServer）')
    // /models 不碰凭据，缺 credentials 也必须能应答
    if (route) {
      const res = {
        statusCode: 0,
        headers: {},
        body: '',
        writeHead(code, h) { this.statusCode = code; Object.assign(this.headers, h || {}); return this },
        end(chunk) { this.body = String(chunk || '') },
      }
      await route.handler({ url: '/api/cb/models', method: 'GET', headers: {} }, res)
      let body = null
      try { body = JSON.parse(res.body) } catch { /* 非 JSON */ }
      if (!body || body.ok !== true) fail('/models 在缺 credentials 时应成功: ' + res.statusCode + ' ' + res.body.slice(0, 160))
      if (!Array.isArray(body.models) || body.models.length === 0) fail('/models 应返回非空清单')
    }
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
