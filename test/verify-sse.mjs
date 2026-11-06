/**
 * 用假 SSE 流离线验证 consumeSse 的块协议：
 *   · reasoning / text 各自成块，块末带完整内容
 *   · 工具调用：block-start(tool-call) → tool-call-delta → 块末带 id/name/arguments
 *   · usage 即时产出，finish 收尾
 *   · 只有 index、没有 name 的首个分片不得提前开块
 * Run: node verify-codebuddy-sse.mjs
 */
import fs from "node:fs"

const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8")

// 把 consumeSse 需要的顶层常量与工具函数搬进 eval 作用域
const constNames = ["PROVIDER", "ENDPOINT", "API_DOMAIN", "USER_AGENT", "PRODUCT_CODE", "DEPLOYMENT_TYPE", "AUTH_REFRESH_SOURCE"]
const constSrc = constNames.map((n) => {
  const m = src.match(new RegExp(`^const ${n} = .*$`, "m"))
  if (!m) throw new Error(`未找到常量 ${n}`)
  return m[0]
}).join("\n")

function sliceFn(name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`未找到 ${name}`)
  let depth = 0, i = src.indexOf("{", start)
  const from = i
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") { depth--; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

// consumeSse 是 apply 内的闭包函数，单独抽出来测
const csStart = src.indexOf("async function* consumeSse(response, options) {")
if (csStart < 0) throw new Error("未找到 consumeSse")
let depth = 0, i = src.indexOf("{", csStart)
for (; i < src.length; i++) {
  if (src[i] === "{") depth++
  else if (src[i] === "}") { depth--; if (depth === 0) break }
}
const consumeSrc = src.slice(csStart, i + 1)

const code = [
  constSrc,
  "function readNumber(v){const n=Number(v);return Number.isFinite(n)&&n>0?n:0}",
  sliceFn("normalizeArgs"),
  sliceFn("normalizeArgsText"),
  sliceFn("isCompleteArgs"),
  consumeSrc,
  "return { consumeSse }",
].join("\n\n")
const { consumeSse } = new Function(code)()

function fakeResponse(lines) {
  const encoder = new TextEncoder()
  const chunks = lines.map((l) => encoder.encode(l + "\n"))
  let k = 0
  return {
    body: {
      getReader() {
        return { read: async () => (k < chunks.length ? { done: false, value: chunks[k++] } : { done: true }) }
      },
    },
  }
}

const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1 }
const d = (o) => `data: ${JSON.stringify(o)}`

// ---- 用例 1：思考 + 正文 ----
{
  const res = fakeResponse([
    d({ choices: [{ delta: { reasoning_content: "让我想" } }] }),
    d({ choices: [{ delta: { reasoning_content: "想" } }] }),
    d({ choices: [{ delta: { content: "你好" } }] }),
    d({ choices: [{ delta: { content: "世界" }, finish_reason: "stop" }] }),
    d({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 8, total_tokens: 108 } }),
    "data: [DONE]",
  ])
  const out = []
  for await (const c of consumeSse(res, {})) out.push(c)
  const types = out.map((c) => c.type)
  if (types[0] !== "block-start" || out[0].blockType !== "reasoning") fail("应先开 reasoning 块")
  const reasoningEnd = out.find((c) => c.type === "block-end" && c.block && c.block.type === "reasoning")
  if (!reasoningEnd || reasoningEnd.block.text !== "让我想想") fail("reasoning 块末内容不完整: " + JSON.stringify(reasoningEnd && reasoningEnd.block))
  const textEnd = out.find((c) => c.type === "block-end" && c.block && c.block.type === "text")
  if (!textEnd || textEnd.block.text !== "你好世界") fail("text 块末内容不完整: " + JSON.stringify(textEnd && textEnd.block))
  if (reasoningEnd.index === textEnd.index) fail("reasoning 与 text 应占不同 index")
  const usage = out.find((c) => c.type === "usage")
  if (!usage) fail("缺 usage")
  else {
    if (usage.usage.inputTokens !== 60) fail("inputTokens 应为未命中部分 60，实际 " + usage.usage.inputTokens)
    if (usage.usage.cacheReadTokens !== 40) fail("cacheReadTokens 应为 40")
    if (usage.usage.outputTokens !== 8) fail("outputTokens 应为 8")
  }
  if (out[out.length - 1].type !== "finish") fail("finish 必须是最后一个 chunk")
  if (out[out.length - 1].reason.kind !== "stop") fail("finish reason 应为 stop")
}

// ---- 用例 2：工具调用（id 只在首片，name 后到） ----
{
  const res = fakeResponse([
    d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "pwsh", arguments: '{"com' } }] } }] }),
    d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'mand":"ls"}' } }] } }] }),
    d({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]",
  ])
  const out = []
  for await (const c of consumeSse(res, {})) out.push(c)
  const start = out.find((c) => c.type === "block-start" && c.blockType === "tool-call")
  if (!start) fail("工具调用缺 block-start(tool-call)")
  const deltas = out.filter((c) => c.type === "tool-call-delta")
  if (deltas.length < 2) fail("工具参数分片未全部转发，收到 " + deltas.length)
  if (deltas[0].id !== "call_abc") fail("首片应带真实 id")
  if (deltas[1].id !== "call_abc") fail("后续片应复用同一 id，实际 " + deltas[1].id)
  const end = out.find((c) => c.type === "block-end" && c.block && c.block.type === "tool-call")
  if (!end) fail("工具调用缺 block-end")
  else {
    if (end.block.id !== "call_abc") fail("块末 id 不对: " + end.block.id)
    if (end.block.name !== "pwsh") fail("块末 name 不对: " + end.block.name)
    // ToolCallBlock.arguments 是字符串（契约要求），不是对象
    if (typeof end.block.arguments !== "string") fail("块末 arguments 必须是字符串: " + typeof end.block.arguments)
    else {
      let parsed = null
      try { parsed = JSON.parse(end.block.arguments) } catch { fail("块末 arguments 不是合法 JSON: " + end.block.arguments) }
      if (parsed && parsed.command !== "ls") fail("块末 arguments 内容不对: " + end.block.arguments)
    }
  }
  // 工具调用的 delta index 必须与 block-start 的块索引一致（不是 wire index）
  if (start && deltas[0] && deltas[0].index !== start.index) {
    fail(`tool-call-delta.index 应为块索引 ${start.index}，实际 ${deltas[0].index}`)
  }
  if (out[out.length - 1].reason.kind !== "tool-calls") fail("finish reason 应为 tool-calls")
}

// ---- 用例 3：只有 index、没有 name 的首片不得提前开块 ----
{
  const res = fakeResponse([
    d({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "" } }] } }] }),
    d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: '{"pattern":"x"}' } }] } }] }),
    "data: [DONE]",
  ])
  const out = []
  for await (const c of consumeSse(res, {})) out.push(c)
  const firstStart = out.findIndex((c) => c.type === "block-start" && c.blockType === "tool-call")
  const firstNamed = out.findIndex((c) => c.type === "tool-call-delta" && c.name)
  if (firstStart < 0 || firstNamed < 0) fail("缺 block-start 或具名分片")
  else if (firstStart > firstNamed) fail("block-start 必须不晚于首个具名分片")
  const end = out.find((c) => c.type === "block-end" && c.block && c.block.type === "tool-call")
  if (!end || end.block.name !== "grep") fail("块末 name 应为 grep")
}

// ---- 用例 4：参数被截断 → max-tokens ----
{
  const res = fakeResponse([
    d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", function: { name: "write", arguments: '{"path":"a' } }] } }] }),
    d({ choices: [{ delta: {}, finish_reason: "length" }] }),
    "data: [DONE]",
  ])
  const out = []
  for await (const c of consumeSse(res, {})) out.push(c)
  if (out[out.length - 1].reason.kind !== "max-tokens") fail("截断应报 max-tokens，实际 " + out[out.length - 1].reason.kind)
  const end = out.find((c) => c.type === "block-end" && c.block && c.block.type === "tool-call")
  if (!end || typeof end.block.arguments !== "string") fail("截断的参数应保留原字符串，实际 " + typeof (end && end.block.arguments))
}

// ---- 用例 5：流内错误帧必须抛出 ----
{
  const res = fakeResponse([d({ code: 11128, msg: "Illegal API invocation" }), "data: [DONE]"])
  let threw = ""
  try { for await (const _ of consumeSse(res, {})) { /* noop */ } } catch (e) { threw = String(e.message) }
  if (!/11128/.test(threw)) fail("11128 应抛出，实际: " + threw)
}

// ---- 用例 6：正文夹工具（块顺序） ----
{
  const res = fakeResponse([
    d({ choices: [{ delta: { content: "先看" } }] }),
    d({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "ls", arguments: "{}" } }] } }] }),
    d({ choices: [{ delta: { content: "后说" }, finish_reason: "stop" }] }),
    "data: [DONE]",
  ])
  const out = []
  for await (const c of consumeSse(res, {})) out.push(c)
  const starts = out.filter((c) => c.type === "block-start")
  const kinds = starts.map((c) => c.blockType)
  if (kinds[0] !== "text") fail("首块应为 text，实际 " + kinds.join(","))
  if (!kinds.includes("tool-call")) fail("中途应开出 tool-call 块，实际 " + kinds.join(","))
  const indices = starts.map((c) => c.index)
  if (new Set(indices).size !== indices.length) fail("块 index 不得重复: " + indices.join(","))
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
