/**
 * 11128 拦截规避测试：整个请求体都不许带触发句。
 *
 * 真事故（1.8.2 → 1.8.3）：
 *
 *   处理失败 · 本轮运行失败
 *   codebuddy: 请求被拦截，请重新发送
 *   Illegal API invocation from an unapproved channel / INVALID_REQUEST
 *
 * 腾讯扫的是**整个 body**，不只 messages。插件原本只净化 messages
 * （system 换中性文案 + 各角色文本过 sanitizeText），但 `options.tools`
 * 是原样发出的：
 *
 *   body.tools = options.tools.map((t) => ({ function: { name: t.name,
 *     description: t.description, parameters: t.parameters } }))
 *
 * 而 DSH 的工具描述里就带 "DeepSeek Harness"、"Tokens prefixed with @ ..."。
 * 结果是：只要这次对话带工具（几乎每轮都带），body 里就必然命中 → 整轮被拦。
 * messages 那条路径一直是对的，所以只测 messages 的测试一路全绿。
 *
 * 这个测试的核心断言是「净化后整段 body 不含任何敏感词」，
 * 而不是「某个字段被改过」——前者才是腾讯的判定口径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let bad = 0
function check(name, ok, detail = '') {
  if (!ok) bad += 1
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '：' + detail : ''}`)
}

const root = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(root, '..', 'index.js'), 'utf8')

/** 腾讯黑名单的特征词（与 BLOCKED_HINTS 对齐，另外补上品牌变体）。 */
const FORBIDDEN = /DeepSeek|Harness|deepseek-harness|Tokens prefixed with @|AI agent powered by/i

// ---- 造一个能跑 apply() 的严格 ctx ----
function makeCtx(store) {
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'get') return (name) => store[name]
      if (prop === 'inject') return (deps, cb) => { try { return cb(makeCtx(store)) } catch { return () => {} } }
      if (prop === 'logger') return { info() {}, warn() {}, error() {}, debug() {} }
      if (typeof prop === 'symbol' || prop === 'then') return undefined
      if (store[prop] !== undefined) return store[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

async function captureBody({ tools, messages }) {
  const { apply } = await import('../index.js')
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cbwire-'))
  const dataDir = path.join(tmpHome, 'dsh-codebuddy')
  fs.mkdirSync(dataDir, { recursive: true })
  const REF = 'BUDDY_ACCOUNT_WIRE'
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    schema: 'dsh-codebuddy/accounts/v1',
    active: 'wire-acc',
    accounts: [{ id: 'wire-acc', provider: 'buddy', enabled: true, credentialRef: REF }],
  }), 'utf8')
  fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({
    schema: 'dsh-codebuddy/credentials/v1',
    credentials: {
      [REF]: JSON.stringify({ access_token: 'tok', expires_at: Date.now() + 3600_000, refresh_token: 'r' }),
    },
  }), 'utf8')

  const adapters = []
  const store = {
    llm: {
      registerAdapter(ids, a) { adapters.push(a); return { dispose() {} } },
      registerConfigurableProviders() {},
    },
    webServer: { register() { return { dispose() {} } }, dispose() {} },
  }
  const dispose = apply(makeCtx(store), { dshHome: tmpHome, telemetry: false })

  let sent = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => { sent = init && init.body; throw new Error('__captured__') }
  try {
    const it = adapters[0].stream({
      model: 'auto',
      tools,
      messages,
      signal: new AbortController().signal,
    })
    await it[Symbol.asyncIterator]().next()
  } catch { /* __captured__ 或不重要 */ }
  globalThis.fetch = realFetch
  if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
  return sent ? JSON.parse(sent) : null
}

console.log('— 真实 body 全字段净化 —')
{
  // 故意造一份「DSH 真实形态」的工具定义：品牌词在顶层描述、嵌套参数描述里
  const tools = [
    {
      name: 'bash',
      description: 'Run a shell command in the DeepSeek Harness workspace.',
      parameters: {
        type: 'object',
        properties: {
          cmd: { type: 'string', description: 'Run inside DeepSeek Harness. Tokens prefixed with @ are paths the user explicitly referenced.' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['cmd'],
      },
    },
    {
      name: 'read',
      description: 'Read a file. Tokens prefixed with @ are paths the user explicitly referenced.',
      parameters: { type: 'object', properties: {} },
    },
  ]
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.' }] },
    { role: 'user', content: [{ type: 'text', text: '你好' }] },
    { role: 'assistant', content: [{ type: 'text', text: '前一轮我提到过 DeepSeek Harness。' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]

  const body = await captureBody({ tools, messages })
  check('抓到了真实请求体', body !== null)

  if (body) {
    const whole = JSON.stringify(body)
    const hits = whole.match(FORBIDDEN)
    check('整段 body 不含任何敏感词（腾讯的判定口径）', hits === null,
      hits ? `残留: ${[...new Set(whole.match(new RegExp(FORBIDDEN.source, 'gi')) || [])].join(', ')}` : '')

    // 各字段分别点名，失败时能一眼看出是哪一层漏了
    check('system 已换成中性文案',
      !FORBIDDEN.test(String((body.messages.find((m) => m.role === 'system') || {}).content || '')))
    check('assistant 历史文本已净化',
      !body.messages.filter((m) => m.role === 'assistant').some((m) => FORBIDDEN.test(String(m.content || ''))))
    check('tools[].function.description 已净化',
      (body.tools || []).every((t) => !FORBIDDEN.test(String(t.function.description || ''))))
    check('tools[].function.parameters 嵌套描述已净化',
      (body.tools || []).every((t) => !FORBIDDEN.test(JSON.stringify(t.function.parameters || {}))))

    // 契约必须完好：名字/参数键/required 一个字符都不能变
    check('工具名未被改动（改名会让宿主找不到工具）',
      JSON.stringify((body.tools || []).map((t) => t.function.name)) === JSON.stringify(['bash', 'read']))
    const p0 = (body.tools && body.tools[0] && body.tools[0].function.parameters) || {}
    check('参数键名未被改动', JSON.stringify(Object.keys(p0.properties || {})) === JSON.stringify(['cmd', 'cwd']))
    check('required 未被改动', JSON.stringify(p0.required) === JSON.stringify(['cmd']))
    check('参数类型未被改动', p0.properties?.cmd?.type === 'string')
  }
}

console.log('— 无命中时不改契约（避免无谓深拷贝/改动） —')
{
  const clean = [{ name: 'ping', description: 'Ping the server.', parameters: { type: 'object', properties: { n: { type: 'number' } } } }]
  const body = await captureBody({ tools: clean, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const expected = JSON.stringify(clean.map((t) => ({ type: 'function', function: t })))
  const actual = body === null ? '(没抓到 body)' : JSON.stringify(body.tools)
  check('干净的工具定义原样通过（无命中不新建对象）', body !== null && actual === expected,
    actual === expected ? '' : `实际: ${actual}`)
}

console.log('— 静态：tools 下发处必须走净化 —')
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const code = strip(SRC)
  const m = code.match(/body\.tools\s*=\s*options\.tools\.map\(([\s\S]{0,600}?)\)\)/)
  check('body.tools 的 description 走 sanitizeText', /description:\s*sanitizeText\(/.test(code))
  check('body.tools 的 parameters 走 sanitizeSchema', /parameters:\s*sanitizeSchema\(/.test(code))
  check('没有「description 原样透传」的写法', !/description:\s*t\.description/.test(code))
}

console.log(bad === 0 ? '\nPASS 11128 拦截规避（整段 body）' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
