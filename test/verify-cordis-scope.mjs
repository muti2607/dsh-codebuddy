/**
 * cordis 作用域纪律测试：不许裸读未注入的服务。
 *
 * 真事故（1.8.1 → 1.8.2）：
 *
 *   处理失败 · 本轮运行失败
 *   cannot get property "attachments" without inject
 *
 * 起因是 resolveImageUrls 里写了 `if (!ctx.attachments || ...)`。
 * install() 那条 inject 只声明了 ['llm']，而 cordis 的 ctx 是**代理**：
 * 读一个没在 inject 里声明过的服务会直接抛错，而不是返回 undefined。
 * 那行在 try 之外，于是只要消息里带图片，整轮对话就失败。
 *
 * 关键点：这类错误单元测试抓不到（要真带图片走到那条路径），
 * 而本地跑通常不传图片，所以一路全绿到用户手上才炸。这条测试用一个
 * **严格代理**模拟真 cordis 行为：任何未在 inject 声明的属性一读就抛。
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

/**
 * 严格 ctx：未声明就抛，行为对齐真 cordis 代理。
 * declared 是 inject 里允许的集合。
 */
function strictCtx(declared, provided) {
  const allowed = new Set(declared)
  const store = provided || {}
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'get') {
        // 官方的机会式查找：缺失返回 undefined，绝不抛
        return (name) => store[name]
      }
      if (prop === 'inject') {
        return (deps, cb) => {
          const child = strictCtx(deps, store)
          try { return cb(child) } catch { return () => {} }
        }
      }
      if (prop === 'effect') return () => () => {}
      if (prop === 'logger' || prop === 'log') return { info() {}, warn() {}, error() {}, debug() {} }
      if (typeof prop === 'symbol') return undefined
      if (prop === 'then') return undefined
      if (allowed.has(prop)) return store[prop]
      // 真 cordis 在这里抛的就是这句话
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

// ---- 静态检查：裸读未注入服务的写法必须绝迹 ----
//
// 只查「读服务」形态，注释里提到名字不算。
//
// 允许一种写法：`try { x = ctx.attachments } catch { ... }` 这种**兜底**，
// 前提是它包在 try 里、且前面已经先用过 ctx.get（真运行时走的是 get）。
// 明令禁止的是「无条件裸读」和「裸读写在 || 前面」——那才是真事故。
console.log('— 静态：不许裸读未注入的服务 —')
{
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const code = strip(SRC)

  // 逐个找出裸读位置，判断它是否被 try 包住、且同一函数里先用了 ctx.get
  function bareReads(svc) {
    const out = []
    const re = new RegExp(`ctx\\.${svc}\\b`, 'g')
    let m
    while ((m = re.exec(code)) !== null) {
      const idx = m.index
      // 往前找最近的 try {，看这个位置是否在它的块内（粗略但够用：
      // 同一行或前面 200 字符内出现 try 且中间没有 }) 算"在 try 内"）
      const before = code.slice(Math.max(0, idx - 400), idx)
      const inTry = /try\s*\{[^{}]*$/.test(before) || /try\s*\{[\s\S]*$/.test(before.split('}').pop() ? before.split('}').pop() : '')
      // 同一函数里是否用过 ctx.get 取同一个服务
      const fnStart = Math.max(0, before.lastIndexOf('function '))
      const fnHead = code.slice(fnStart, idx)
      const hasGet = new RegExp(`ctx\\.get\\(\\s*['"]${svc}['"]`).test(fnHead)
      out.push({ idx, inTry, hasGet })
    }
    return out
  }

  for (const svc of ['attachments', 'credentials']) {
    const reads = bareReads(svc)
    const illegal = reads.filter((r) => !(r.inTry && r.hasGet))
    check(`ctx.${svc} 若被裸读，必须包在 try 里且先用过 ctx.get('${svc}')`,
      illegal.length === 0,
      illegal.length ? `${illegal.length}/${reads.length} 处是无条件裸读（会抛 without inject）` : `共 ${reads.length} 处兜底读，均合规`)
  }

  // 明令禁止的形态：`ctx.xxx || ctx.get(...)` —— 前半截必抛，回退等于没写
  for (const svc of ['attachments', 'credentials']) {
    const bad = new RegExp(`ctx\\.${svc}\\s*\\|\\|`).test(code)
    check(`没有 \`ctx.${svc} || ctx.get(...)\` 这种写法（前半截必抛）`, !bad)
  }

  // 允许裸读的只有 inject 声明过的 llm / webServer，且必须真的是声明过的
  const injectDecls = [...code.matchAll(/\.inject\(\[([^\]]*)\]/g)]
    .map((m) => m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
  const declaredAnywhere = new Set(injectDecls.flat())
  for (const svc of ['llm', 'webServer']) {
    const used = new RegExp(`ctx\\.${svc}\\b`).test(code)
    if (used) {
      check(`ctx.${svc} 只在声明过它的 inject 作用域里用`, declaredAnywhere.has(svc),
        declaredAnywhere.has(svc) ? '' : `${svc} 没在任何 inject 里声明`)
    }
  }
  check('inject 声明里有 llm', declaredAnywhere.has('llm'))
  check('inject 声明里有 webServer', declaredAnywhere.has('webServer'))
  // attachments / credentials 是**可选**的：绝不能变成硬依赖，
  // 否则精简组合里整条路由会失踪（那是 1.6.x 的老 bug）。
  check('attachments 没有变成硬依赖（inject 里不声明它）', !declaredAnywhere.has('attachments'))
  check('credentials 没有变成硬依赖（inject 里不声明它）', !declaredAnywhere.has('credentials'))
}

// ---- 运行时：严格代理下 apply() 不炸，带图片的对话也不炸 ----
//
// 这里必须让流程**真的走到** resolveImageUrls（它在 streamOnce 里，
// 排在 ensureCredential 之后）。所以临时 home 里放一份假账号 + 假凭据，
// 让 ensureCredential 通过；不这么做的话会先报"没有可用凭据"就返回，
// 图片那段根本没执行 —— 那种"绿"是假的（本测试第一版就是这么假绿的）。
console.log('— 运行时：严格 cordis 代理下不抛 without inject —')
{
  const { apply } = await import('../index.js')
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cbstrict-'))
  const logger = { info() {}, warn() {}, error() {}, debug() {} }

  // 假账号 + 假凭据（未过期），让 ensureCredential 直接命中本地库
  const dataDir = path.join(tmpHome, 'dsh-codebuddy')
  fs.mkdirSync(dataDir, { recursive: true })
  const REF = 'BUDDY_ACCOUNT_TEST'
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    schema: 'dsh-codebuddy/accounts/v1',
    active: 'test-acc',
    accounts: [{ id: 'test-acc', provider: 'buddy', enabled: true, credentialRef: REF }],
  }, null, 2), 'utf8')
  const farFuture = Date.now() + 3600_000
  fs.writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify({
    schema: 'dsh-codebuddy/credentials/v1',
    credentials: {
      [REF]: JSON.stringify({ access_token: 'fake-token-for-scope-test', expires_at: farFuture, refresh_token: 'r', domain: 'www.codebuddy.ai' }),
    },
  }, null, 2), 'utf8')

  const adapters = []
  const llm = {
    registerAdapter(ids, adapter) { adapters.push({ ids, adapter }); return { dispose() {} } },
    registerConfigurableProviders() {},
  }
  const webServer = { register() { return { dispose() {} } }, dispose() {} }

  // attachments 服务：记录被调用的次数，用来证明图片路径真的被执行了
  let attachCalls = 0
  const attachments = {
    imageLimits: { maxBytes: 10 * 1024 * 1024 },
    async readImageRequest(ref) {
      attachCalls += 1
      return { data: Buffer.from([1, 2, 3]), mediaType: 'image/png' }
    },
  }

  // 关键：store 里**故意不放** credentials（模拟"组合里没有这个服务"），
  // 但放 attachments —— 这样图片路径可走，同时验证 ctx.credentials 不被裸读。
  const ctx = strictCtx(['llm', 'webServer'], { llm, webServer, attachments })

  let threw = null
  let dispose = null
  try {
    dispose = apply(ctx, { dshHome: tmpHome, telemetry: false })
  } catch (e) {
    threw = e
  }
  check('apply() 在严格代理下不抛错', threw === null, threw ? threw.message : '')

  if (!threw && adapters.length > 0) {
    const { adapter } = adapters[0]
    let imgErr = null
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        // 形状必须是 block.attachment.attachmentId（collectImageRefs 认这个）
        { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
      ],
    }]
    try {
      const it = adapter.stream({ model: 'auto', messages, signal: new AbortController().signal })
      if (it && typeof it[Symbol.asyncIterator] === 'function') {
        const r = it[Symbol.asyncIterator]()
        await r.next()
      }
    } catch (e) {
      // 假 token 打上游必然失败，那是预期的；只关心是不是 without inject
      imgErr = e
    }
    const msg = String(imgErr && imgErr.message)
    check('带图片的消息不会抛 without inject', !/without inject/.test(msg), msg)
    check('带图片的消息不会因作用域错而失败（不是 ReferenceError/TypeError of undefined）',
      !(imgErr instanceof ReferenceError) && !/is not defined/.test(msg), msg)
    // 这一条才是真防线：证明图片路径确实被执行了。
    // 若为 0，说明上面两条绿是假的（流程在这之前就返回了）。
    check('图片路径确实被执行了（attachments.readImageRequest 被调用）', attachCalls > 0,
      '调用 ' + attachCalls + ' 次')
  }

  if (typeof dispose === 'function') { try { dispose() } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
}

// ---- 反向验证锚点：严格代理确实会抛（证明上面不是假绿）----
console.log('— 自检：严格代理的抛错行为符合预期 —')
{
  const ctx = strictCtx(['llm'], {})
  let caught = null
  try { void ctx.attachments } catch (e) { caught = e }
  check('读未声明服务会抛（模拟真 cordis）', caught !== null && /without inject/.test(caught.message),
    caught ? caught.message : '竟然没抛，测试本身失效')
  check('ctx.get 对缺失服务返回 undefined（逃生通道可用）', ctx.get('attachments') === undefined)
}

console.log(bad === 0 ? '\nPASS cordis 作用域纪律' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
