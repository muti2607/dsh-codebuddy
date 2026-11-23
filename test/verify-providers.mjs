/**
 * 渠道展示检查：分组不重复、模型名不歧义。
 *
 * 两个真机上出现过的问题：
 *   ① 模型选择器里出现**两个都叫「CodeBuddy (腾讯免费)」的分组**——因为默认
 *      注册了 `buddy` 别名，而 providerInfo 对所有 provider 回同一个名字。
 *   ② 同一分组里两行都叫「Hy4 flash」——远端目录里 `hy4flash` 与
 *      `hy4flash-free` 的 name 完全相同。
 *
 * 这里用桩 llm 服务跑真实 apply()，断言注册出来的 provider 名与模型名。
 */
import { apply } from '../index.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeModelPrefs, readModelPrefs } from '../src/model-prefs.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  if (!ok && detail !== undefined) console.log('   detail: ' + detail)
}

// 远端目录（真实抓到的 name 冲突原样保留）
const REMOTE_MODELS = [
  { id: 'auto', name: 'Auto', supportsToolCall: true, maxInputTokens: 240000, maxOutputTokens: 32000 },
  { id: 'hy4std', name: 'Hy4', supportsToolCall: true, maxInputTokens: 240000, maxOutputTokens: 32000 },
  { id: 'hy4flash', name: 'Hy4 flash', supportsToolCall: true, maxInputTokens: 240000, maxOutputTokens: 32000 },
  { id: 'hy4flash-free', name: 'Hy4 flash', supportsToolCall: true, maxInputTokens: 240000, maxOutputTokens: 32000 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', supportsToolCall: true, maxInputTokens: 240000, maxOutputTokens: 32000 },
]

/** 桩宿主：记录 registerAdapter / registerConfigurableProviders，并允许调 listModels。 */
const homes = []
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prov-'))
  homes.push(dir)
  // 账号池要有一项，凭据链才会走到「取远端目录」
  fs.mkdirSync(path.join(dir, 'dsh-codebuddy'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dsh-codebuddy', 'accounts.json'), JSON.stringify({
    schema: 'dsh-codebuddy/accounts/v1',
    accounts: [{
      id: 'acc-1', provider: 'buddy', nickname: 't',
      credentialRef: 'BUDDY_ACCOUNT_TEST', enabled: true, refreshable: true,
      createdAt: 1, updatedAt: 1, expiresAt: 0,
    }],
  }, null, 2), 'utf8')
  return dir
}

function boot({ config = {}, models = REMOTE_MODELS } = {}) {
  const adapters = new Map()
  const configurable = []
  const credential = { access_token: 'tok', user_id: 'uid', refresh_token: 'r' }
  const home = makeHome()

  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/v3/config')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { models } }) }
    }
    return { ok: false, status: 404, text: async () => '{}' }
  }

  // webServer 桩：把路由规格收集起来，供测试直接调用 handler
  const routes = []
  const server = {
    register(spec) { routes.push(spec); return () => {} },
  }

  const scoped = {
    credentials: {
      async resolve() { return { value: JSON.stringify(credential) } },
      async set() {}, async unset() {},
    },
    attachments: null,
    // 插件在安装末尾会 `ctx.inject(['webServer'], …)` 挂自检路由；
    // 桩里必须提供 inject 与 webServer，否则 install 直接抛错。
    webServer: server,
    inject(_deps, cb) { cb(scoped) },
    get(name) { return name === 'webServer' ? server : null },
    llm: {
      registerAdapter(providers, adapter) {
        for (const p of providers) adapters.set(p, adapter)
        return { dispose() {} }
      },
      registerConfigurableProviders(list) { configurable.push(...list) },
      async listProviders() { return [...adapters.keys()] },
    },
  }

  const root = {
    logger: { info() {}, warn() {}, error() {} },
    inject(_deps, cb) { cb(scoped) },
  }

  const dispose = apply(root, { telemetry: false, autoUpdate: false, dshHome: home, ...config })

  /** 直接调某个前缀路由的 handler，绕过 HTTP 栈。 */
  async function call(pathname, method = 'GET', payload) {
    const spec = routes.find((r) => pathname.startsWith(r.path))
    if (!spec) throw new Error('没有匹配的路由: ' + pathname)
    const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
    const req = {
      url: pathname,
      method,
      async *[Symbol.asyncIterator]() { for (const chunk of body) yield chunk },
    }
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code },
      end(chunk) { text = String(chunk || '') },
    }
    await spec.handler(req, res)
    let parsed = {}
    try { parsed = JSON.parse(text || '{}') } catch { parsed = { raw: text } }
    return { status, body: parsed }
  }

  return { adapters, configurable, dispose, root, home, call, routes }
}

// ─────────────────────────────────────────────────────────────

// 1) 默认配置：只能注册一个渠道
{
  const { adapters, configurable } = boot()
  const names = [...adapters.keys()]
  check('默认只注册 1 个 provider', names.length === 1, names.join(','))
  check('默认 provider 是 codebuddy', names[0] === 'codebuddy', names[0])
  check('默认不注册 buddy 别名', !names.includes('buddy'), names.join(','))
  check('registerConfigurableProviders 只有 1 条', configurable.length === 1, String(configurable.length))
  check('可配置条目 provider=codebuddy', configurable[0]?.provider === 'codebuddy', configurable[0]?.provider)
}

// 2) 主渠道显示名
{
  const { adapters } = boot()
  const adapter = adapters.get('codebuddy')
  const info = adapter.providerInfo('codebuddy')
  check('主渠道名字是「CodeBuddy (腾讯免费)」', info.name === 'CodeBuddy (腾讯免费)', info.name)
  check('主渠道 id 正确', info.id === 'codebuddy', info.id)
}

// 3) 显式配置别名时，两个渠道名必须不同
{
  const { adapters } = boot({ config: { aliases: ['buddy'] } })
  const names = [...adapters.keys()]
  check('配置 aliases 后注册 2 个 provider', names.length === 2, names.join(','))
  const a = adapters.get('codebuddy').providerInfo('codebuddy')
  const b = adapters.get('buddy').providerInfo('buddy')
  check('主渠道与别名显示名不同', a.name !== b.name, a.name + ' vs ' + b.name)
  check('别名名字带后缀标注', b.name.includes('buddy'), b.name)
}

// 4) 模型名消除歧义
{
  const { adapters } = boot()
  const adapter = adapters.get('codebuddy')
  const models = await adapter.listModels('codebuddy')
  const byId = new Map(models.map((m) => [m.id, m]))
  // 远端 5 条 + 兜底表里远端没有的那些（legacy）
  const remoteIds = REMOTE_MODELS.map((r) => r.id)
  check('远端模型全都在列表里', remoteIds.every((id) => byId.has(id)), remoteIds.join(','))
  check('列表不少于远端条数', models.length >= REMOTE_MODELS.length, String(models.length))
  check('hy4flash 保持原名', byId.get('hy4flash')?.name === 'Hy4 flash', byId.get('hy4flash')?.name)
  check('hy4flash-free 加了 (free)', byId.get('hy4flash-free')?.name === 'Hy4 flash (free)',
    byId.get('hy4flash-free')?.name)
  const names = models.map((m) => m.name)
  check('所有模型名两两不同', new Set(names).size === names.length, names.join(' | '))
  check('远端 id 全部保留原值（没被改名）',
    models.filter((m) => remoteIds.includes(m.id)).length === REMOTE_MODELS.length,
    models.map((m) => m.id).join(','))
}

// 5) resolveModel 用的是消歧后的名字
{
  const { adapters } = boot()
  const adapter = adapters.get('codebuddy')
  const resolved = await adapter.resolveModel('codebuddy', 'hy4flash-free')
  check('resolveModel 名字带 (free)', resolved.name === 'Hy4 flash (free)', resolved.name)
  check('resolveModel id 不变', resolved.id === 'hy4flash-free', resolved.id)
}

// 6) 不重名时不吃掉原名
{
  const { adapters } = boot({ models: [{ id: 'glm-5.3', name: 'GLM-5.3', supportsToolCall: true }] })
  const models = await adapters.get('codebuddy').listModels('codebuddy')
  check('唯一名字保持原样', models[0].name === 'GLM-5.3', models[0].name)
}

// 7) 三个同名时的后缀（第二个已有 free，第三个回落 id）
{
  const { adapters } = boot({
    models: [
      { id: 'x-main', name: 'X', supportsToolCall: true },
      { id: 'x-free', name: 'X', supportsToolCall: true },
      { id: 'x-other', name: 'X', supportsToolCall: true },
    ],
  })
  const models = await adapters.get('codebuddy').listModels('codebuddy')
  // 只看这三条（legacy 补位会把兜底表里其余的也带进来）
  const xs = models.filter((m) => ['x-main', 'x-free', 'x-other'].includes(m.id))
  const names = xs.map((m) => m.name)
  check('三同名：第一个保持 X', names[0] === 'X', names[0])
  check('三同名：第二个 X (free)', names[1] === 'X (free)', names[1])
  check('三同名：第三个回落 id', names[2] === 'X (x-other)', names[2])
  check('三同名仍然互不相同', new Set(names).size === 3, names.join(' | '))
}

// 8) 没有凭据时回落到内置兜底表，且兜底表名也不重复
{
  const { adapters, root } = boot()
  // 让凭据解析失败
  root.inject = undefined
  const adapter = adapters.get('codebuddy')
  // 直接把 fetch 打成 401，模拟无凭据可用
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{}' })
  const models = await adapter.listModels('codebuddy')
  check('无远端时用兜底表', models.length > 0, String(models.length))
  const names = models.map((m) => m.name)
  check('兜底模型名两两不同', new Set(names).size === names.length, names.join(' | '))
}

// 9) 模型启用/停用：关掉的从 listModels 消失，但已有会话仍能解析
{
  const { adapters, home } = boot()
  const adapter = adapters.get('codebuddy')

  const before = await adapter.listModels('codebuddy')
  check('初始全部模型可见', before.length >= REMOTE_MODELS.length, String(before.length))

  writeModelPrefs(home, { disabled: ['hy4flash-free'] })
  const after = await adapter.listModels('codebuddy')
  check('停用后少一个', after.length === before.length - 1, String(after.length))
  check('停用的模型不在列表里', !after.some((m) => m.id === 'hy4flash-free'),
    after.map((m) => m.id).join(','))

  // 关键：停用只影响「选择器」，不该让已经在用这个模型的会话突然报错
  const resolved = await adapter.resolveModel('codebuddy', 'hy4flash-free')
  check('已停用的模型仍可解析（老会话不炸）', resolved.id === 'hy4flash-free' && resolved.name === 'Hy4 flash (free)',
    resolved.name)
  check('已停用的模型仍带上下文窗口', resolved.context && resolved.context.contextWindow > 0)

  // 立即生效：不需要等目录缓存过期
  writeModelPrefs(home, { disabled: [] })
  const restored = await adapter.listModels('codebuddy')
  check('重新启用后立刻回来', restored.length === before.length, String(restored.length))

  // 全部停用（含补进来的 legacy）→ 空清单（界面据此提示）
  writeModelPrefs(home, { disabled: before.map((m) => m.id) })
  const none = await adapter.listModels('codebuddy')
  check('全部停用时列表为空', none.length === 0, String(none.length))
}

// 10) 偏好文件损坏不应该让模型列表消失
{
  const { adapters, home } = boot()
  fs.writeFileSync(path.join(home, 'dsh-codebuddy', 'models.json'), '{ broken', 'utf8')
  const models = await adapters.get('codebuddy').listModels('codebuddy')
  check('偏好损坏时仍返回完整列表', models.length >= REMOTE_MODELS.length, String(models.length))
  check('损坏的偏好被读成空', readModelPrefs(home).disabled.length === 0)
}

// 11) 路由：/api/cb/models 的读与写
{
  const { call, home } = boot()

  const list = await call('/api/cb/models')
  // 注意：目录里会额外补上「远端已撤但接口仍认」的模型（见用例 12/13），
  // 所以这里以接口返回的 total 为准，不硬编码条数。
  const total = list.body.total
  check('GET /models 返回 200', list.status === 200, list.status)
  check('GET /models ok=true', list.body.ok === true)
  check('GET /models total 与列表一致', total === (list.body.models || []).length, total)
  check('GET /models 至少包含远端那几条', total >= REMOTE_MODELS.length, total)
  check('GET /models 初始全启用', list.body.enabledCount === total, list.body.enabledCount)
  check('GET /models 带每项 enabled', (list.body.models || []).every((m) => typeof m.enabled === 'boolean'))
  check('GET /models 带名字', (list.body.models || []).every((m) => typeof m.name === 'string' && m.name.length > 0))
  check('初始 allDisabled=false', list.body.allDisabled === false)

  const off = await call('/api/cb/models', 'POST', { modelId: 'hy4flash-free', enabled: false })
  check('POST 停用返回 200', off.status === 200, off.status)
  check('POST 停用 ok=true', off.body.ok === true)
  check('停用写进了偏好文件', readModelPrefs(home).disabled.includes('hy4flash-free'),
    JSON.stringify(readModelPrefs(home).disabled))

  const after = await call('/api/cb/models')
  check('停用后计数减一', after.body.enabledCount === total - 1, after.body.enabledCount)
  const target = (after.body.models || []).find((m) => m.id === 'hy4flash-free')
  check('停用项标记为 false', target && target.enabled === false, JSON.stringify(target))

  const on = await call('/api/cb/models', 'POST', { modelId: 'hy4flash-free', enabled: true })
  check('POST 启用 ok=true', on.body.ok === true)
  check('启用后偏好清空该 id', !readModelPrefs(home).disabled.includes('hy4flash-free'))

  // 全部停用 → allDisabled 标记（界面据此给提示）
  // 必须遍历接口返回的全部模型，否则补进来的 legacy 模型仍启用，allDisabled 永远为 false
  for (const m of (list.body.models || [])) {
    await call('/api/cb/models', 'POST', { modelId: m.id, enabled: false })
  }
  const none = await call('/api/cb/models')
  check('全部停用时 allDisabled=true', none.body.allDisabled === true, none.body.enabledCount)
  check('全部停用时 enabledCount=0', none.body.enabledCount === 0)

  const all = await call('/api/cb/models', 'POST', { action: 'enableAll' })
  check('enableAll 返回 ok', all.body.ok === true)
  const restored = await call('/api/cb/models')
  check('enableAll 后全部恢复', restored.body.enabledCount === total, restored.body.enabledCount)

  const badReq = await call('/api/cb/models', 'POST', {})
  check('缺 modelId 时 ok=false', badReq.body.ok === false, JSON.stringify(badReq.body))

  const wrongMethod = await call('/api/cb/models', 'PUT')
  check('PUT 返回 405', wrongMethod.status === 405, wrongMethod.status)

  const unknown = await call('/api/cb/whatever')
  check('未知路径仍是 404', unknown.status === 404, unknown.status)
}

// 12) 远端目录撤掉的模型（hy3 / hy3-x）必须用兜底表补回来
//
// 实测（2026-11-22）：腾讯把 hy3 从 /v3/config 撤了，但 chat 接口仍返回 200。
// 早先插件完全照抄远端目录，于是这些模型凭空消失——用户看到就是「hy3 没了」。
{
  // REMOTE_MODELS 里本来就没有 hy3/hy3-x，正好复现「目录已撤」
  const { adapters, call } = boot()
  const models = await adapters.get('codebuddy').listModels('codebuddy')
  const ids = models.map((m) => m.id)
  check('补回了 hy3', ids.includes('hy3'), ids.join(','))
  check('补回了 hy3-x', ids.includes('hy3-x'))
  check('补回的模型排在远端之后', ids.indexOf('hy3') > ids.indexOf('deepseek-v4.1-flash'), ids.join(','))
  check('远端原有的仍在最前', ids[0] === 'auto', ids[0])
  const named = models.find((m) => m.id === 'hy3')
  check('补回的模型带名字', named && named.name !== 'hy3', named && named.name)

  const detail = await call('/api/cb/models')
  const hy3 = (detail.body.models || []).find((m) => m.id === 'hy3')
  check('接口把 hy3 标成 legacy', hy3 && hy3.legacy === true, JSON.stringify(hy3))
  check('补回的模型默认启用', hy3 && hy3.enabled === true)
  const auto = (detail.body.models || []).find((m) => m.id === 'auto')
  check('远端原模型不带 legacy', auto && auto.legacy === false, JSON.stringify(auto))

  await call('/api/cb/models', 'POST', { modelId: 'hy3', enabled: false })
  const after = await adapters.get('codebuddy').listModels('codebuddy')
  check('补回的模型可以被停用', !after.some((m) => m.id === 'hy3'))
}

// 13) 远端完全拿不到时，仍用完整兜底表（含 hy3）
{
  const { adapters } = boot()
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{}' })
  const models = await adapters.get('codebuddy').listModels('codebuddy')
  check('无远端时含 hy3', models.some((m) => m.id === 'hy3'), String(models.length))
}

for (const dir of homes) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ---- 静态检查：用到了却没从 src/heartbeat.js 导入的导出 ----
// 教训：1.7.0 加了 DEFAULT_INTERVAL_MS 的使用却忘了导入，/telemetry 整条接口
// 直接 500。动态测试没覆盖那个字段，所以 20 组测试全绿也没发现。
{
  // 不能用 new URL(import.meta.url).pathname：路径含中文时会被百分号编码
  const root = path.dirname(fileURLToPath(import.meta.url))
  const raw = fs.readFileSync(path.join(root, '..', 'index.js'), 'utf8')
  const hb = fs.readFileSync(path.join(root, '..', 'src', 'heartbeat.js'), 'utf8')
  const m = raw.match(/import \{([^}]*)\} from '\.\/src\/heartbeat\.js'/)
  const imported = m ? m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()) : []
  // 剔掉 import 语句本身再找"使用"，否则 `readState as readTelemetryState`
  // 会被当成"用了 readState 却没导入"，误报。
  const body = raw.replace(/import \{[^}]*\} from '\.\/src\/heartbeat\.js'/, '')
  const exported = [...hb.matchAll(/export (?:const|function|class) (\w+)/g)].map((x) => x[1])
  const missing = exported.filter((e) => new RegExp('\\b' + e + '\\b').test(body) && !imported.includes(e))
  check('heartbeat.js 的导出无漏导（漏了会让整条路由 500）', missing.length === 0, missing.join(', '))
}

// ---- 静态检查：index.js 依赖的本地文件必须都在 package.json 的 files 白名单里 ----
// 教训：1.8.0 新增 src/pet-balance.js 并 import 了它，却忘了加进 files，
// npm pack 时整份文件被丢掉，装到用户机上就是 MODULE_NOT_FOUND。
// （本地开发永远发现不了，因为源码就在旁边。）
{
  const root = path.dirname(fileURLToPath(import.meta.url))
  const idx = fs.readFileSync(path.join(root, '..', 'index.js'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, '..', 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  // 只挑本包内的相对导入（./src/xxx.js 这种），外部包不管
  const localImports = [...idx.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1].replace(/^\.\//, ''))
  const notListed = localImports.filter((f) => {
    if (files.includes(f)) return false
    // 支持通配：src/*.js 之类
    return !files.some((pat) => {
      if (!pat.includes('*')) return false
      const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '$')
      return re.test(f)
    })
  })
  check('所有被 index.js 导入的本地文件都在 files 白名单（漏了会装不上）', notListed.length === 0, notListed.join(', '))
}

let bad = 0
for (const { name, ok } of results) {
  if (!ok) bad += 1
  console.log((ok ? 'OK   ' : 'FAIL ') + name)
}

console.log(bad === 0 ? `\n渠道展示 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
