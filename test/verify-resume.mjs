/**
 * 断流自愈测试（离线，纯逻辑）。
 *
 * 背景：用户实际遇到过
 *   「codebuddy: 上游在回答中途断开连接（terminated），本轮已作废。请重发这条消息。」
 * 也就是 streamCall 的恢复策略在「正文已经吐出半截」后放弃了整轮。
 *
 * 这里把 streamCall 单独抽出来，用一个可控的 streamOnce 桩，
 * 断言四条恢复路径：
 *   A. 已交付正文 → 续写（回灌 assistant 正文 + 指令），且续写轮禁用工具
 *   B. 什么都没交付 → 整轮重发，不注入任何 assistant 消息
 *   C. 续写用尽（3 次）→ 才报错，且错误里说明试过几次
 *   D. 非连接类错误 → 立即上抛，不重试
 */
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`未找到 ${name}`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

function sliceGenerator(signature) {
  const start = src.indexOf(signature)
  if (start < 0) throw new Error('未找到 ' + signature)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

const streamCallSrc = sliceGenerator('async function* streamCall(')

// streamOnce / logger 用桩；isConnectionDeath 用真实实现（判定逻辑要一致）
const code = [
  sliceFn('isConnectionDeath'),
  `
let __streams = []
let __calls = []
const logger = { info() {}, warn() {}, error() {} }
async function* streamOnce(options, startIndex, opts) {
  __calls.push({ options, startIndex, opts })
  const factory = __streams.shift()
  if (!factory) throw new Error('测试桩：没有更多流了')
  yield* factory(options, startIndex, opts)
}
${streamCallSrc}
return {
  streamCall,
  push(fn) { __streams.push(fn) },
  calls() { return __calls },
  reset() { __streams = []; __calls = [] },
}`,
].join('\n')

const env = new Function(code)()

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''))
}

/** 造一个「连接被掐断」错误，和 consumeSse 里抛的形状一致。 */
function interrupted() {
  const e = new Error('codebuddy: 响应流被上游中途断开（terminated）')
  e.codebuddyInterrupted = true
  return e
}

async function collect(options) {
  const out = []
  for await (const chunk of env.streamCall(options)) out.push(chunk)
  return out
}

const textDelta = (text, index = 0) => ({ type: 'text-delta', index, text })
const blockStart = (index, blockType) => ({ type: 'block-start', index, blockType })
const toolDelta = (index, name) => ({ type: 'tool-call-delta', index, id: 'c1', name, argumentsDelta: '{}' })

// ── A. 已交付正文 → 续写 ──
{
  env.reset()
  env.push(async function* first() {
    yield textDelta('你好')
    throw interrupted()
  })
  env.push(async function* second() {
    yield textDelta('世界')
  })
  const out = await collect({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  const text = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
  check('A 续写后正文拼成「你好世界」', text === '你好世界', text)
  const calls = env.calls()
  check('A 共请求 2 次', calls.length === 2, calls.length)
  check('A 第二次禁用思考块', calls[1] && calls[1].opts.skipReasoning === true)
  check('A 第二次禁用工具', calls[1] && calls[1].opts.skipTools === true)
  const msgs = (calls[1] && calls[1].options.messages) || []
  const assistant = msgs.find((m) => m.role === 'assistant')
  check('A 回灌了已交付正文', assistant && assistant.content[0].text === '你好', JSON.stringify(assistant))
  const instr = msgs.find((m) => m.role === 'user' && /cut off mid-way/.test(m.content[0].text))
  check('A 追加了续写指令', !!instr)
  check('A 不累积多份 assistant 消息', msgs.filter((m) => m.role === 'assistant').length === 1)
}

// ── B. 什么都没交付 → 整轮重发 ──
{
  env.reset()
  env.push(async function* first() {
    yield { type: 'reasoning-delta', index: 0, text: '想一想' }
    throw interrupted()
  })
  env.push(async function* second() {
    yield textDelta('结果')
  })
  const out = await collect({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
  check('B 重发后拿到正文', out.some((c) => c.type === 'text-delta' && c.text === '结果'))
  const calls = env.calls()
  check('B 共请求 2 次', calls.length === 2, calls.length)
  const msgs = (calls[1] && calls[1].options.messages) || []
  check('B 重发不注入 assistant', msgs.every((m) => m.role !== 'assistant'), JSON.stringify(msgs))
  check('B 重发不注入续写指令', msgs.every((m) => !/cut off mid-way/.test(JSON.stringify(m))))
  check('B 第二次禁用思考块', calls[1] && calls[1].opts.skipReasoning === true)
  check('B 第二次不禁用工具（还是同一轮）', calls[1] && calls[1].opts.skipTools === false)
}

// ── C. 续写用尽才报错 ──
{
  env.reset()
  for (let i = 0; i < 6; i += 1) {
    env.push(async function* dies() {
      yield textDelta('片段')
      throw interrupted()
    })
  }
  let threw = ''
  try { await collect({ messages: [] }) } catch (e) { threw = String(e.message) }
  check('C 最终仍抛错', threw.length > 0, threw)
  check('C 错误说明已自动重试 3 次', /已自动重试 3 次/.test(threw), threw)
  check('C 不再出现「本轮已作废」', !/本轮已作废/.test(threw), threw)
  check('C 共请求 4 次（首次 + 3 次续写）', env.calls().length === 4, env.calls().length)
}

// ── D. 工具块已下发后断流：仍能续写，且续写轮不带工具 ──
{
  env.reset()
  env.push(async function* withTool() {
    yield blockStart(0, 'tool-call')
    yield toolDelta(0, 'pwsh')
    throw interrupted()
  })
  env.push(async function* tail() {
    yield textDelta('已经跑完了', 1)
  })
  const out = await collect({ messages: [] })
  check('D 工具块后断流不报错', out.some((c) => c.type === 'text-delta' && c.text === '已经跑完了'))
  const calls = env.calls()
  check('D 续写轮禁用工具（防重复执行）', calls[1] && calls[1].opts.skipTools === true)
  const assistant = ((calls[1] && calls[1].options.messages) || []).find((m) => m.role === 'assistant')
  check('D 只有工具块时回灌占位文本', assistant && /tool call/.test(assistant.content[0].text),
    assistant && assistant.content[0].text)
  check('D 未重复产出工具块', out.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call').length === 1)
}

// ── E. 非连接类错误立即上抛 ──
{
  env.reset()
  env.push(async function* boom() {
    throw new Error('codebuddy: 额度已用尽')
  })
  let threw = ''
  try { await collect({ messages: [] }) } catch (e) { threw = String(e.message) }
  check('E 非连接错误原样上抛', /额度已用尽/.test(threw), threw)
  check('E 不重试', env.calls().length === 1, env.calls().length)
}

const bad = results.filter((r) => !r.ok).length
console.log(bad === 0 ? `\n断流自愈 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
