/**
 * Offline check for dsh-codebuddy Host half:
 *   1. serializeMessages 把 DSH 消息转成 OpenAI 线格式，且 system 被中性化
 *   2. 中性化后的载荷不含任何已知触发词
 *   3. 适配器契约（providerInfo / listModels / resolveModel / prepareCall）形状正确
 *   4. 没有凭据时 stream 明确报错而不是静默
 * Run: node verify-codebuddy.mjs
 */
import fs from "node:fs"

// 把 index.js 读进来，取内部函数（模块没导出它们，用文本切片 + Function 构造）
const src = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8")

function extract(name, kind) {
  // 抓 function xxx(...) { ... } 或 const xxx = [...]
  if (kind === "fn") {
    const start = src.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`未找到函数 ${name}`)
    let depth = 0, i = src.indexOf("{", start)
    const from = i
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++
      else if (src[i] === "}") { depth--; if (depth === 0) break }
    }
    return src.slice(start, i + 1)
  }
  const start = src.indexOf(`const ${name} = `)
  if (start < 0) throw new Error(`未找到常量 ${name}`)
  // 常量可能是跨多行的数组/对象：从 `const X = ` 起算括号深度，取到收尾的 `]` 或 `}`
  const eq = src.indexOf("=", start)
  const openIdx = src.slice(eq).search(/[\[{]/) + eq
  const open = src[openIdx]
  const close = open === "[" ? "]" : "}"
  let depth = 0, i = openIdx
  for (; i < src.length; i++) {
    if (src[i] === open) depth++
    else if (src[i] === close) { depth--; if (depth === 0) break }
  }
  // 数组/对象后面可能还挂着 .join('...') 之类的收尾表达式，一并带上
  let tail = i + 1
  while (tail < src.length && !/[\n;]/u.test(src.slice(tail, tail + 1))) tail++
  return src.slice(start, tail)
}

// 把 index.js 里需要的顶层常量原样搬进 eval 作用域
const constNames = ["PROVIDER", "DISPLAY_NAME", "ENDPOINT", "API_DOMAIN", "USER_AGENT", "PRODUCT_CODE", "DEPLOYMENT_TYPE", "AUTH_REFRESH_SOURCE", "CHAT_PATH", "CONFIG_PATH", "REFRESH_PATH", "REQUEST_TIMEOUT_MS"]
const constSrc = constNames.map((n) => {
  const m = src.match(new RegExp(`^const ${n} = .*$`, "m"))
  if (!m) throw new Error(`未找到常量 ${n}`)
  return m[0]
}).join("\n")

const code = [
  constSrc,
  extract("BLOCKED_PATTERNS", "const"),
  extract("BLOCKED_HINTS", "const"),
  extract("sanitizeText", "fn"),
  extract("sanitizeArgs", "fn"),
  extract("NEUTRAL_SYSTEM", "const"),
  extract("FALLBACK_MODELS", "const"),
  extract("collectImageRefs", "fn"),
  extract("serializeMessages", "fn"),
  extract("normalizeArgs", "fn"),
  extract("buildHeaders", "fn"),
  extract("isExpired", "fn"),
  "return { NEUTRAL_SYSTEM, FALLBACK_MODELS, serializeMessages, buildHeaders, isExpired, sanitizeText, collectImageRefs }",
].join("\n\n")
const mod = new Function(code)()
const { serializeMessages, buildHeaders, isExpired, NEUTRAL_SYSTEM, FALLBACK_MODELS, sanitizeText, collectImageRefs } = mod

const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1 }

// ---- 1. system 中性化 ----
const messages = [
  { role: "system", content: [{ type: "text", text: "You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the deepseek-flash model.\n\nTokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root." }] },
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "reasoning", text: "thinking..." }] },
  { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "pwsh", arguments: { command: "ls" } }] },
  { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "file list" }] },
  { role: "user", content: [{ type: "text", text: "继续" }] },
]
const wire = serializeMessages(messages)
const wireJson = JSON.stringify(wire)

if (wire[0].role !== "system") fail("首条必须是 system")
if (wire[0].content !== NEUTRAL_SYSTEM) fail("system 未被中性化")

// 已知触发词必须全部消失
for (const bad of ["DeepSeek Harness", "You are an AI agent powered by", "Tokens prefixed with @ are paths the user explicitly referenced", "Relative paths resolve from the workspace root"]) {
  if (wireJson.includes(bad)) fail(`中性化后仍含触发词: ${bad}`)
}

// ---- 1b. 历史里被引用过的触发句也必须清理（真实故障场景）----
// 实测：第二句放在 assistant 历史里同样触发 11128，服务端扫整个 body。
{
  const hist = [
    { role: "system", content: [{ type: "text", text: "whatever" }] },
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [{
        type: "text",
        text: "补丁说明：这两句会触发拦截 -\n1) You are an AI agent powered by DeepSeek Harness.\n2) Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.",
      }],
    },
    // 模型复述时会换行、加反引号、动空格
    { role: "assistant", content: [{ type: "text", text: "原文是 `Tokens prefixed with @  are paths  the user explicitly referenced.` 之后是 Relative paths resolve from the workspace root; absolute paths identify files or directories on the host." }] },
    { role: "user", content: [{ type: "text", text: "继续" }] },
    // 工具输出里也可能带上（比如 grep 到源码）
    { role: "tool", toolCallId: "c1", content: [{ type: "text", text: "src/prompt.ts:1: You are an AI agent powered by DeepSeek Harness." }] },
  ]
  const hw = serializeMessages(hist)
  const hjson = JSON.stringify(hw)
  for (const bad of ["You are an AI agent powered by DeepSeek Harness", "DeepSeek Harness", "Tokens prefixed with @ are paths the user explicitly referenced", "Relative paths resolve from the workspace root"]) {
    if (hjson.includes(bad)) fail(`历史中的触发句未被清理: ${bad}`)
  }
  if (!hjson.includes("helpful coding assistant") && !hjson.includes("explicit file references")) {
    fail("替换后应留下中性文案")
  }
  // 替换不能吃掉整条消息
  const assistantCount = hw.filter((m) => m.role === "assistant").length
  if (assistantCount !== 2) fail("替换不应删除消息，assistant 数 " + assistantCount)
  // sanitizeText 幂等
  const once = sanitizeText("You are an AI agent powered by DeepSeek Harness.")
  if (sanitizeText(once) !== once) fail("sanitizeText 应幂等")
  // 无敏感词时原样返回
  const plain = "just a normal sentence about files"
  if (sanitizeText(plain) !== plain) fail("普通文本不应被改动")
}

// ---- 2. 线格式形状 ----
const users = wire.filter((m) => m.role === "user")
if (users.length !== 2) fail("user 消息数应为 2，实际 " + users.length)
const assistants = wire.filter((m) => m.role === "assistant")
if (assistants.length !== 2) fail("assistant 消息数应为 2，实际 " + assistants.length)
const withCall = assistants.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.length)
if (!withCall) fail("工具调用未序列化")
else {
  const c = withCall.tool_calls[0]
  if (c.type !== "function" || c.function.name !== "pwsh") fail("工具调用形状不对: " + JSON.stringify(c))
}
const toolMsg = wire.find((m) => m.role === "tool")
if (!toolMsg || toolMsg.tool_call_id !== "call_1") fail("tool 结果未配对")

// 纯文本+工具调用的 assistant：content 应为 null
const bare = serializeMessages([
  { role: "assistant", content: [{ type: "tool-call", id: "c9", name: "x", arguments: {} }] },
])
const bareA = bare.find((m) => m.role === "assistant")
if (!bareA || bareA.content !== null) fail("只有工具调用时 content 必须为 null")

// ---- 2b. 图片块 ----
{
  const imgRef = { attachmentId: "att_1", mediaType: "image/png", bytes: 132, width: 32, height: 32 }
  const withImg = [
    { role: "user", content: [{ type: "text", text: "看这张图" }, { type: "image", attachment: imgRef }] },
  ]
  // 收集引用
  const refs = collectImageRefs(withImg)
  if (refs.size !== 1 || !refs.has("att_1")) fail("collectImageRefs 未收集到图片引用")

  // 有映射 → image_url
  const urls = new Map([["att_1", "data:image/png;base64,AAAA"]])
  const w1 = serializeMessages(withImg, urls)
  const userParts = w1.find((m) => m.role === "user")?.content
  if (!Array.isArray(userParts)) fail("含图消息应为数组 content")
  else {
    const imgPart = userParts.find((p) => p.type === "image_url")
    if (!imgPart) fail("图片未序列化成 image_url")
    else if (!String(imgPart.image_url?.url || "").startsWith("data:image/png;base64,")) {
      fail("图片 URL 不是 data URL: " + imgPart.image_url?.url)
    }
  }

  // 无映射 → 明确的占位文本（不能让模型以为没图）
  const w2 = serializeMessages(withImg, new Map())
  const w2json = JSON.stringify(w2)
  if (!w2json.includes("[image unavailable]")) fail("缺映射时应写 [image unavailable] 占位")

  // 老式 imageUrl 字段不再被当作图片
  const legacy = serializeMessages([{ role: "user", content: [{ type: "image", imageUrl: "http://x/y.png" }] }], new Map())
  if (JSON.stringify(legacy).includes("http://x/y.png")) fail("不应信任无 attachment 的图片块")

  // tool-result 内嵌图片也要能收集
  const nested = [{ role: "tool", toolCallId: "t", content: [{ type: "tool-result", content: [{ type: "image", attachment: imgRef }] }] }]
  if (collectImageRefs(nested).size !== 1) fail("未能收集 tool-result 内嵌图片")
}

// ---- 3. header ----
const h = buildHeaders({ access_token: "AT", user_id: "u1", enterprise_id: "" })
if (h["User-Agent"] !== "CodeBuddyIDE/1.106.1") fail("UA 不对")
if (h.Authorization !== "Bearer AT") fail("Authorization 不对")
if (h["X-Product-Code"] !== "codebuddy") fail("X-Product-Code 不对")
if (h["X-Enterprise-Id"] !== undefined) fail("空 enterprise_id 不该出现")

// ---- 4. 过期判定 ----
if (!isExpired(null)) fail("null 应视为过期")
if (isExpired({ expires_at: String(Date.now() + 600_000) })) fail("未过期被判过期")
if (!isExpired({ expires_at: String(Date.now() - 1) })) fail("已过期被判未过期")

// ---- 5. 模型表 ----
if (FALLBACK_MODELS.length < 10) fail("兜底模型太少")
const ids = new Set(FALLBACK_MODELS.map((m) => m.id))
for (const need of ["deepseek-v4.1-flash", "glm-5.3", "kimi-k3-1"]) if (!ids.has(need)) fail("缺模型 " + need)

// ---- 6. 适配器契约（用假 ctx 跑 apply） ----
const { apply } = await import(new URL("../index.js", import.meta.url).href)
let registered = null
const allRegistrations = []
const fake = {
  logger: { info: () => {}, warn: () => {} },
  llm: {
    // 适配器会注册主渠道 + 别名，全部收集；registered 保留第一次（主渠道）
    registerAdapter(providers, adapter) {
      if (!registered) registered = { providers, adapter }
      allRegistrations.push({ providers, adapter })
      return { dispose() {} }
    },
    registerConfigurableProviders(entries) { fake.configurable = entries },
  },
  credentials: { async resolve() { return null }, async set() {} },
  // 适配器会注入 attachments 读图；这里给一个能返回 1×1 PNG 的最小实现
  attachments: {
    imageLimits: { maxImageBytes: 4_000_000, maxImagesPerMessage: 8, maxMessageImageBytes: 16_000_000, maxImagePixels: 16_000_000, maxImageDimension: 4_000, mediaTypes: ["image/png"] },
    async readImageRequest(ref) {
      return { variantId: "v1", attachment: ref, data: new Uint8Array([137, 80, 78, 71]), mediaType: ref.mediaType, bytes: 4, width: ref.width, height: ref.height, depth: "uchar", space: "srgb", hasAlpha: false }
    },
  },
  // Cordis 的依赖注入：依赖齐备时才回调
  inject(deps, callback) { callback(fake); return () => {} },
}
const dispose = apply(fake, {})
if (!registered) fail("未注册适配器")
else {
  const a = registered.adapter
  if (registered.providers[0] !== "codebuddy") fail("provider 名不对")
  const info = a.providerInfo("codebuddy")
  if (!info.id || !info.name) fail("providerInfo 形状不对")
  const policy = a.providerRetryPolicy()
  if (!Array.isArray(policy.retryableCodes)) fail("retryPolicy 形状不对")
  // 默认重试 1 次：瞬时故障自愈，又不放大成刷屏
  if (policy.maxRetries !== 1) fail("默认 maxRetries 应为 1，实际 " + policy.maxRetries)
  const models = await a.listModels()
  if (models.length !== FALLBACK_MODELS.length) fail("listModels 数量不对: " + models.length)
  if (models[0].provider !== "codebuddy") fail("listModels provider 不对")
  const rm = await a.resolveModel("codebuddy", "deepseek-v4.1-flash")
  if (!rm.context || rm.context.contextWindow !== 1_000_000) fail("resolveModel context 不对: " + JSON.stringify(rm.context))
  if (!rm.defaultMaxTokens) fail("resolveModel defaultMaxTokens 缺失")
  if (!rm.reasoning || rm.reasoning.efforts.length === 0) fail("resolveModel reasoning 缺失")
  // hy4free：真实目录只给一档 high，但必须声明出等级（否则界面没有选择器）
  {
    const rh = await a.resolveModel("codebuddy", "hy4free")
    if (!rh.reasoning || !Array.isArray(rh.reasoning.efforts) || rh.reasoning.efforts.length < 1) {
      fail("hy4free 应声明可选思考等级，实际 " + JSON.stringify(rh.reasoning))
    }
    if (rh.reasoning && rh.reasoning.defaultEffort !== "high") fail("hy4free 默认等级应为 high")
  }
  // 图片支持必须如实声明，否则宿主会在添加图片时直接拒绝
  if (!Array.isArray(rm.inputModalities) || !rm.inputModalities.includes("image")) {
    fail("inputModalities 应包含 image，实际 " + JSON.stringify(rm.inputModalities))
  }
  if (!Array.isArray(models[0].inputModalities) || !models[0].inputModalities.includes("image")) {
    fail("listModels 的 inputModalities 应包含 image")
  }
  // 支持图像就应给出计费/尺寸投影能力，避免宿主 spill 策略整条放弃
  if (typeof a.imageRequestTarget !== "function") fail("缺 imageRequestTarget")
  const pc = await a.prepareCall("codebuddy", "deepseek-v4.1-flash")
  if (!pc.model || typeof pc.stream !== "function") fail("prepareCall 形状不对")
  // 没有凭据时 stream 必须明确报错
  let threw = ""
  try { for await (const _ of pc.stream({ model: "deepseek-v4.1-flash", messages: [] })) {} }
  catch (e) { threw = String(e.message) }
  if (!/凭据|credential/i.test(threw)) fail("无凭据应报缺少凭据，实际: " + threw)
}
if (typeof dispose !== "function") fail("apply 必须返回清理函数")
dispose()

// 官方让重试才重试：11134 的 retry_policy 与 429/503+Retry-After 命中，其余不命中
// 额度用尽（14018）是例外：即使 429 + Retry-After 也绝不重试，且必须给出可执行提示
{
  const { shouldRetryTransient, quotaExhaustedMessage } = await import("../index.js")
  const mkRes = (status, headers = {}) => ({
    status,
    headers: { get: (k) => (String(k).toLowerCase() in headers ? headers[String(k).toLowerCase()] : null) },
  })
  const t11134 = JSON.stringify({ code: 11134, msg: "provider unavailable", retry_policy: { retry: true } })
  if (!(await shouldRetryTransient(t11134, mkRes(500)))) fail("retry_policy.retry=true 应命中")
  if (await shouldRetryTransient('{"code":11128}', mkRes(400))) fail("11128 不该重试")
  if (await shouldRetryTransient("not json", mkRes(500))) fail("无信号 500 不该重试")
  if (await shouldRetryTransient("", mkRes(500, { "retry-after": "2" }))) fail("500 带 RA 不该命中（只认 429/503）")
  if (!(await shouldRetryTransient("", mkRes(429, { "retry-after": "0" })))) fail("429+Retry-After 应命中")
  if (!(await shouldRetryTransient("", mkRes(503, { "retry-after": "30" })))) fail("503+Retry-After 应命中（等待有封顶）")

  // 真实抓到的额度错误形态：{"error":{"data":{"code":14018,"msg":"额度已用尽…"}}}
  const t14018 = JSON.stringify({
    error: { data: { code: 14018, msg: "额度已用尽，请访问以下链接，购买加量包以获取更多额度：https://www.codebuddy.cn/profile/usage ", requestId: "x" } },
  })
  const q = quotaExhaustedMessage(t14018)
  if (!/额度已用尽/.test(q)) fail("14018 应识别为额度用尽，实际: " + JSON.stringify(q))
  if (!q.includes("https://www.codebuddy.cn/profile/usage")) fail("额度提示应带购买链接，实际: " + q)
  if (!/换|切换/.test(q)) fail("额度提示应建议换模型/渠道，实际: " + q)
  if (await shouldRetryTransient(t14018, mkRes(429, { "retry-after": "0" }))) {
    fail("额度用尽即便 429+Retry-After 也不该重试")
  }
  // 普通 429（非额度）仍可重试，别误伤
  if (quotaExhaustedMessage('{"code":429,"msg":"too many requests"}')) fail("普通限流不该判成额度用尽")

  // 频率限制 6004：有明确解禁时间，必须识别出来并禁止重试
  {
    const { rateLimitInfo } = await import("../index.js")
    const t6004 = JSON.stringify({
      code: 6004,
      msg: "您的使用量已超出频率限制，将在 2026-11-08 18:24:35 UTC+8 重置，您也可以切换其他模型继续使用。",
      requestId: "x",
    })
    const r = rateLimitInfo(t6004)
    if (!r || !/频率限制/.test(r.message)) fail("6004 应识别为频率限制，实际: " + JSON.stringify(r))
    if (!r || r.resetMs <= 0) fail("应解析出解禁时间，实际: " + JSON.stringify(r))
    const want = Date.parse("2026-11-08T18:24:35+08:00")
    if (r.resetMs !== want) fail("解禁时间解析不对: " + r.resetMs + " != " + want)
    if (!/重置|切换/.test(r.message)) fail("频率限制提示应说明解禁时间/建议换模型，实际: " + r.message)
    if (await shouldRetryTransient(t6004, mkRes(429, { "retry-after": "1" }))) {
      fail("频率限制即便 429+Retry-After 也不该重试")
    }
    // 不该被误判成额度用尽（两者处置不同：额度要充值、限流只需等）
    if (quotaExhaustedMessage(t6004)) fail("6004 不该判成额度用尽")
    // 普通 11134 也不会被误判成限流
    if (rateLimitInfo(t11134)) fail("11134 不该判成频率限制")
  }
}

console.log(JSON.stringify({ ok: !process.exitCode, models: FALLBACK_MODELS.length, neutralSystemChars: NEUTRAL_SYSTEM.length }, null, 2))
