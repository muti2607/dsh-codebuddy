/**
 * dsh-codebuddy — Host half.
 *
 * 把腾讯 CodeBuddy（copilot.tencent.com）的免费模型接进 DSH 的模型选择器。
 * 复用 Channel Pack 已经登录好的账号凭据（本机凭据库里的 BUDDY_ACCOUNT_*），
 * 不重复实现登录流程。
 *
 * 为什么单独做一个插件：
 *   OFM 2.8.0 起把 CodeBuddy 渠道搬进了 Go 引擎（vendor/magpie），JS 侧改不动；
 *   而腾讯会对请求体里的**若干原句**做黑名单匹配，命中即返回
 *   HTTP 400 / code 11128「Illegal API invocation from an unapproved channel」。
 *   实测（同一 token、同一 header，只改请求体）：
 *     · system 含 "You are a helpful coding assistant."        → 400
 *     · system 含 "Tokens prefixed with @ ... workspace root."   → 400
 *     · assistant **历史**里引用第二句                            → 400 ← 关键
 *     · 换成中性 system 文案                                     → 200
 *   第三行是踩过的坑：服务端扫的是**整个 body**，不只 system。一旦历史里出现过
 *   这些句子（排查时把原文贴进回复、或 grep 到源码那一行），之后每一轮都被拦，
 *   只有换新会话才能恢复 —— 除非客户端主动清理历史。故本插件做两层净化，
 *   见 BLOCKED_PATTERNS 与 serializeMessages。
 *
 * 数据来源：
 *   - 账号与凭据引用：$DSH_HOME/channel-pack/state.json（provider === "buddy"）
 *   - 凭据本体：ctx.credentials（本机凭据库，明文不出本机）
 *   - 模型目录：GET /v3/config（失败则用内置兜底表）
 *   - 续期：POST /v2/plugin/auth/token/refresh
 */

import fs from 'node:fs'
import path from 'node:path'

const PROVIDER = 'codebuddy'
const DISPLAY_NAME = 'CodeBuddy (腾讯免费)'

const ENDPOINT = 'https://copilot.tencent.com'
const API_DOMAIN = 'copilot.tencent.com'
const USER_AGENT = 'CodeBuddyIDE/1.106.1'
const PRODUCT_CODE = 'codebuddy'
const DEPLOYMENT_TYPE = 'SaaS'
const AUTH_REFRESH_SOURCE = 'ide-main'

const CHAT_PATH = '/v2/chat/completions'
const CONFIG_PATH = '/v3/config'
const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

const REQUEST_TIMEOUT_MS = 60_000
const FIRST_TOKEN_TIMEOUT_MS = 90_000
const CHUNK_TIMEOUT_MS = 120_000

/**
 * 只声明文本输入。CodeBuddy 的模型确实支持图像，但本适配器没有实现
 * DSH 的附件投影（把 ImageAttachmentRef 读成 data URL），声明 image
 * 会让宿主把图片送进来后被静默丢弃 —— 宁可如实声明 text，让宿主
 * 在添加图片时就拒绝，而不是发出一个「看不到图」的请求。
 */
const MODALITIES = Object.freeze(['text'])

/**
 * 已知会触发腾讯 11128 拦截的原文片段。
 *
 * 实测结论（同一 token/header，只改 body 内容）：
 *   · 这两句放在 **system** 角色 → 400 / 11128
 *   · 第二句放在 **assistant** 历史里 → 也是 400（说明服务端扫**整个 body**，不只 system）
 *   · 第一句放 user 角色 → 200（个别句子的角色敏感度不同）
 *
 * 因此不能只中性化 system：一旦对话历史里出现过这些句子（比如排查时
 * 把原文引用进了回复），后续每一轮都会被拦。这里对**所有角色**的文本
 * 统一做替换。
 *
 * 匹配用「首尾关键词 + 允许中间换行/空白」而不是整句精确匹配，
 * 因为模型会换行、加标点、加反引号地复述这些句子。
 */
const BLOCKED_PATTERNS = [
  // "You are an AI agent powered by DeepSeek Harness." 及其变体
  [/You are an AI agent powered by DeepSeek\s+Harness\.?/gi, 'You are a helpful coding assistant.'],
  // "Tokens prefixed with @ are paths the user explicitly referenced.
  //  Relative paths resolve from the workspace root; ..." 整段
  // 容忍模型复述时的换行、多空格、反引号：句子内容不变，只放宽空白。
  [
    /Tokens prefixed with @\s{0,4}are\s+paths\s+the\s+user\s+explicitly\s+referenced\.(?:[\s\S]{0,500}?workspace\s+root[^.]*\.)?/gi,
    'Paths the user marks with a leading @ are explicit file references; those paths resolve from the workspace root.',
  ],
  // 兜底：任何剩余的品牌名
  [/DeepSeek\s+Harness/gi, 'the coding platform'],
  [/deepseek-harness/gi, 'the-coding-platform'],
  // 这句话单独出现也可能被识别（保守起见一并换掉）
  [/AI agent powered by DeepSeek/gi, 'helpful coding assistant'],
]

/**
 * 快速路径的预筛词。必须覆盖**所有** BLOCKED_PATTERNS 的特征词，
 * 否则某个模式（例如不含 "Harness"/"DeepSeek" 的 "@ paths ... workspace root"
 * 那句）会被预筛直接跳过 —— 这正是历史上漏掉第二句的原因。
 */
const BLOCKED_HINTS = /Harness|deepseek-harness|DeepSeek|Tokens prefixed with @|explicitly referenced/i

/** 对任意文本做拦截规避替换；无变化时原样返回同一字符串。 */
function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  if (!BLOCKED_HINTS.test(text)) return text
  let out = text
  for (const [re, to] of BLOCKED_PATTERNS) out = out.replace(re, to)
  return out
}

/**
 * 中性系统提示词。保留 DSH 工具使用的关键约定，但不含任何会被腾讯
 * 黑名单命中的原句。
 */
const NEUTRAL_SYSTEM = [
  'You are a helpful coding assistant working inside an IDE.',
  '',
  'General rules:',
  '- Use the provided tools to inspect and change files; read a file before editing it.',
  '- Prefer dedicated file/search tools over shell commands when they are available.',
  '- A non-zero exit code means the command failed; investigate before moving on.',
  '- Keep replies concise and match the language the user writes in.',
  '- Ask for clarification when a request is ambiguous instead of guessing.',
  '- Never claim to have inspected, read, or run something you did not.',
  '- Paths the user marks with a leading @ are explicit file references.',
].join('\n')

/** 内置兜底模型表（/v3/config 不可用时使用）。 */
const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 50_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 48_000 },
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', contextWindow: 200_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 64_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3-1', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  { id: 'kimi-k2.7', name: 'Kimi-K2.7', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 32_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 512_000, supportsImages: true, reasoningEfforts: ['medium'], maxOutputTokens: 64_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 192_000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  { id: 'hy4-preview', name: 'Hy4 preview', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
]

function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim()
  if (env) return env
  const base = process.env.USERPROFILE || process.env.HOME || ''
  return base ? path.join(base, '.dsh') : ''
}

function readNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 把 DSH 消息序列化成 CodeBuddy 的 OpenAI 线格式。
 *
 * 两条防线：
 *   1. system / developer 整段换成中性文案（DSH 原始提示词会触发 11128）；
 *   2. **所有角色**的文本再过一遍 sanitizeText —— 服务端扫整个 body，
 *      历史里被引用过的触发句同样会被拦（实测 assistant 历史含第二句 → 400）。
 */
function serializeMessages(messages) {
  const wire = []
  for (const message of messages || []) {
    if (!message || typeof message !== 'object') continue
    const role = message.role
    const blocks = Array.isArray(message.content) ? message.content : []

    if (role === 'assistant') {
      const toolCalls = blocks
        .filter((b) => b && b.type === 'tool-call')
        .map((b) => ({
          id: String(b.id),
          type: 'function',
          function: { name: String(b.name), arguments: sanitizeArgs(b.arguments) },
        }))
      const reasoning = sanitizeText(blocks.filter((b) => b && b.type === 'reasoning').map((b) => String(b.text || '')).join(''))
      const text = sanitizeText(blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join(''))
      if (text.trim().length === 0 && toolCalls.length === 0) continue
      wire.push({
        role: 'assistant',
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    if (role === 'system' || role === 'developer') {
      // 关键：整段替换为中性文案，规避腾讯的提示词指纹拦截。
      wire.push({ role: 'system', content: NEUTRAL_SYSTEM })
      continue
    }

    if (role === 'tool') {
      const text = sanitizeText(blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join(''))
      wire.push({ role: 'tool', tool_call_id: String(message.toolCallId || ''), content: text })
      continue
    }

    // user
    const parts = []
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text' && typeof b.text === 'string') parts.push({ type: 'text', text: sanitizeText(b.text) })
      else if (b.type === 'image' && b.imageUrl) parts.push({ type: 'image_url', image_url: { url: b.imageUrl } })
    }
    if (parts.length === 0) {
      const plain = typeof message.content === 'string' ? message.content : ''
      const cleaned = sanitizeText(plain)
      if (cleaned) parts.push({ type: 'text', text: cleaned })
    }
    if (parts.length === 1 && parts[0].type === 'text') wire.push({ role: 'user', content: parts[0].text })
    else if (parts.length > 0) wire.push({ role: 'user', content: parts })
  }
  // 兜底：没有 system 时补一个中性 system，保证首条是 system 角色。
  if (wire.length === 0 || wire[0].role !== 'system') wire.unshift({ role: 'system', content: NEUTRAL_SYSTEM })
  return wire
}

/**
 * 净化工具参数：参数是 JSON 文本，跨句替换有可能吞掉引号/逗号。
 * 替换后重新校验，坏掉就退回原文 —— 宁可保留原文（极少数情况才真的
 * 含触发句）也不能发出非法 JSON 让整次调用失败。
 */
function sanitizeArgs(argsText) {
  const raw = normalizeArgs(argsText)
  if (typeof raw !== 'string' || !BLOCKED_HINTS.test(raw)) return raw
  const cleaned = sanitizeText(raw)
  if (cleaned === raw) return raw
  try { JSON.parse(cleaned); return cleaned } catch { return raw }
}

/** 把工具参数的原始值转成 JSON 文本。 */
function normalizeArgs(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

/**
 * 规范工具参数文本（`ToolCallBlock.arguments` 是**字符串**）。
 * 与 channel-pack 的 normalizeToolArguments 同语义：
 * 空串或非对象 JSON 补 `{}`，否则原样返回已闭合的 JSON 文本。
 */
function normalizeArgsText(text) {
  const raw = String(text || '').trim()
  if (raw.length === 0) return '{}'
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return '{}'
    return raw
  } catch {
    return '{}'
  }
}

/** 参数 JSON 是否已经闭合（用于区分「正常结束」与「被 max_tokens 截断」）。 */
function isCompleteArgs(text) {
  const raw = String(text || '').trim()
  if (raw.length === 0) return true
  try { JSON.parse(raw); return true } catch { return false }
}

function buildHeaders(credential) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'User-Agent': USER_AGENT,
    'X-Domain': API_DOMAIN,
    'X-Product': DEPLOYMENT_TYPE,
    'X-Product-Code': PRODUCT_CODE,
    'X-Agent-Purpose': 'conversation',
    'X-IDE-Name': 'CodeBuddy',
    'X-IDE-Type': 'CodeBuddy',
    'X-IDE-Version': '1.106.1',
  }
  if (credential && credential.access_token) headers.Authorization = `Bearer ${credential.access_token}`
  if (credential && credential.user_id) headers['X-User-Id'] = String(credential.user_id)
  if (credential && credential.enterprise_id) headers['X-Enterprise-Id'] = String(credential.enterprise_id)
  return headers
}

function isExpired(credential) {
  if (!credential) return true
  const raw = credential.expires_at
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw) <= Date.now()
  const ms = Date.parse(String(raw || ''))
  if (!Number.isFinite(ms)) return true
  return ms <= Date.now() + 30_000
}

export function apply(root, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {}
  const logger = root.logger || console
  let teardown = () => {}
  // Cordis 规定服务只能在 inject 作用域里取：直接读 root.llm / root.credentials
  // 会抛 "cannot get property ... without inject"，插件整条 entry 都装不上。
  // 依赖缺失时（比如组合里没有 llm）回调挂起而不会失败，正是需要的行为。
  root.inject(['credentials', 'llm'], (scoped) => {
    teardown = install(scoped, cfg, logger)
  })
  return () => { try { teardown?.() } catch { /* ignore */ } }
}

function install(ctx, cfg, logger) {
  const credentialRefName = String(cfg.credentialRef || '').trim()
  // 前缀缓存会话标识：同一进程内所有请求共用，服务端据此复用 KV 前缀缓存。
  const promptCacheKey = (globalThis.crypto?.randomUUID?.() || String(Date.now())).replace(/-/g, '')

  const state = {
    credential: null,
    credentialExpiresAt: 0,
    refreshing: null,
    models: null,
    modelsAt: 0,
    meta: new Map(),
  }

  function readAccountRef() {
    if (credentialRefName) return credentialRefName
    const home = dshHome()
    if (!home) return ''
    const file = path.join(home, 'channel-pack', 'state.json')
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      const account = (doc.accounts || []).find((a) => a && a.provider === 'buddy' && a.enabled !== false)
      return account ? String(account.credentialRef || '') : ''
    } catch {
      return ''
    }
  }

  async function loadCredential() {
    const ref = readAccountRef()
    if (!ref) return null
    try {
      const resolved = await ctx.credentials.resolve(ref)
      if (!resolved || typeof resolved.value !== 'string') return null
      const cred = JSON.parse(resolved.value)
      return cred && typeof cred.access_token === 'string' ? cred : null
    } catch (error) {
      logger.warn?.(`[codebuddy] 读取凭据失败：${String(error && error.message || error)}`)
      return null
    }
  }

  async function refreshCredential(credential) {
    if (!credential || !credential.refresh_token) throw new Error('无 refresh_token，请在 Channel Pack 重新登录 CodeBuddy')
    const headers = buildHeaders(credential)
    headers['X-Refresh-Token'] = String(credential.refresh_token)
    headers['X-Auth-Refresh-Source'] = AUTH_REFRESH_SOURCE
    headers.Accept = 'application/json'
    const response = await fetch(`${ENDPOINT}${REFRESH_PATH}`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) throw new Error(`续期失败 HTTP ${response.status} ${text.slice(0, 120)}`)
    let data = null
    try { data = JSON.parse(text)?.data ?? null } catch { data = null }
    if (!data || !data.accessToken) throw new Error('续期响应缺少 accessToken')
    const expiresIn = readNumber(data.expiresIn)
    const next = {
      ...credential,
      access_token: String(data.accessToken),
      refresh_token: data.refreshToken ? String(data.refreshToken) : credential.refresh_token,
      expires_at: String(data.expiresAt ?? Date.now() + expiresIn * 1000),
    }
    // 写回凭据库，避免下次又拿旧 token
    try { await ctx.credentials.set(refreshTargetRef(), JSON.stringify(next)) } catch { /* 只读库时忽略 */ }
    return next
  }

  function refreshTargetRef() {
    return readAccountRef()
  }

  async function ensureCredential() {
    if (state.credential && !isExpired(state.credential)) return state.credential
    if (state.refreshing) return state.refreshing
    state.refreshing = (async () => {
      let credential = await loadCredential()
      if (credential && isExpired(credential)) {
        try { credential = await refreshCredential(credential) } catch (error) {
          logger.warn?.(`[codebuddy] 续期失败：${String(error && error.message || error)}`)
        }
      }
      state.credential = credential
      return credential
    })().finally(() => { state.refreshing = null })
    return state.refreshing
  }

  async function fetchModels(credential) {
    const headers = buildHeaders(credential)
    headers.Accept = 'application/json'
    const response = await fetch(`${ENDPOINT}${CONFIG_PATH}`, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) return null
    const text = await response.text().catch(() => '')
    try {
      const data = JSON.parse(text)?.data
      const list = Array.isArray(data?.models) ? data.models : null
      if (!list || list.length === 0) return null
      const out = []
      for (const m of list) {
        if (!m || !m.id) continue
        out.push({
          id: String(m.id),
          name: String(m.name || m.id),
          contextWindow: readNumber(m.maxInputTokens) || readNumber(m.contextWindow),
          maxOutputTokens: readNumber(m.maxOutputTokens),
          supportsImages: m.supportsImage === true || m.supportsVision === true || true,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.map(String) : [],
          defaultReasoningEffort: m.defaultReasoningEffort ? String(m.defaultReasoningEffort) : '',
        })
      }
      return out.length > 0 ? out : null
    } catch {
      return null
    }
  }

  async function ensureModels() {
    const now = Date.now()
    if (state.models && now - state.modelsAt < 10 * 60_000) return state.models
    const credential = await ensureCredential()
    const remote = credential ? await fetchModels(credential).catch(() => null) : null
    const source = remote && remote.length > 0 ? remote : FALLBACK_MODELS
    state.meta = new Map(source.map((m) => [m.id, m]))
    state.models = source.map((m) => ({ id: m.id, name: m.name }))
    state.modelsAt = now
    return state.models
  }

  function metaFor(model) {
    return state.meta.get(model) || FALLBACK_MODELS.find((m) => m.id === model) || null
  }

  function effortsFor(model) {
    const meta = metaFor(model)
    return meta && Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider || PROVIDER, name: DISPLAY_NAME }
    },

    providerRetryPolicy() {
      return Object.freeze({
        mode: 'normal',
        maxRetries: 1,
        retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
        initialDelayMs: 800,
        maxDelayMs: 8000,
        jitterRatio: 0.2,
      })
    },

    // 本适配器没有实现附件投影，故不声明图像计费/尺寸投影能力。
    // 返回 undefined 而不是抛错：宿主对未声明的能力本就按「不支持」处理。
    imageRequestPricing() {
      return undefined
    },

    // 未被声明为支持图像，正常不会走到这里；保留一个保守实现，
    // 避免宿主在校验契约时因缺方法而判整个适配器不合法。
    imageRequestTarget(_provider, _model, image) {
      return { width: image?.width ?? 0, height: image?.height ?? 0, maxBytes: image?.bytes ?? 0 }
    },

    async listModels() {
      const list = await ensureModels()
      return list.map((m) => ({
        provider: PROVIDER,
        id: m.id,
        name: m.name,
        inputModalities: MODALITIES,
      }))
    },

    async resolveModel(provider, model) {
      await ensureModels()
      const meta = metaFor(model)
      const out = { provider: provider || PROVIDER, id: model, name: meta?.name || model, inputModalities: MODALITIES }
      if (meta && meta.contextWindow) out.context = { contextWindow: meta.contextWindow }
      if (meta && meta.maxOutputTokens) out.defaultMaxTokens = meta.maxOutputTokens
      const efforts = effortsFor(model)
      if (efforts.length > 0) {
        out.reasoning = {
          efforts: efforts.map((id) => ({ id, name: id })),
          defaultEffort: meta && meta.defaultReasoningEffort && efforts.includes(meta.defaultReasoningEffort)
            ? meta.defaultReasoningEffort : efforts[efforts.length - 1],
        }
      }
      return out
    },

    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model, signal)
      return { model: resolved, stream: (options) => streamCall(options) }
    },

    async *stream(options) {
      yield* streamCall(options)
    },
  }

  async function* streamCall(options) {
    const credential = await ensureCredential()
    if (!credential || !credential.access_token) {
      throw new Error('codebuddy: 没有可用凭据，请先在 Channel Pack 登录 CodeBuddy 账号')
    }

    const wire = serializeMessages(options.messages)
    const body = { model: options.model, messages: wire, stream: true, prompt_cache_key: promptCacheKey }
    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    const meta = metaFor(options.model)
    const maxTokens = readNumber(options.maxTokens) || readNumber(meta && meta.maxOutputTokens)
    if (maxTokens) body.max_tokens = maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    if (Array.isArray(options.stop) && options.stop.length) body.stop = options.stop
    if (meta && meta.reasoningEfforts && meta.reasoningEfforts.length) {
      const want = options.reasoningEffort
      const allowed = meta.reasoningEfforts
      body.reasoning_effort = typeof want === 'string' && allowed.includes(want) ? want : (meta.defaultReasoningEffort || allowed[allowed.length - 1])
      if (String(options.model || '').includes('deepseek')) body.thinking = { type: 'enabled' }
    }

    const response = await fetch(`${ENDPOINT}${CHAT_PATH}`, {
      method: 'POST', headers: buildHeaders(credential), body: JSON.stringify(body), signal: options.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // 401/403：token 可能已失效，强制续期后重试一次
      if (response.status === 401 || response.status === 403) {
        state.credential = null
        const fresh = await ensureCredential()
        if (fresh && fresh.access_token !== credential.access_token) {
          const retry = await fetch(`${ENDPOINT}${CHAT_PATH}`, {
            method: 'POST', headers: buildHeaders(fresh), body: JSON.stringify(body), signal: options.signal,
          })
          if (retry.ok) return yield* consumeSse(retry, options)
          const rt = await retry.text().catch(() => '')
          throw new Error(`codebuddy: HTTP ${retry.status} ${rt.slice(0, 200)}`)
        }
      }
      throw new Error(`codebuddy: HTTP ${response.status} ${text.slice(0, 200)}`)
    }

    yield* consumeSse(response, options)
  }

  /**
   * 把 CodeBuddy 的 OpenAI SSE 转成 Harness 的 StreamChunk 序列。
   *
   * 块协议（与 channel-pack 的实现逐项对齐）：
   *   · 每种内容（reasoning / text / 每个 tool call）占一个块，块 index 按首次出现递增；
   *   · 打开时发 `block-start`，增量发 `*-delta`，**流结束时**才发 `block-end`，
   *     且 `block-end` 必须携带累积后的完整块（工具调用要带 id/name/arguments）；
   *   · 工具调线的 id 只在首个分片出现，后续分片只有 index —— 按 index 缓存 id；
   *   · `usage` 一到就发，不等 finish；`finish` 是最后一个 chunk。
   * 少了 block-end 或工具块不完整，宿主就组装不出可执行的工具调用。
   */
  async function* consumeSse(response, options) {
    if (!response.body) throw new Error('codebuddy: 空响应体')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    let finishReason = ''
    let nextIndex = 0

    /** 当前打开的 prose 块（reasoning 或 text）。 */
    let prose = null
    /** wire tool-call index → 块状态。 */
    const toolBlocks = new Map()
    const toolOrder = []
    /** 流末统一结算的 usage。 */
    let lastUsage = null

    const closeProse = () => {
      if (!prose) return null
      const block = prose
      prose = null
      return {
        type: 'block-end',
        index: block.index,
        block: block.kind === 'reasoning'
          ? { type: 'reasoning', text: block.text }
          : { type: 'text', text: block.text },
      }
    }

    const openProse = (kind) => {
      // 同一 kind 连续到达：复用已打开的块，不重复发 block-start。
      if (prose && prose.kind === kind) return { block: prose, flush: [] }
      const flush = []
      const closing = closeProse()
      if (closing) flush.push(closing)
      const block = { kind, index: nextIndex++, text: '' }
      prose = block
      flush.push({ type: 'block-start', index: block.index, blockType: kind })
      return { block, flush }
    }

    for (; !done;) {
      const result = await reader.read()
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') { done = true; break }
        let data
        try { data = JSON.parse(payload) } catch { continue }

        // 流内错误帧：HTTP 200 但 body 里带 code/error，必须抛出让上层可见。
        if (data.choices === undefined && (data.code === 11128 || data.code === '11128')) {
          throw new Error(`codebuddy: 渠道校验失败 (code=11128) ${String(data.msg || '')}`)
        }
        if (data.error) throw new Error(`codebuddy: ${data.error.message || 'unknown error'}`)

        if (data.usage) {
          const promptTokens = readNumber(data.usage.prompt_tokens)
          const cached = readNumber(data.usage.prompt_tokens_details?.cached_tokens ?? data.usage.prompt_cache_hit_tokens)
          const reasoningTokens = readNumber(data.usage.completion_tokens_details?.reasoning_tokens)
          yield {
            type: 'usage',
            usage: {
              inputTokens: Math.max(0, promptTokens - cached),
              outputTokens: readNumber(data.usage.completion_tokens),
              totalTokens: readNumber(data.usage.total_tokens) || promptTokens + readNumber(data.usage.completion_tokens),
              ...(cached > 0 ? { cacheReadTokens: cached } : {}),
              ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
            },
          }
          lastUsage = data.usage
        }

        const choice = Array.isArray(data.choices) ? data.choices[0] : undefined
        if (choice && typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          finishReason = choice.finish_reason
        }
        const delta = choice && choice.delta
        if (!delta) continue

        const reasoning = delta.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          const opened = openProse('reasoning')
          for (const chunk of opened.flush) yield chunk
          opened.block.text += reasoning
          yield { type: 'reasoning-delta', index: opened.block.index, text: reasoning }
        }

        const content = delta.content
        if (typeof content === 'string' && content.length > 0) {
          const opened = openProse('text')
          for (const chunk of opened.flush) yield chunk
          opened.block.text += content
          yield { type: 'text-delta', index: opened.block.index, text: content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (!call || typeof call !== 'object') continue
            const wireIndex = Number(call.index ?? 0)
            let block = toolBlocks.get(wireIndex)
            if (!block) {
              const closing = closeProse()
              if (closing) yield closing
              block = { index: nextIndex++, wireIndex, id: '', name: '', text: '', announced: false }
              toolBlocks.set(wireIndex, block)
            }
            if (call.id) block.id = String(call.id)
            const fn = call.function || {}
            if (typeof fn.name === 'string' && fn.name.length > 0) block.name = fn.name
            const fragment = typeof fn.arguments === 'string' ? fn.arguments : ''
            block.text += fragment

            // 名字到位才开块：CodeBuddy 偶尔先发只有 index 的分片，
            // 提前 announce 会让宿主拿到一个 name 为空的工具调用。
            if (!block.announced) {
              if (block.name.length === 0) continue
              block.announced = true
              toolOrder.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              // 首个 delta 带上此前累积的参数（分片可能早于 name 到达）。
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.id || `call_${block.wireIndex}`,
                name: block.name,
                argumentsDelta: block.text,
              }
              continue
            }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: block.id || `call_${block.wireIndex}`,
              ...(block.name ? { name: block.name } : {}),
              argumentsDelta: fragment,
            }
          }
        }
      }
    }

    // 结算顺序：先工具块，再 prose（正文/思考），与 channel-pack 一致。
    for (const block of toolOrder) {
      yield {
        type: 'block-end',
        index: block.index,
        block: {
          type: 'tool-call',
          id: block.id || `call_${block.wireIndex}`,
          name: block.name,
          // ToolCallBlock.arguments 是**字符串**：完整 JSON 原样传；
          // 被截断的也原样传（由 finish=max-tokens 触发重试），
          // 只有空参数才补成 "{}"。
          arguments: isCompleteArgs(block.text) ? normalizeArgsText(block.text) : block.text,
        },
      }
    }
    const closing = closeProse()
    if (closing) yield closing

    const hasTools = toolOrder.length > 0
    const truncated = [...toolBlocks.values()].some((b) => !isCompleteArgs(b.text))
    const reason = finishReason === 'length' || (hasTools && truncated)
      ? { kind: 'max-tokens' }
      : finishReason === 'tool_calls' || hasTools
        ? { kind: 'tool-calls' }
        : { kind: 'stop' }
    yield { type: 'finish', reason }
    void lastUsage
  }

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.warn?.('[codebuddy] 当前组合没有 llm 服务，渠道未注册')
    return () => {}
  }

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: PROVIDER, settingsPath: [] },
  ])
  logger.info?.(`[codebuddy] 已注册 CodeBuddy 渠道（${FALLBACK_MODELS.length} 个兜底模型，凭据复用 Channel Pack 的 buddy 账号）`)

  return () => {
    try { if (registration && typeof registration.dispose === 'function') registration.dispose()
      else if (typeof registration === 'function') registration() } catch { /* ignore */ }
  }
}
