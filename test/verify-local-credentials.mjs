/**
 * 回归测试：**组合里没有 credentials 服务**时，登录后的账号必须仍然可用。
 *
 * 这是对方机器上报的故障：浏览器授权走完、界面显示「完成」，但账号列表
 * 永远为空，日志里是「当前组合没有 credentials 服务，无法保存凭据」。
 * 根因是插件把凭据保存完全托付给 DSH 的 credentials 服务。
 *
 * 这里用一个**根本没有 credentials 服务**的假 ctx 复现那种组合：
 *   - 凭据应当落进插件自己的库
 *   - /api/cb/accounts 应当列出账号且 hasCredential 为 true
 *   - 删除账号应当连带清掉本地凭据
 *   - 全程不得抛错、不得出现旧的那句报错
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_local-credentials.txt'
const lines = []
const log = (s) => lines.push(String(s))
let bad = 0
const ok = (m) => log('  ok ' + m)
const fail = (m) => { bad++; log('  FAIL ' + m) }

// ─── 1. credential-store 单元行为 ───
{
  const {
    readLocalCredential, writeLocalCredential, deleteLocalCredential,
    hasLocalCredential, listLocalCredentialRefs,
  } = await import('../src/credential-store.js')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cs-'))
  try {
    // 空库
    if (readLocalCredential(home, 'A') !== null) fail('空库应返回 null')
    if (hasLocalCredential(home, 'A')) fail('空库 has 应为 false')

    const v1 = JSON.stringify({ access_token: 'tok-1', refresh_token: 'ref-1' })
    writeLocalCredential(home, 'BUDDY_ACCOUNT_AAAA', v1)
    if (readLocalCredential(home, 'BUDDY_ACCOUNT_AAAA') !== v1) fail('写入后应能原样读回')
    if (!hasLocalCredential(home, 'BUDDY_ACCOUNT_AAAA')) fail('写入后 has 应为 true')

    // 多 ref 互不影响
    const v2 = JSON.stringify({ access_token: 'tok-2' })
    writeLocalCredential(home, 'WORKBUDDY_ACCOUNT_BBBB', v2)
    if (readLocalCredential(home, 'BUDDY_ACCOUNT_AAAA') !== v1) fail('写第二个 ref 不应覆盖第一个')
    if (listLocalCredentialRefs(home).length !== 2) fail('应列出 2 个 ref')

    // 覆盖
    const v3 = JSON.stringify({ access_token: 'tok-3' })
    writeLocalCredential(home, 'BUDDY_ACCOUNT_AAAA', v3)
    if (readLocalCredential(home, 'BUDDY_ACCOUNT_AAAA') !== v3) fail('同 ref 应覆盖为新值')

    // Unix 权限必须是 0600
    if (process.platform !== 'win32') {
      const mode = fs.statSync(path.join(home, 'dsh-codebuddy', 'credentials.json')).mode & 0o777
      if (mode !== 0o600) fail('凭据文件权限应为 600，实际 ' + mode.toString(8))
    }

    // 删除
    deleteLocalCredential(home, 'BUDDY_ACCOUNT_AAAA')
    if (readLocalCredential(home, 'BUDDY_ACCOUNT_AAAA') !== null) fail('删除后应为 null')
    if (readLocalCredential(home, 'WORKBUDDY_ACCOUNT_BBBB') !== v2) fail('删一个不应影响另一个')
    deleteLocalCredential(home, '不存在的ref') // 不应抛
    ok('credential-store：读写/覆盖/隔离/删除/权限')

    // 损坏文件当空库，不抛
    fs.writeFileSync(path.join(home, 'dsh-codebuddy', 'credentials.json'), '{坏掉的', 'utf8')
    if (readLocalCredential(home, 'X') !== null) fail('损坏文件应返回 null')
    ok('credential-store：损坏文件降级为空库')

    // 非法参数
    let threw = false
    try { writeLocalCredential(home, '', 'x') } catch { threw = true }
    if (!threw) fail('空 ref 应抛错')
    ok('credential-store：非法入参拒绝')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ─── 2. 没有 credentials 服务的组合下，路由仍能列出账号 ───
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-nocred-'))
  const REF = 'BUDDY_ACCOUNT_NOCRED1'
  try {
    fs.mkdirSync(path.join(tmpHome, 'dsh-codebuddy'), { recursive: true })
    fs.writeFileSync(path.join(tmpHome, 'dsh-codebuddy', 'accounts.json'), JSON.stringify({
      schema: 'dsh-codebuddy/accounts/v1',
      accounts: [{
        id: 'buddy-nocred', provider: 'buddy', nickname: '无服务机器',
        credentialRef: REF, enabled: true, refreshable: true,
        createdAt: 1, updatedAt: 1, expiresAt: 0,
      }],
    }, null, 2), 'utf8')

    // 凭据只存在于插件自己的库，服务完全没有
    const { writeLocalCredential } = await import('../src/credential-store.js')
    writeLocalCredential(tmpHome, REF, JSON.stringify({
      access_token: 'local-token', refresh_token: 'local-refresh',
      expires_at: String(Date.now() + 3600_000),
    }))

    const { apply } = await import('../index.js')
    const registrations = []
    const fakeServer = { register(spec) { registrations.push(spec); return () => {} } }

    // 关键：ctx 里【没有】credentials，get() 也返回 null
    const root = {
      logger: { info: (m) => lines.push('[info] ' + m), warn: (m) => lines.push('[warn] ' + m), error: (m) => lines.push('[error] ' + m) },
      inject(deps, cb) {
        cb({
          webServer: fakeServer,
          logger: root.logger,
          get(name) { return name === 'webServer' ? fakeServer : null },
        })
      },
    }

    const cleanup = apply(root, { dshHome: tmpHome, autoUpdate: false, telemetry: false })

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
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${port}` + p)
      return { status: r.status, body: await r.json().catch(() => null) }
    }

    // 账号列表：必须列出，且 hasCredential 必须是 true（凭据在我们自己的库里）
    const list = await get('/api/cb/accounts')
    if (list.status !== 200 || !list.body || !list.body.ok) fail('/accounts 应 200 且 ok')
    const rows = (list.body && list.body.accounts) || []
    if (rows.length !== 1) fail('应列出 1 个账号，实际 ' + rows.length)
    if (rows[0] && rows[0].hasCredential !== true) {
      fail('没有 credentials 服务时 hasCredential 仍应为 true（凭据在本地库），实际 ' + (rows[0] && rows[0].hasCredential))
    }
    ok('无 credentials 服务：账号可见且 hasCredential=true')

    // 删除账号要连带清掉本地凭据
    const del = await fetch(`http://127.0.0.1:${port}/api/cb/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: 'buddy-nocred', action: 'delete' }),
    })
    const delBody = await del.json().catch(() => null)
    if (!delBody || !delBody.ok) fail('删除账号应成功，实际 ' + JSON.stringify(delBody))

    const { readLocalCredential } = await import('../src/credential-store.js')
    if (readLocalCredential(tmpHome, REF) !== null) fail('删除账号后本地凭据应一并清除')
    ok('删账号连带清除本地凭据')

    // 旧的那句报错不该再出现
    const all = lines.join('\n')
    if (all.includes('无法保存凭据')) fail('不应再出现「无法保存凭据」')

    await new Promise((r) => server.close(r))
    if (typeof cleanup === 'function') cleanup()
  } finally { fs.rmSync(tmpHome, { recursive: true, force: true }) }
}

// ─── 3. 静态断言：保存凭据的路径不再以服务为前置条件 ───
{
  const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  if (src.includes('无法保存凭据')) fail('index.js 里仍有「无法保存凭据」的硬失败分支')
  if (!src.includes('writeLocalCredential')) fail('index.js 应使用自带凭据库')
  if (!src.includes("from './src/credential-store.js'")) fail('index.js 应导入 credential-store')
  // 保存凭据后必须紧接着登记账号，不能因为服务缺失跳过
  const m = src.match(/await saveCredValue\(rec\.credentialRef[\s\S]{0,120}?addAccount\(/)
  if (!m) fail('finishLogin 应无条件保存凭据并登记账号')
  ok('index.js：保存凭据不再依赖 credentials 服务')
}

fs.writeFileSync(OUT, lines.join('\n') + '\n', 'utf8')
if (bad) { console.error(lines.join('\n')); process.exit(1) }
console.log('PASS local-credentials (works with no credentials service)')
