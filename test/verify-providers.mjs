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
function boot({ config = {}, models = REMOTE_MODELS } = {}) {
  const adapters = new Map()
  const configurable = []
  const credential = { access_token: 'tok', user_id: 'uid', refresh_token: 'r' }

  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/v3/config')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { models } }) }
    }
    return { ok: false, status: 404, text: async () => '{}' }
  }

  const scoped = {
    credentials: {
      async resolve() { return { value: JSON.stringify(credential) } },
      async set() {}, async unset() {},
    },
    attachments: null,
    // 插件在安装末尾会 `ctx.inject(['webServer'], …)` 挂自检路由；
    // 桩里必须提供 inject 与 webServer，否则 install 直接抛错。
    webServer: { register() { return () => {} } },
    inject(_deps, cb) { cb(scoped) },
    get(name) { return name === 'webServer' ? scoped.webServer : null },
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

  const dispose = apply(root, { autoUpdate: false, ...config })
  return { adapters, configurable, dispose, root }
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
  check('模型数量 5', models.length === 5, String(models.length))
  check('hy4flash 保持原名', byId.get('hy4flash')?.name === 'Hy4 flash', byId.get('hy4flash')?.name)
  check('hy4flash-free 加了 (free)', byId.get('hy4flash-free')?.name === 'Hy4 flash (free)',
    byId.get('hy4flash-free')?.name)
  const names = models.map((m) => m.name)
  check('所有模型名两两不同', new Set(names).size === names.length, names.join(' | '))
  check('id 全部保留原值（没被改名）', models.every((m) => REMOTE_MODELS.some((r) => r.id === m.id)),
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
  const names = models.map((m) => m.name)
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

let bad = 0
for (const { name, ok } of results) {
  if (!ok) bad += 1
  console.log((ok ? 'OK   ' : 'FAIL ') + name)
}
console.log(bad === 0 ? `\n渠道展示 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
