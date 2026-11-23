/**
 * 针对「已安装副本」的真机检查：导入 profile 里的 dsh-codebuddy，
 * 用真实凭据 + 真实 /v3/config 拉一次模型清单，确认：
 *   · 只注册一个 provider
 *   · 模型名两两不同（Hy4 flash / Hy4 flash (free)）
 *
 * 和 verify-providers.mjs 的区别：那个用桩 fetch 测逻辑，这个测**装上去的那份文件**
 * 在真实远端数据下的行为——能抓到「开发目录改了但没打进包」这类问题。
 */
import fs from 'node:fs'
import path from 'node:path'

const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_live-providers.txt'
const INSTALLED = 'C:\\Users\\ming\\.dsh\\profiles\\desktop\\node_modules\\dsh-codebuddy\\index.js'
const YAML = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')

const lines = []
const log = (s) => lines.push(String(s))

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
const { apply } = await import('file:///' + INSTALLED.replace(/\\/g, '/'))

const adapters = new Map()
const scoped = {
  credentials: {
    async resolve() { return { value: JSON.stringify(cred) } },
    async set() {}, async unset() {},
  },
  attachments: null,
  webServer: { register() { return () => {} } },
  inject(_d, cb) { cb(scoped) },
  get(n) { return n === 'webServer' ? scoped.webServer : null },
  llm: {
    registerAdapter(providers, adapter) { for (const p of providers) adapters.set(p, adapter); return { dispose() {} } },
    registerConfigurableProviders() {},
    async listProviders() { return [...adapters.keys()] },
  },
}
const root = { logger: { info() {}, warn() {}, error() {} }, inject(_d, cb) { cb(scoped) } }
apply(root, { telemetry: false, autoUpdate: false })

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  log((ok ? 'OK   ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''))
}

const names = [...adapters.keys()]
check('已安装副本只注册 1 个 provider', names.length === 1, names.join(','))
check('provider 名为 codebuddy', names[0] === 'codebuddy', names[0])

const adapter = adapters.get('codebuddy')
const info = adapter.providerInfo('codebuddy')
check('分组显示名正确', info.name === 'CodeBuddy (腾讯免费)', info.name)

const models = await adapter.listModels('codebuddy')
log('')
log('真实远端模型清单（' + models.length + ' 个）：')
for (const m of models) log('  ' + m.id + '  →  ' + m.name)
log('')

const names2 = models.map((m) => m.name)
check('模型名两两不同', new Set(names2).size === names2.length)
const flash = models.filter((m) => m.name.startsWith('Hy4 flash'))
check('Hy4 flash 有两个且可区分', flash.length === 2 && flash[0].name !== flash[1].name,
  flash.map((m) => m.name).join(' | '))
check('hy4flash-free 显示为 (free)', models.some((m) => m.id === 'hy4flash-free' && m.name === 'Hy4 flash (free)'),
  (models.find((m) => m.id === 'hy4flash-free') || {}).name)

const bad = results.filter((r) => !r.ok).length
log('')
log(bad === 0 ? `已安装副本 ${results.length} 项全部通过` : `${bad}/${results.length} 项未通过`)
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
process.exit(bad ? 1 : 0)
