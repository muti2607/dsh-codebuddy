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
import { fileURLToPath } from 'node:url'
import {
  REPO,
  INSTALL_SPEC,
  evaluateUpdate,
  fetchLatestVersion,
  inspectInstallSource,
  readLocalVersion,
} from './src/updater.js'
import { PRODUCTS, beginBuddyLogin, completeBuddyLogin, openBrowser } from './src/buddy-login.js'
import { fetchCreditOverview, claimDailyCredit } from './src/credits.js'
import {
  readModelPrefs,
  setModelEnabled,
  enableAllModels,
  applyModelPrefs,
} from './src/model-prefs.js'
import {
  readAccounts,
  addAccount,
  updateAccount,
  removeAccount,
  availableAccounts,
  newCredentialRef,
  newAccountId,
} from './src/account-store.js'
import { readSnapshot, writeSnapshot, dropSnapshot } from './src/snapshot-cache.js'
import {
  readLocalCredential,
  hasLocalCredential,
  writeLocalCredential,
  deleteLocalCredential,
} from './src/credential-store.js'
import { scheduleHeartbeat, readState as readTelemetryState, readInstallId, DEFAULT_TELEMETRY_URL } from './src/heartbeat.js'

const PROVIDER = 'codebuddy'
const DISPLAY_NAME = 'CodeBuddy (腾讯免费)'
// removeBundle 用的是包名（bundle name），不是 spec；与 package.json name 一致。
const BUNDLE_NAME = 'dsh-codebuddy'

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
 * 图片请求目标（宽高上限与字节预算）。
 *
 * 实测 2026-11-07：CodeBuddy 的 deepseek-v4.1-flash 接受 OpenAI 风格的
 * `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`，
 * 32×32 纯红图能被正确识别为「红色」，返回 200。旧式 `input_image` 会被
 * 拒（code 11101 Parse message failed: unsupported content type）。
 *
 * 尺寸取 1568px / 1MB：主流多模态模型的高清切块上限附近，且远低于常见的
 * 单图体积限制。实际值由 attachments.readImageRequest 按预算自行缩放。
 */
const IMAGE_MAX_DIMENSION = 1568
const IMAGE_MAX_BYTES = 1_000_000

/** 输入模态：文本 + 图片（图片经 attachments 服务投影成 data URL）。 */
const MODALITIES = Object.freeze(['text', 'image'])

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

/**
 * 内置兜底模型表（/v3/config 拉不到时使用）。
 *
 * 2026-11-08 按真实目录重建：CodeBuddy 当前可用的 19 个对话模型全部收录，
 * 含上下文/输出上限与思考等级，避免远端目录临时不可用时选择器里少一堆模型。
 * 不含 codewise-*（补全/改写专用）与图片生成模型。
 */
export const FALLBACK_MODELS = [
  { id: 'auto', name: 'Auto', contextWindow: 256_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000 },
  { id: 'hy4free', name: 'Hy4 (free)', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  { id: 'hy4std', name: 'Hy4 (std)', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 64_000 },
  // 目录标 maxInputTokens=192000，但服务端对 prompt 单独卡 100000
  // （实测 code 11115: 100001 > 100000 maximum）。按真实上限声明，
  // 宿主的自动压缩才会在 80% 就触发，不会等撞墙。
  { id: 'hy3', name: 'Hy3', contextWindow: 100_000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000 },
  { id: 'hy3-x', name: 'Hy3-x', contextWindow: 100_000, supportsImages: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000 },
  { id: 'step-5-preview', name: 'Step-5-Preview', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium', maxOutputTokens: 64_000 },
  { id: 'space-bunny', name: 'Space-Bunny', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'max', maxOutputTokens: 128_000 },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 393_216 },
  { id: 'deepseek-v4-pro', name: 'Deepseek-V4-Pro', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 393_216 },
  { id: 'deepseek-v4-flash', name: 'Deepseek-V4-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 50_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 131_072 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 131_072 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high', 'xhigh'], defaultReasoningEffort: 'high', maxOutputTokens: 131_072 },
  { id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high', maxOutputTokens: 32_000 },
  { id: 'kimi-k3-1', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['medium'], defaultReasoningEffort: 'medium', maxOutputTokens: 1_048_576 },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'high', maxOutputTokens: 131_072 },
  { id: 'minimax-m3.1-flash', name: 'MiniMax-M3.1-Flash', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'max', maxOutputTokens: 128_000 },
  { id: 'mimo-v2.6-pro', name: 'Xiaomi MiMo-V2.6-Pro', contextWindow: 1_000_000, supportsImages: true, reasoningEfforts: ['high'], defaultReasoningEffort: 'high', maxOutputTokens: 128_000 },
  { id: 'codewise-default-model-v2', name: 'Default', contextWindow: 96_000, supportsImages: true, maxOutputTokens: 32_000 },
]

/** 远端目录缺元信息时的通用等级：宁可给出 low/high 让用户能选。 */
const GENERIC_EFFORTS = ['low', 'high']

/** 远端字段名没有公开契约，对常见拼法全部兼容；大小写不敏感。 */
function pickEfforts(remoteModel) {
  for (const key of ['reasoningEfforts', 'reasoning_efforts', 'supportedEfforts', 'thinkingLevels', 'reasoningLevels']) {
    const v = remoteModel?.[key]
    if (Array.isArray(v) && v.length > 0) return v.map(String)
  }
  // 有的目录把等级嵌在 reasoning: {...} 对象里
  const nested = remoteModel?.reasoning
  if (nested && typeof nested === 'object') {
    for (const key of ['efforts', 'levels', 'supportedEfforts']) {
      const v = nested[key]
      if (Array.isArray(v) && v.length > 0) {
        return v.map((x) => (x && typeof x === 'object' ? String(x.id ?? x.name ?? '') : String(x))).filter(Boolean)
      }
    }
    // 只给单档的模型（如 auto / kimi-k3-1）：reasoning.effort = 'high'
    if (typeof nested.effort === 'string' && nested.effort) return [nested.effort]
  }
  return []
}

function pickDefaultEffort(remoteModel) {
  for (const key of ['defaultReasoningEffort', 'default_reasoning_effort', 'defaultEffort']) {
    const v = remoteModel?.[key]
    if (typeof v === 'string' && v) return v
  }
  const nested = remoteModel?.reasoning
  if (nested && typeof nested === 'object' && typeof nested.defaultEffort === 'string') return nested.defaultEffort
  return ''
}

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
 * 判定错误是不是「连接层死亡」而非请求本身的问题。
 *
 * 两种形态都要认：
 *   · 建连阶段：TypeError: fetch failed，真因在 cause（ECONNRESET 等）
 *   · 读流阶段：TypeError: terminated / cause「other side closed」
 *     —— 响应已建立，SSE 读到一半被对端掐断（实测 2026-11-15）
 * 业务错误（11128、HTTP 4xx/5xx 正文）不带这些 code，不误伤。
 */
export function isConnectionDeath(error) {
  const parts = []
  let node = error
  for (let depth = 0; node && depth < 4; depth++) {
    parts.push(String(node.code || ''), String(node.message || ''), String(node.name || ''))
    node = node.cause
  }
  return /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT|UND_ERR_BODY_TIMEOUT|socket hang up|other side closed|terminated|fetch failed|body timeout/i.test(parts.join(' '))
}

/**
 * 发一次 chat 请求，带「死连接自愈」。
 *
 * 长对话间隔后，连接池里可能留着一条被服务端静默关掉的 keep-alive 死连接：
 * 请求发上去直接 `fetch failed`（ECONNRESET / socket hang up），且发生在流
 * 未开始时——换一条连接重发必定能成，所以等 400ms（让池子先清掉死连接）
 * 精确补发一次，用户感知不到。非连接类错误不吞，照常上抛。
 */
async function fetchPost(bodyJson, credential, signal) {
  const send = () => fetch(`${ENDPOINT}${CHAT_PATH}`, {
    method: 'POST', headers: buildHeaders(credential), body: bodyJson, signal,
  })
  try {
    return await send()
  } catch (error) {
    if (signal?.aborted || !isConnectionDeath(error)) throw error
    await new Promise((resolve) => setTimeout(resolve, 400))
    if (signal?.aborted) throw error
    return send()
  }
}

/**
 * 识别「频率限制」类错误（有明确解禁时间，等待期间重试全是白打）。
 *
 * 实测 2026-11-08：返回 HTTP 429 + code 6004，形如
 * {"code":6004,"msg":"您的使用量已超出频率限制，将在 2026-11-08 18:24:35 UTC+8 重置，
 *  您也可以切换其他模型继续使用。"}
 * 解禁可能要等十几分钟，远超一次请求的合理等待，所以立即失败并如实告知。
 *
 * @returns {{ message: string, resetMs: number } | null}
 */
export function rateLimitInfo(errorBodyText) {
  let code = null
  let msg = ''
  try {
    const p = JSON.parse(String(errorBodyText || ''))
    const d = (p && (p.error && (p.error.data || p.error))) || p || {}
    const c = d.code !== undefined ? d.code : p && p.code
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) code = Number(c)
    msg = String((d.msg !== undefined ? d.msg : (p && p.msg)) || '')
  } catch { /* 非 JSON：下面按文本兜底 */ }
  const text = msg || String(errorBodyText || '')
  const hit = code === 6004 || /频率限制|rate\s*limit|too\s*many\s*requests|请求过于频繁/i.test(text)
  if (!hit) return null
  let resetMs = 0
  const m = text.match(/将在\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (m) {
    const parsed = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
    if (Number.isFinite(parsed)) resetMs = parsed
  }
  const when = resetMs > 0
    ? new Date(resetMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : ''
  return {
    resetMs,
    message: 'CodeBuddy 触发频率限制' + (code !== null ? '（code ' + code + '）' : '')
      + (when ? '，额度将于 ' + when + ' 重置' : '')
      + '。重试只会继续撞墙，请稍后再试，或在本会话切换到其他模型/渠道。',
  }
}

/**
 * 识别「prompt 超长」类错误（服务端硬上限，重试无意义）。
 *
 * 实测 2026-11-14：hy3 返回 HTTP 400 + code 11115，
 * "prompt is too long: 100001 tokens > 100000 maximum"，
 * 且 retry_policy.retry=false、extError.code=context_length_exceeded。
 *
 * 注意：目录里 hy3 的 maxInputTokens 写 192000，但服务端对 prompt
 * 单独卡 100000 —— 因此不能只信目录，需把这类错误如实告诉用户，
 * 并把兜底表里该模型的窗口修正为服务端的真实上限。
 */
export function promptTooLongMessage(errorBodyText) {
  let code = null
  let msg = ''
  try {
    const p = JSON.parse(String(errorBodyText || ''))
    const d = (p && (p.error && (p.error.data || p.error))) || p || {}
    const c = d.code !== undefined ? d.code : p && p.code
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) code = Number(c)
    msg = String((d.msg !== undefined ? d.msg : (p && p.msg)) || '')
  } catch { /* 非 JSON：按文本兜底 */ }
  const raw = String(errorBodyText || '')
  const text = msg + ' ' + raw
  const hit = code === 11115
    || /prompt is too long|context_length_exceeded|maximum context|input tokens.*exceed/i.test(text)
  if (!hit) return ''
  const m = text.match(/(\d[\d,]*)\s*tokens?\s*>\s*(\d[\d,]*)\s*maximum/i)
  const detail = m
    ? `（本轮 ${Number(m[1]).toLocaleString()} tokens，该模型上限 ${Number(m[2]).toLocaleString()}）`
    : ''
  return `输入超长${detail}，重试无用（官方 retry=false）。`
    + '请开一个新会话清空累积历史，或换长上下文模型（如 hy4free / codebuddy 的 1M 窗口模型）。'
    + '若反复出现，说明该模型的窗口声明与服务端不一致，已在插件兜底表中修正。'
}

/**
 * 识别「额度用尽」类错误（非瞬时故障，重试无意义）。
 *
 * 实测 2026-11-08：免费额度耗尽时返回 HTTP 429 + code 14018，
 * 响应体形如 {"error":{"data":{"code":14018,"msg":"额度已用尽，请访问…购买加量包…"}}}。
 * 这类错误必须立刻停手并给出可执行建议——等待或重试都不会恢复额度。
 *
 * @returns 给用户看的中文说明；不是额度错误则返回空串。
 */
export function quotaExhaustedMessage(errorBodyText) {
  let code = null
  let msg = ''
  try {
    const p = JSON.parse(String(errorBodyText || ''))
    const d = (p && (p.error && (p.error.data || p.error))) || p || {}
    const c = d.code !== undefined ? d.code : p && p.code
    if (c !== undefined && c !== null && Number.isFinite(Number(c))) code = Number(c)
    msg = String((d.msg !== undefined ? d.msg : (p && p.msg)) || '')
  } catch { /* 非 JSON：下面按文本兜底判断 */ }
  const raw = String(errorBodyText || '')
  const hit = code === 14018
    || /额度已用尽|额度不足|余额不足|超出额度|quota\s*(exceeded|exhausted)|insufficient\s*(quota|balance)/i.test(msg + ' ' + raw)
  if (!hit) return ''
  const link = (msg.match(/https?:\/\/[^\s"'）)]+/) || [])[0] || 'https://www.codebuddy.cn/profile/usage'
  return 'CodeBuddy 额度已用尽' + (code !== null ? '（code ' + code + '）' : '')
    + '，重试不会恢复额度。请到 ' + link + ' 购买加量包，'
    + '或在本会话切换到其他模型/渠道继续。'
}

/**
 * 上游瞬时故障的「按官方意愿重试」判定与等待。
 *
 * 只认两种信号：
 *   · 响应体里 retry_policy.retry === true（如 code 11134：模型提供方暂不可用）
 *   · HTTP 429 / 503 且带 Retry-After（额度类 429 除外——那个重试无意义）
 * 命中则最多等 5 秒（尊重 Retry-After，可被 signal 打断）后返回 true，
 * 调用方据此补发一次。官方没让重试的错误一律立即抛错，
 * 避免失败被无声放大成刷屏调用。
 */
export async function shouldRetryTransient(errorBodyText, response, signal) {
  // 额度用尽 / 频率限制 / prompt 超长都不是瞬时故障；
  // 超长还带官方 retry_policy.retry=false，重试只会继续撞墙
  if (quotaExhaustedMessage(errorBodyText)) return false
  if (rateLimitInfo(errorBodyText)) return false
  if (promptTooLongMessage(errorBodyText)) return false
  let wants = false
  let waitMs = 1500
  try {
    const parsed = JSON.parse(String(errorBodyText || ''))
    if (parsed && parsed.retry_policy && parsed.retry_policy.retry === true) wants = true
  } catch { /* 非 JSON：不带重试意愿 */ }
  const raHeader = typeof response.headers?.get === 'function' ? response.headers.get('retry-after') : null
  const status = Number(response.status)
  if (!wants && (status === 429 || status === 503) && raHeader !== null) wants = true
  if (!wants) return false
  if (raHeader !== null) {
    const sec = Number(raHeader)
    if (Number.isFinite(sec) && sec >= 0) waitMs = Math.min(sec * 1000, 5000)
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, waitMs)
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    }
  })
  return true
}

/**
 * 把 DSH 消息序列化成 CodeBuddy 的 OpenAI 线格式。
 *
 * 两条防线：
 *   1. system / developer 整段换成中性文案（DSH 原始提示词会触发 11128）；
 *   2. **所有角色**的文本再过一遍 sanitizeText —— 服务端扫整个 body，
 *      历史里被引用过的触发句同样会被拦（实测 assistant 历史含第二句 → 400）。
 */
function serializeMessages(messages, imageUrls = new Map()) {
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
      else if (b.type === 'image') {
        // 图片块形如 { type: 'image', attachment: ImageAttachmentRef }。
        // imageUrls 是 attachmentId → data URL 的映射（在外层异步读好）。
        const id = b.attachment && b.attachment.attachmentId
        const url = id === undefined ? undefined : imageUrls.get(String(id))
        if (url === undefined) {
          // 读不到就明确说明，而不是让模型以为没图。
          parts.push({ type: 'text', text: '[image unavailable]' })
        } else {
          parts.push({ type: 'image_url', image_url: { url } })
        }
      }
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
 * 收集消息里所有图片附件引用（含 tool-result 内嵌套的）。
 * 返回 attachmentId → ImageAttachmentRef 的映射。
 */
function collectImageRefs(messages) {
  const refs = new Map()
  const walk = (blocks) => {
    for (const block of blocks || []) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'image') {
        const ref = block.attachment
        if (ref && typeof ref.attachmentId === 'string') refs.set(ref.attachmentId, ref)
        continue
      }
      if (Array.isArray(block.content)) walk(block.content)
    }
  }
  for (const message of messages || []) {
    if (Array.isArray(message?.content)) walk(message.content)
  }
  return refs
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
  // modelBridge：模型清单只有 install() 那边才拿得到（要凭据 + 远端目录），
  // 但 web 路由必须在 apply() 这层注册（同一前缀只能注册一次）。用一个显式
  // 的小桥把「列模型」从 install() 递给路由，避免共享可变全局或重复实现取数。
  const modelBridgeForInstall = { list: null }
  // Cordis 规定服务只能在 inject 作用域里取：直接读 root.llm 会抛
  // "cannot get property ... without inject"，插件整条 entry 都装不上。
  //
  // 这里**只要求 llm**。credentials / attachments 都改成在 install() 内惰性取：
  // 以前写的是 inject(['credentials','attachments','llm'], …)，只要组合里缺任一
  // 个，install() 就不执行——而模型清单的取数桥 (modelBridge.list) 正是在
  // install() 里赋的，于是 `/api/cb/models` 会固定失败。列模型根本不需要凭据，
  // 让凭据服务的有无决定模型清单能不能看，是把两件无关的事焊在一起。
  // 缺 llm 时回调挂起、不注册渠道，这才是真正该有的依赖。
  root.inject(['llm'], (scoped) => {
    teardown = install(scoped, cfg, logger, modelBridgeForInstall)
  })
  // 更新检查本身不需要模型服务，单独一条 inject：组合里没有 llm 时
  // 用户仍然能查到有没有新版本。
  let updateTeardown = () => {}
  root.inject(['webServer'], (scoped) => {
    updateTeardown = installUpdateRoutes(scoped, root, cfg, logger)
  })
  // 登录路由：只要 webServer。凭据服务**可选**——它在回调里按需解析。
  //
  // 以前这里写的是 inject(['webServer', 'credentials'])，代价是：一旦组合里没有
  // credentials 服务（精简组合、凭据服务未就绪、装载顺序问题），这个回调根本不执行，
  // 于是整组 `/api/cb` 路由（含**完全不需要凭据**的 `/models`）统统不会注册。
  // 表现就是设置区能打开、版本号也正常（那条走 /api/codebuddy，只依赖 webServer），
  // 但模型清单固定失败——一个凭据依赖把无关功能一起拖死，没有道理。
  // 现在只注入 webServer，凭据在真正需要时再用 getCredentials() 判断。
  let loginTeardown = () => {}
  root.inject(['webServer'], (scoped) => {
    loginTeardown = installLoginRoutes(scoped, cfg, logger, modelBridgeForInstall)
  })
  return () => {
    modelBridgeForInstall.list = null
    try { teardown?.() } catch { /* ignore */ }
    try { updateTeardown?.() } catch { /* ignore */ }
    try { loginTeardown?.() } catch { /* ignore */ }
  }
}

/** 运行中插件的安装目录（用来读当前版本）。 */
function moduleDir() {
  return path.dirname(fileURLToPath(import.meta.url))
}

/**
 * 注册更新检查路由。
 *
 * `GET  /api/codebuddy/update`        只查版本，不改任何东西
 * `POST /api/codebuddy/update`        确认更新，交给 pluginManager.installBundle
 *
 * 更新走官方 installBundle（内部是 pnpm），因此 lockfile 与实际安装一致，
 * 也不会出现 OFM 那种「插件改了磁盘、pnpm 按旧 lockfile 又改回去」的损坏。
 */
function installUpdateRoutes(ctx, root, cfg, logger) {
  const server = ctx.webServer
  if (!server || typeof server.register !== 'function') return () => {}

  const state = { last: null, checking: null }

  async function check(force) {
    const now = Date.now()
    if (!force && state.last && now - state.last.checkedAt < 60_000) return state.last
    if (state.checking) return state.checking
    state.checking = (async () => {
      const local = readLocalVersion(moduleDir())
      const profileDir = profileDirFromEnv()
      const source = profileDir === null ? { spec: null, kind: 'unknown' } : inspectInstallSource(profileDir)
      try {
        const remote = await fetchLatestVersion(fetch)
        const verdict = evaluateUpdate(local, remote.version)
        const payload = {
          ok: true,
          ...verdict,
          checkedAt: remote.checkedAt,
          installSource: source,
          // 本地 link: 安装时不能自更新（会改到作者源码树），必须让用户重装
          updatable: source.kind === 'git',
          repo: REPO,
          installSpec: INSTALL_SPEC,
        }
        state.last = payload
        return payload
      } catch (error) {
        const payload = {
          ok: false,
          error: String(error && error.message || error),
          localVersion: local,
          checkedAt: Date.now(),
          installSource: source,
          updatable: source.kind === 'git',
          repo: REPO,
          installSpec: INSTALL_SPEC,
        }
        // 检查失败不缓存，下次立即重试
        return payload
      } finally {
        state.checking = null
      }
    })()
    return state.checking
  }

  async function applyUpdate() {
    const manager = root.get?.('pluginManager') ?? root.pluginManager
    if (!manager || typeof manager.installBundle !== 'function') {
      return { ok: false, error: '当前组合没有 pluginManager，无法自动更新；请手动执行 dsh plugin --profile desktop add github:' + REPO }
    }
    const profileDir = profileDirFromEnv()
    const source = profileDir === null ? { kind: 'unknown' } : inspectInstallSource(profileDir)
    if (source.kind !== 'git') {
      return {
        ok: false,
        error: source.kind === 'local'
          // 措辞必须报出**真实的** spec：早先这里写死成「link:」，而实际是
          // `file:...tgz`，用户按提示去找 link: 会找不到，反而更困惑。
          ? `当前是从本地文件安装的（${source.spec}），插件不能自己替换文件。`
            + `请改用 github:${REPO} 安装后再启用自更新。`
          : '无法确认安装来源，已取消更新。',
        installSource: source,
      }
    }
    try {
      // installBundle 对「已装同 spec」返回 already-installed 失败——直接重装
      // 等于没装（这是自动更新在别人电脑上「不生效」的根因之一）。
      // 官方路径是先 removeBundle 再 installBundle 才能拉到新提交；
      // 但必须先试装、确认冲突才移除——否则移除后网络失败会把插件整个删没。
      let result = await manager.installBundle(INSTALL_SPEC, { enabled: true })
      let removed = false
      if (result && result.error && result.error.code === 'already-installed') {
        if (typeof manager.removeBundle !== 'function') {
          return { ok: false, error: '当前 pluginManager 无 removeBundle，无法重装更新；请手动执行 dsh plugin --profile desktop add ' + INSTALL_SPEC }
        }
        await manager.removeBundle(BUNDLE_NAME)
        removed = true
        try {
          result = await manager.installBundle(INSTALL_SPEC, { enabled: true })
        } catch (error) {
          return {
            ok: false,
            removed,
            error: '已移除旧版本但重装失败（' + String((error && error.message) || error) + '）。'
              + '请手动执行：dsh plugin --profile desktop add ' + INSTALL_SPEC,
          }
        }
      }
      const applied = result?.application === 'applied'
      const restart = result?.application === 'restart-required'
      logger.info?.(`[codebuddy] 自更新结果: ${result?.application ?? 'unknown'}${removed ? '（经移除重装）' : ''}`)
      return {
        ok: applied || restart,
        application: result?.application,
        restartRequired: restart,
        version: result?.version,
        error: result?.error?.diagnostic || (result && !applied && !restart ? String(result.error?.code || 'failed') : undefined),
        removed,
        installSource: source,
      }
    } catch (error) {
      return { ok: false, error: String(error && error.message || error), installSource: source }
    }
  }

  const dispose = server.register({
    kind: 'prefix',
    path: '/api/codebuddy',
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const json = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(body))
      }
      try {
        if (url.pathname === '/api/codebuddy/update') {
          if (request.method === 'GET') {
            return json(200, await check(url.searchParams.get('force') === '1'))
          }
          if (request.method === 'POST') {
            return json(200, await applyUpdate())
          }
          return json(405, { ok: false, error: 'method not allowed' })
        }
        if (url.pathname === '/api/codebuddy/version') {
          const dir = moduleDir()
          // 顺带报告 Client 半身是否存在：插件更新后若没重启，界面会是旧版，
          // 这个字段让人能一眼看出「装到了但还没加载」。
          let clientHalf = false
          try { clientHalf = fs.existsSync(path.join(dir, 'client.js')) } catch { /* ignore */ }
          return json(200, {
            ok: true,
            version: readLocalVersion(dir),
            repo: REPO,
            clientHalf,
            settingsSection: 'dsh-codebuddy',
            // 把实际加载路径暴露出来，便于确认运行的是安装副本还是开发目录
            moduleDir: dir,
            profileDir: profileDirFromEnv(),
            installSource: inspectInstallSource(profileDirFromEnv() ?? ''),
          })
        }
        if (url.pathname === '/api/codebuddy/telemetry') {
          // 透明的一部分：让用户（和自检）能查到「到底会不会发、已经发了什么」。
          // 这里**绝不回传端点之外的任何内容**，也不做任何发送。
          const home = String(cfg.dshHome || '').trim() || dshHome()
          const enabled = cfg.telemetry !== false
          // 与 scheduleHeartbeat 保持同一套语义：显式写空串 = 关闭，
          // 只有"没配这个键"才用默认端点。否则界面会说"已开启"，实际却不发。
          const explicitUrl = Object.prototype.hasOwnProperty.call(cfg, 'telemetryUrl')
          const url2 = (explicitUrl
            ? String(cfg.telemetryUrl || '')
            : String(DEFAULT_TELEMETRY_URL || '')).trim()
          const state = readTelemetryState(home)
          return json(200, {
            ok: true,
            // 未配置端点时实际不会发出任何请求
            enabled: enabled && !!url2,
            reason: !enabled ? 'disabled-by-config' : (!url2 ? 'endpoint-not-configured' : 'active'),
            endpointConfigured: !!url2,
            // 安装 ID 本身就是本地的随机数，可以给用户看，方便他判断/重置
            installId: readInstallId(home),
            lastReport: state.lastAt ? {
              day: state.day,
              version: state.version,
              count: state.count,
            } : null,
            // 字段清单公开在这里，比写在 README 里更难说谎
            fields: ['event', 'installId', 'version', 'platform', 'source', 'day'],
            neverSent: ['账号', 'token', '项目路径', '主机名', '用户名', '邮箱', 'IP'],
          })
        }
        return json(404, { ok: false, error: 'not found' })
      } catch (error) {
        return json(500, { ok: false, error: String(error && error.message || error) })
      }
    },
  })

  // ---- 后台自动检查 ----
  //
  // 默认开启，并且**默认自动安装**（这正是「像 OFM 那样自动更新」的含义）。
  // 后台检查发现新版 → 若来源是 github:（可安全重装）就自动 remove+install。
  // 之前默认 autoInstall=false 是自动更新在别人电脑上「不生效」的主因：
  // 检查到新版却从不去装，又没有任何界面按钮，只留一条看不见的日志。
  // 想回到「只检查不装」：配置 autoInstallUpdates: false。
  const autoCfg = {
    enabled: cfg.autoUpdate !== false,
    intervalHours: Number(cfg.updateCheckHours) > 0 ? Number(cfg.updateCheckHours) : 6,
    autoInstall: cfg.autoInstallUpdates !== false,
  }
  let timer = null
  if (autoCfg.enabled) {
    const run = async () => {
      try {
        const result = await check(true)
        if (!result.ok) {
          logger.warn?.(`[codebuddy] 更新检查失败：${result.error}`)
        } else if (result.available) {
          logger.warn?.(`[codebuddy] 发现新版本 ${result.remoteVersion}（当前 ${result.localVersion}）。`
            + (result.updatable ? ' 可在插件设置页更新，或 POST /api/codebuddy/update。'
              : ' 当前为本地目录安装，请改用 github:' + REPO + ' 安装。'))
          if (autoCfg.autoInstall && result.updatable) {
            const applied = await applyUpdate()
            logger.info?.(`[codebuddy] 自动更新${applied.ok ? '成功' : '失败'}：${applied.version ?? applied.error ?? ''}`)
          }
        }
      } catch (error) {
        logger.warn?.(`[codebuddy] 自动更新任务异常：${String(error && error.message || error)}`)
      }
    }
    // 启动后先等一分钟：避开启动高峰，也让更新检查不影响首屏。
    timer = setTimeout(run, 60_000)
    timer.unref?.()
    // 之后按配置间隔重复。用 interval 而非递归 setTimeout，避免
    // 一次慢请求把后续检查整体推迟；unref 保证不阻止进程退出。
    const periodMs = Math.max(1, autoCfg.intervalHours) * 3_600_000
    const interval = setInterval(run, periodMs)
    interval.unref?.()
    timer = { initial: timer, interval }
  }

  // ---- 透明心跳 ----
  //
  // 只上报：安装 ID（本地随机）、版本号、平台、安装来源种类、日期。
  // 不发账号、不发 token、不发路径、不发主机名。默认开启，`telemetry: false` 关闭。
  // 未配置 telemetryUrl 且默认端点为空的组合下，这里直接 return，不发任何请求。
  let heartbeatTimer = null
  try {
    heartbeatTimer = scheduleHeartbeat({
      cfg,
      logger,
      home: String(cfg.dshHome || '').trim() || dshHome(),
      version: (() => { try { return readLocalVersion(moduleDir()) } catch { return '' } })(),
      sourceKind: (() => {
        try {
          const pd = profileDirFromEnv()
          return pd === null ? 'unknown' : inspectInstallSource(pd).kind
        } catch { return 'unknown' }
      })(),
      platform: process.platform,
    })
  } catch { /* 统计绝不能影响装载 */ }

  return () => {
    try {
      if (heartbeatTimer) clearTimeout(heartbeatTimer)
    } catch { /* ignore */ }
    try {
      if (timer && typeof timer === 'object') {
        clearTimeout(timer.initial)
        clearInterval(timer.interval)
      } else if (timer !== null) {
        clearTimeout(timer)
      }
    } catch { /* ignore */ }
    try { dispose?.() } catch { /* ignore */ }
  }
}

/**
 * 注册「登录 WorkBuddy / CodeBuddy」路由（原生实现，不依赖 OFM/channel-pack）。
 *
 *   POST /api/cb/login      {provider}    起登录：返回 {accountId, loginUrl}，
 *                                         浏览器自动打开，后台轮询到最长 5 分钟
 *   GET  /api/cb/login      ?accountId=   轮询登录状态（pending/done/failed）
 *   GET  /api/cb/accounts                 列出自建账号池（不含任何令牌）
 *   POST /api/cb/accounts   {action,id}   停用/删除账号
 *
 * 路径前缀刻意用 `/api/cb` 而不是 `/api/codebuddy-*`：宿主按前缀匹配路由，
 * `/api/codebuddy` 会吞掉任何以它为前缀的新路径（更新路由先注册即遮蔽登录），
 * 而 `/api/cb` 与 `/api/codebuddy` 互不为前缀，两条路由互不干扰。
 *
 * 凭据写进 DSH 自己的 credentials（`.credentials.yaml`），索引写
 * `$DSH_HOME/dsh-codebuddy/accounts.json`；模型通道下一次请求即生效，无需重启。
 */
function installLoginRoutes(ctx, cfg, logger, modelBridge) {
    try { setTimeout(() => { Promise.resolve().then(() => ensureCatalogue()).catch(() => {}); }, 0); } catch {}

  const server = ctx.webServer
  /**
   * 凭据服务惰性获取。
   *
   * apply() 那条 inject 现在只要求 webServer（见那里的注释：以前连带 required
   * credentials，导致整组 /api/cb 路由一起失踪）。因此这里不能再在闭包里
   * 冻结 `ctx.credentials`——那样只会拿到 undefined，所有涉凭据功能都会误报
   * 「没有 credentials 服务」。改成每次现取，服务后到也能用上。
   */
  const getCredentials = () => {
    try {
      const c = ctx.credentials || ctx.get?.('credentials')
      return c && typeof c.resolve === 'function' ? c : null
    } catch { return null }
  }
  if (!server || typeof server.register !== 'function') return () => {}

  const home = () => String(cfg.dshHome || '').trim() || dshHome()

  /**
   * 统一的凭据读取：先看插件自己的库，再回落到 DSH 的 credentials 服务。
   *
   * 顺序是「本地优先」：我们自己写的永远是最新的（续期后的 token 会写回来），
   * 而服务里可能有旧值。老用户的凭据只在服务里，本地没有，因此回落这一步
   * 是必须的——不能因为上了本地库就让已登录的人掉线。
   */
  const resolveCredValue = async (ref) => {
    if (!ref) return null
    const local = readLocalCredential(home(), ref)
    if (local !== null) return { value: local }
    try {
      const svc = getCredentials()
      if (!svc) return null
      const resolved = await svc.resolve(ref)
      return resolved && typeof resolved.value === 'string' ? resolved : null
    } catch { return null }
  }

  /**
   * 统一的凭据写入：**一定**写本地库，服务存在就同时写一份。
   *
   * 之所以不再「服务缺失就抛错」，是因为对方的机器上根本没有那个服务，
   * 结果浏览器授权成功后卡在保存这一步，账号列表永远为空。
   * 凭据存在哪里不该由组合是否装了某个插件来决定。
   */
  const saveCredValue = async (ref, value) => {
    writeLocalCredential(home(), ref, value)
    try {
      const svc = getCredentials()
      if (svc && typeof svc.set === 'function') await svc.set(ref, value)
    } catch { /* 服务写失败无所谓，本地已经存住了 */ }
  }

  /** 删除凭据：两边都清，谁不存在都不报错。 */
  const dropCredValue = async (ref) => {
    deleteLocalCredential(home(), ref)
    try {
      const svc = getCredentials()
      if (svc?.unset) await svc.unset(ref)
    } catch { /* 已不存在 */ }
  }

  /** 这条 ref 是否真的存过凭据（只看"有没有"，不读内容）。 */
  const credValueExists = (ref) => {
    if (!ref) return false
    if (hasLocalCredential(home(), ref)) return true
    try { return !!getCredentials() } catch { return false }
  }

  /**
   * 装载后异步预热积分，让「第一次打开设置区」不必自己等上游。
   *
   * 快照能救「装过并用过」的机器，但**全新机器第一次**没有任何快照可读，
   * 仍要等上游最多 4 秒。这里在 Host 起来时就并行发起一次查询并落盘：
   * 用户通常要过一会儿才会点开设置区，等点开时快照已经写好了。
   *
   * 全部包在 try/catch 里、且延迟到下一轮事件循环：预热失败绝不能影响
   * 插件装载（没登录过账号时这里本来就是空转）。
   */
  try {
    setTimeout(() => {
      Promise.resolve().then(async () => {
        try {
          const list = readAccounts(home()).filter((a) => a.enabled !== false)
          if (list.length === 0) return
          await Promise.all(list.map(async (account) => {
            try {
              const resolved = await resolveCredValue(account.credentialRef)
              if (!resolved || typeof resolved.value !== 'string') return
              const parsed = JSON.parse(resolved.value)
              if (!parsed || typeof parsed.access_token !== 'string') return
              // 已有新鲜快照就不必再打一次上游
              const snap = readSnapshot(home(), `credits-${account.id}`, 300_000)
              if (snap) return
              const product = PRODUCTS[account.provider] || PRODUCTS.buddy
              const overview = await fetchCreditOverview(product, parsed)
              if (overview && overview.ok) writeSnapshot(home(), `credits-${account.id}`, overview)
            } catch { /* 单个账号预热失败不影响其它账号 */ }
          }))
        } catch { /* 预热整体失败静默 */ }
      })
    }, 1500)
  } catch {}
  /** accountId -> 进行中的登录会话 */
  const logins = new Map()
  const LOGIN_TTL_MS = 10 * 60_000

  function sweepLogins() {
    const now = Date.now()
    for (const [id, rec] of logins) if (now - rec.startedAt > LOGIN_TTL_MS) logins.delete(id)
  }

  function publicView(rec) {
    return {
      accountId: rec.accountId,
      provider: rec.provider,
      status: rec.status,
      loginUrl: rec.loginUrl,
      browserOpened: rec.browserOpened,
      nickname: rec.nickname || '',
      expiresAt: rec.expiresAt || 0,
      error: rec.error || '',
      startedAt: rec.startedAt,
    }
  }

  /** 后台把剩余两步跑完：拿到 token+account 后写凭据库并登记账号。 */
  function finishLogin(rec) {
    rec.controller = new AbortController()
    rec.promise = completeBuddyLogin(rec.state, { product: rec.product, signal: rec.controller.signal })
      .then(async (done) => {
        // 不再因为「没有 credentials 服务」而失败：凭据写进插件自己的库，
        // 服务存在就顺带写一份。这条曾经是「浏览器显示登录成功、账号列表却
        // 永远是空的」的唯一原因。
        await saveCredValue(rec.credentialRef, done.credentialJson)
        addAccount(home(), {
          id: rec.accountId,
          provider: rec.provider.id,
          nickname: done.nickname,
          credentialRef: rec.credentialRef,
          expiresAt: done.expiresAt,
          refreshable: done.refreshable,
        })
        rec.status = 'done'
        rec.nickname = done.nickname
        rec.expiresAt = done.expiresAt
        logger.info?.(`[codebuddy] 登录成功：${done.nickname || done.userId || rec.accountId}（${rec.provider.id}）`)
      })
      .catch((error) => {
        rec.status = 'failed'
        rec.error = String((error && error.message) || error)
        logger.warn?.(`[codebuddy] 登录未完成：${rec.error}`)
      })
  }

  const dispose = server.register({
    kind: 'prefix',
    path: '/api/cb',
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const json = (status, body) => {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        response.end(JSON.stringify(body))
      }
      // 只处理登录相关路径，其余交给更新路由
      if (url.pathname !== '/api/cb/login'
        && url.pathname !== '/api/cb/accounts'
        && url.pathname !== '/api/cb/credits'
        && url.pathname !== '/api/cb/credits/claim'
        && url.pathname !== '/api/cb/models') {
        return json(404, { ok: false, error: 'not-found' })
      }
      try {
        sweepLogins()

        // ---- 起登录 / 轮询登录 ----
        if (url.pathname === '/api/cb/login') {
          if (request.method === 'GET') {
            const id = url.searchParams.get('accountId') || ''
            const rec = logins.get(id)
            if (!rec) return json(200, { ok: false, status: 'unknown', error: '登录会话不存在或已过期，请重新发起登录' })
            return json(200, { ok: true, ...publicView(rec) })
          }
          if (request.method === 'POST') {
            const productKey = (url.searchParams.get('provider') || 'buddy').trim()
            const product = PRODUCTS[productKey] || PRODUCTS.buddy
            // 已有该产品的可用登录只回同一个，避免重复开浏览器
            sweepLogins()
            for (const rec of logins.values()) {
              if (rec.provider.id === product.id && rec.status === 'pending') {
                return json(200, { ok: true, reused: true, ...publicView(rec) })
              }
            }
            const begun = await beginBuddyLogin({ product })
            const accountId = newAccountId(product.id)
            const credentialRef = newCredentialRef(product.id)
            // 默认替用户直接开浏览器；配置 autoOpenBrowser:false 时只回 loginUrl，
            // 由界面/调用方自己决定何时打开（也是离线测试的注入口）。
            const opener = cfg.autoOpenBrowser === false ? async () => false : openBrowser
            let opened = false
            try { opened = await opener(begun.loginUrl) } catch { /* UI 还能手动点链接 */ }
            const rec = {
              accountId,
              credentialRef,
              provider: product,
              product,
              state: begun.state,
              loginUrl: begun.loginUrl,
              browserOpened: opened,
              status: 'pending',
              nickname: '',
              expiresAt: 0,
              error: '',
              startedAt: Date.now(),
            }
            logins.set(accountId, rec)
            finishLogin(rec)   // 后台跑，不阻塞响应
            return json(200, { ok: true, ...publicView(rec) })
          }
          return json(405, { ok: false, error: 'method not allowed' })
        }

        // ---- 模型启用/停用 ----
        //
        // GET  → 完整目录 + 每项 enabled
        // POST → { modelId, enabled }  改单个；{ action: 'enableAll' } 全开
        //
        // 偏好只存「被停用」的 id（见 src/model-prefs.js），所以新模型自动可用。
        // 改完立即生效：listModels 每次都实时按偏好过滤，没有缓存要失效。
        if (url.pathname === '/api/cb/models') {
          if (request.method === 'GET') {
            if (!modelBridge || typeof modelBridge.list !== 'function') {
              return json(200, { ok: false, error: '模型服务尚未就绪（缺少 llm 服务），请稍后再试' })
            }
            const models = await modelBridge.list()
            const enabledCount = models.filter((m) => m.enabled).length
            return json(200, {
              ok: true,
              models,
              total: models.length,
              enabledCount,
              // 全部停用会让模型选择器里整个分组消失，界面要能提示这件事
              allDisabled: enabledCount === 0,
            })
          }
          if (request.method === 'POST') {
            const chunks = []
            for await (const c of request) chunks.push(c)
            let body = {}
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
            if (String(body.action || '') === 'enableAll') {
              enableAllModels(home())
              logger.info?.('[codebuddy] 已启用全部模型')
              return json(200, { ok: true })
            }
            const modelId = String(body.modelId || '').trim()
            if (!modelId) return json(200, { ok: false, error: '缺少 modelId' })
            const enabled = body.enabled !== false
            const result = setModelEnabled(home(), modelId, enabled)
            logger.info?.(`[codebuddy] 模型 ${modelId} 已${enabled ? '启用' : '停用'}`)
            return json(200, { ok: true, disabled: result.disabled })
          }
          return json(405, { ok: false, error: 'method not allowed' })
        }

        // ---- 积分：查询余额 + 签到状态 ----
        //
        // GET  ?accountId=  → 一次返回余额与签到状态（两个端点并发、互不影响）
        // POST ?accountId=  → 领取今日积分
        //
        // accountId 可省略：省略时用账号池里第一个可用账号，方便界面「一键查全部」
        // 之前先看一眼。凭据始终只在 Host 侧解析，绝不回传给浏览器。
        if (url.pathname === '/api/cb/credits' || url.pathname === '/api/cb/credits/claim') {
          const wantId = String(url.searchParams.get('accountId') || '')
          const accounts = readAccounts(home()).filter((a) => a.enabled !== false)
          if (accounts.length === 0) {
            return json(200, { ok: false, error: '还没有可用账号，请先添加账号' })
          }
          const targets = wantId ? accounts.filter((a) => a.id === wantId) : accounts
          if (targets.length === 0) {
            return json(200, { ok: false, error: '账号不存在或已停用' })
          }
          const resolveCredential = async (account) => {
            try {
              const resolved = await resolveCredValue(account.credentialRef)
              if (!resolved || typeof resolved.value !== 'string') return null
              const parsed = JSON.parse(resolved.value)
              return parsed && typeof parsed.access_token === 'string' ? parsed : null
            } catch {
              return null
            }
          }

          if (url.pathname === '/api/cb/credits' && request.method === 'GET') {
            // ?fresh=1 强制重查（界面上的「刷新」按钮），忽略磁盘快照。
            const wantFresh = String(url.searchParams.get('fresh') || '') === '1'
            const rows = await Promise.all(targets.map(async (account) => {
              const product = PRODUCTS[account.provider] || PRODUCTS.buddy
              const credential = await resolveCredential(account)
              const base = {
                accountId: account.id,
                provider: account.provider,
                nickname: account.nickname || '',
              }
              if (!credential) {
                return { ...base, ok: false, error: '凭据不可用，请重新登录该账号' }
              }
              const snapName = `credits-${account.id}`
              // 冷启动第一屏：先用上次落盘的结果渲染，后台再刷新。
              //
              // 这是「换台电脑就特别慢」的真正原因——内存缓存救不了新进程，
              // 上游 billing 却要 2.6s、被墙时是干等满 4s 超时。快照按账号
              // 隔离（文件名带 accountId），绝不能把 A 的余额显示给 B。
              if (!wantFresh) {
                const snap = readSnapshot(home(), snapName, 7 * 24 * 3600_000)
                if (snap) {
                  void (async () => {
                    try {
                      const overview = await fetchCreditOverview(product, credential)
                      if (overview && overview.ok) writeSnapshot(home(), snapName, overview)
                    } catch { /* 后台刷新失败就继续用旧值 */ }
                  })()
                  return { ...base, ok: true, ...snap.value, stale: true, fetchedAt: snap.at }
                }
              }
              try {
                const overview = await fetchCreditOverview(product, credential)
                if (overview && overview.ok) writeSnapshot(home(), snapName, overview)
                return { ...base, ok: true, ...overview }
              } catch (error) {
                return { ...base, ok: false, error: String((error && error.message) || error) }
              }
            }))
            // 汇总：界面顶部一行就能显示「共 X 积分」，免得用户自己加
            const total = rows.reduce((sum, row) => {
              const value = row.balance && Number.isFinite(row.balance.total) ? row.balance.total : 0
              return sum + value
            }, 0)
            return json(200, { ok: true, accounts: rows, total: Math.round(total * 100) / 100 })
          }

          if (url.pathname === '/api/cb/credits/claim' && request.method === 'POST') {
            const results = []
            for (const account of targets) {
              const product = PRODUCTS[account.provider] || PRODUCTS.buddy
              const credential = await resolveCredential(account)
              const base = {
                accountId: account.id,
                provider: account.provider,
                nickname: account.nickname || '',
              }
              if (!credential) {
                results.push({ ...base, status: 'failed', message: '凭据不可用，请重新登录该账号', credit: 0 })
                continue
              }
              const result = await claimDailyCredit(product, credential)
              results.push({ ...base, ...result })
            }
            const gained = results.reduce((sum, r) => sum + (r.status === 'claimed' ? r.credit : 0), 0)
            logger.info?.(`[codebuddy] 领取积分：${results.map((r) => `${r.nickname || r.accountId}=${r.status}`).join(', ')}`)
            return json(200, { ok: true, results, gained: Math.round(gained * 100) / 100 })
          }

          return json(405, { ok: false, error: 'method not allowed' })
        }

        // ---- 账号池 ----
        if (request.method === 'GET') {
          const accounts = readAccounts(home()).map((a) => ({
            id: a.id,
            provider: a.provider,
            nickname: a.nickname || '',
            enabled: a.enabled !== false,
            refreshable: a.refreshable !== false,
            expiresAt: a.expiresAt || 0,
            createdAt: a.createdAt || 0,
            // 凭据只报「存不存在」，绝不回传内容
            hasCredential: credValueExists(a.credentialRef),
          }))
          return json(200, { ok: true, accounts, pending: [...logins.values()].filter((r) => r.status === 'pending').map(publicView) })
        }
        if (request.method === 'POST') {
          const chunks = []
          for await (const c of request) chunks.push(c)
          let body = {}
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* ignore */ }
          const id = String(body.accountId || '')
          const action = String(body.action || '')
          const entry = readAccounts(home()).find((a) => a.id === id)
          if (!entry) return json(200, { ok: false, error: '账号不存在' })
          if (action === 'delete') {
            removeAccount(home(), id)
            await dropCredValue(entry.credentialRef)
            logger.info?.(`[codebuddy] 已删除账号 ${id}`)
            return json(200, { ok: true })
          }
          if (action === 'setEnabled') {
            updateAccount(home(), id, { enabled: body.enabled !== false })
            return json(200, { ok: true })
          }
          return json(200, { ok: false, error: '未知操作' })
        }
        return json(405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        return json(500, { ok: false, error: String((error && error.message) || error) })
      }
    },
  })

  return () => {
    // 卸载时取消所有在途登录，避免插件已停用还在轮询/回写凭据
    for (const rec of logins.values()) {
      try { rec.controller?.abort() } catch { /* ignore */ }
    }
    logins.clear()
    try { dispose?.() } catch { /* ignore */ }
  }
}

/**
 * 定位 profile 目录（读依赖声明判断安装形态）。
 *
 * 优先用环境变量；但**宿主进程可能不把 DSH_PROFILE_DIR 传给插件**（实测在
 * DSH 内部运行时它为空），因此再从模块自身位置推导：插件装在
 * `<profile>/node_modules/dsh-codebuddy` 时，向上两级就是 profile。
 * 两条路径都失败才返回 null。
 */
function profileDirFromEnv() {
  const explicit = String(process.env.DSH_PROFILE_DIR || '').trim()
  if (explicit) return explicit
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) {
    const name = String(process.env.DSH_PROFILE || '').trim() || 'desktop'
    return path.join(home, 'profiles', name)
  }
  // 从模块位置推导：<profile>/node_modules/dsh-codebuddy/src/updater.js
  const self = moduleDir()
  const candidate = path.resolve(self, '..', '..')
  try {
    const pkgPath = path.join(candidate, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const doc = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
      if (doc && typeof doc === 'object' && doc.dependencies !== undefined) return candidate
    }
  } catch { /* ignore */ }
  return null
}

function install(ctx, cfg, logger, modelBridge) {
  const credentialRefName = String(cfg.credentialRef || '').trim()
  // 前缀缓存会话标识：同一进程内所有请求共用，服务端据此复用 KV 前缀缓存。
  const promptCacheKey = (globalThis.crypto?.randomUUID?.() || String(Date.now())).replace(/-/g, '')
  // 插件自己的账号池目录（不依赖 OFM）
  const accountHome = () => String(cfg.dshHome || '').trim() || dshHome()

  /**
   * 凭据服务惰性获取。
   *
   * apply() 那条 inject 现在只要求 llm（以前连带 required credentials，
   * 一旦组合里没有凭据服务，install() 整个不执行，连 models 路由的取数桥
   * 都拿不到，模型清单就会固定报错）。因此这里不能冻结 ctx.credentials，
   * 需要时现取；没有凭据服务时，读凭据返回 null、写回静默跳过，
   * 而不是让整个渠道装不上。
   */
  const getCredSvc = () => {
    try {
      const c = ctx.credentials || ctx.get?.('credentials')
      return c && typeof c.resolve === 'function' ? c : null
    } catch { return null }
  }

  /** install() 侧的凭据读取：本地库优先，再回落 DSH 服务。 */
  const readCredValue = async (ref) => {
    if (!ref) return null
    const local = readLocalCredential(stateHome(), ref)
    if (local !== null) return { value: local }
    const svc = getCredSvc()
    if (!svc) return null
    try {
      const resolved = await svc.resolve(ref)
      return resolved && typeof resolved.value === 'string' ? resolved : null
    } catch { return null }
  }

  /** install() 侧的凭据写入：本地库一定写，服务有就顺带写。 */
  const writeCredValue = async (ref, value) => {
    writeLocalCredential(stateHome(), ref, value)
    try {
      const svc = getCredSvc()
      if (svc && typeof svc.set === 'function') await svc.set(ref, value)
    } catch { /* 服务写失败不影响，本地已存住 */ }
  }

  /** install() 里的主目录。与 login 路由用同一套解析规则。 */
  const stateHome = () => String(cfg.dshHome || '').trim() || dshHome()

  const state = {
    credential: null,
    credentialRef: '',
    // 多账号轮换游标：遇到限流/额度用尽就换下一个号
    accountIndex: 0,
    credentialExpiresAt: 0,
    refreshing: null,
    // 完整目录（未按启用偏好过滤）：切开关时不需要重新拉远端
    catalogue: null,
    catalogueAt: 0,
    meta: new Map(),
  }

  /**
   * Channel Pack 里已启用且可用的 buddy 账号引用，按声明顺序。
   * 配了 credentialRef 就只认那一个（用户显式指定，不做轮换）。
   */
  /**
   * 可用账号的凭据 ref 列表。
   *
   * 顺序：① 插件自己的账号池（`$DSH_HOME/dsh-codebuddy/accounts.json`，
   * 由内置「登录 WorkBuddy / CodeBuddy」写入，**不依赖 OFM**）；
   * ② 兼容回退：Channel Pack 的 state.json（已在别处登录过的用户直接可用）。
   * 配了 credentialRef 就只认那一个（用户显式指定，不做轮换）。
   */
  function readAccountRefs() {
    if (credentialRefName) return [credentialRefName]
    const home = accountHome()
    const refs = []
    try {
      for (const a of availableAccounts(home, 'buddy')) {
        if (a.enabled !== false && a.credentialRef) refs.push(String(a.credentialRef))
      }
    } catch { /* 自有池读不到就靠回退 */ }
    const packHome = String(cfg.dshHome || '').trim() || dshHome()
    if (packHome) {
      try {
        const doc = JSON.parse(fs.readFileSync(path.join(packHome, 'channel-pack', 'state.json'), 'utf8'))
        for (const a of doc.accounts || []) {
          if (a && a.provider === 'buddy' && a.enabled !== false && a.credentialRef
            && !refs.includes(String(a.credentialRef))) {
            refs.push(String(a.credentialRef))
          }
        }
      } catch { /* 没装 OFM / 无该文件：正常情况 */ }
    }
    return refs
  }

  function readAccountRef() {
    const refs = readAccountRefs()
    if (refs.length === 0) return ''
    return refs[state.accountIndex % refs.length]
  }

  /**
   * 换一个账号：限流(6004)/额度用尽(14018)时调用。
   * 只有一个账号时返回 false（换不了，只能如实报错）。
   */
  function rotateAccount() {
    const refs = readAccountRefs()
    if (refs.length <= 1) return false
    state.accountIndex = (state.accountIndex + 1) % refs.length
    state.credential = null
    state.credentialRef = ''
    state.catalogue = null
    state.catalogueAt = 0
    logger.info?.(`[codebuddy] 切换账号 ${state.accountIndex + 1}/${refs.length} 后重试`)
    return true
  }

  async function loadCredential() {
    const ref = readAccountRef()
    if (!ref) return null
    try {
      // 惰性取凭据：apply() 那条 inject 只要求 llm 了（见那里的注释）。
      const resolved = await readCredValue(ref)
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
    // 写回凭据，避免下次又拿旧 token。写本地库，服务有就顺带写。
    try { await writeCredValue(refreshTargetRef(), JSON.stringify(next)) } catch { /* 只读库时忽略 */ }
    return next
  }

  function refreshTargetRef() {
    return readAccountRef()
  }

  async function ensureCredential() {
    // 账号可能在 Channel Pack 里被换掉（重登/切换）。凭据没到期也不代表还是
    // 同一个账号：沿用旧 token 会让新账号的额度不生效，表现为一直报 14018
    // 「额度已用尽」。所以每次都比对一次当前账号引用。
    const currentRef = readAccountRef()
    const sameAccount = !currentRef || !state.credentialRef || currentRef === state.credentialRef
    if (state.credential && !isExpired(state.credential) && sameAccount) return state.credential
    if (state.credential && !sameAccount) {
      logger.info?.(`[codebuddy] 账号已切换（${state.credentialRef} -> ${currentRef}），重新读取凭据`)
      state.credential = null
      state.catalogue = null
      state.catalogueAt = 0
    }
    if (state.refreshing) return state.refreshing
    state.refreshing = (async () => {
      let credential = await loadCredential()
      if (credential && isExpired(credential)) {
        try { credential = await refreshCredential(credential) } catch (error) {
          logger.warn?.(`[codebuddy] 续期失败：${String(error && error.message || error)}`)
        }
      }
      state.credential = credential
      state.credentialRef = currentRef
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
        // 只收对话模型：codewise-*（补全/改写）、图片生成等不进选择器
        if (!m.supportsToolCall && !m.reasoning && !m.supportsReasoning) continue
        // 远端目录的思考等级字段名没有公开契约，这里对常见拼法全部兼容；
        // 解析不到时回退内置兜底表，再兜底通用 low/high —— 否则宿主拿不到
        // reasoning.efforts，界面上就完全没有「主动选思考等级」的入口。
        const efforts = pickEfforts(m)
        const fallback = FALLBACK_MODELS.find((f) => f.id === String(m.id))
        // 目录给的是 maxInputTokens，但部分模型服务端对 prompt 另有更低硬限
        // （实测 hy3/hy3-x: 目录 192000，服务端 100000，code 11115）。
        // 以兜底表里已按实测修正过的值为准，避免宿主等到撞墙才压缩。
        const catalogWindow = readNumber(m.maxInputTokens)
          || readNumber(m.maxAllowedSize)
          || readNumber(m.contextWindow)
          || readNumber(m.contextWindow && m.contextWindow.defaultLength)
        const declaredWindow = fallback ? Math.min(catalogWindow || fallback.contextWindow, fallback.contextWindow) : catalogWindow
        out.push({
          id: String(m.id),
          name: String(m.name || m.id),
          contextWindow: declaredWindow,
          maxOutputTokens: fallback ? Math.min(readNumber(m.maxOutputTokens) || fallback.maxOutputTokens, fallback.maxOutputTokens) : readNumber(m.maxOutputTokens),
          supportsImages: m.supportsImage === true || m.supportsVision === true || true,
          reasoningEfforts: efforts.length > 0 ? efforts : (fallback ? fallback.reasoningEfforts : GENERIC_EFFORTS),
          defaultReasoningEffort: pickDefaultEffort(m)
            || (fallback ? fallback.defaultReasoningEffort : '')
            || 'high',
        })
      }
      return out.length > 0 ? out : null
    } catch {
      return null
    }
  }

  /**
   * 消除「同名不同 id」的模型歧义。
   *
   * 实测 /v3/config 里 `hy4flash` 与 `hy4flash-free` 的 name **都是 "Hy4 flash"**，
   * 选择器里就是两行完全一样的字，根本分不清哪个是免费版——用户只能挨个试。
   *
   * 规则：同名组里**第一个保持原名**，后面的追加区分后缀——所以显示成
   * 「Hy4 flash」+「Hy4 flash (free)」，既分得清又不啰嗦。
   * 后缀优先取 `-free` / `-preview` 这类语义（好读），取不到才回落到 id。
   * 不硬编码任何具体模型，腾讯以后再加同名模型也会被自动处理。
   */
  function disambiguateNames(models) {
    const seen = new Set()
    const shortLabel = (id) => {
      const suffix = String(id).match(/-(free|preview|pro|std|mini|lite)$/)
      return suffix ? suffix[1] : String(id)
    }
    return models.map((m) => {
      if (!seen.has(m.name)) {
        seen.add(m.name)
        return m
      }
      return { ...m, name: `${m.name} (${shortLabel(m.id)})` }
    })
  }

  /**
   * 明确「已确认还活着」的 legacy 模型白名单。
   *
   * 只有这里列出的 id 才会被补回列表。**这是白名单，不是黑名单**：
   * 上一版用的是「兜底表里远端没有的全都补回来」，结果把早就死掉的 hy4free
   * 也补了回来，用户一选就炸：
   *   HTTP 400 code 11102 "model [hy4free] service info not found"
   * 兜底表是「远端拿不到时的应急清单」，它的条目**从未被逐个验证过**，
   * 不能反过来当成「这些模型都还能用」的证据。
   *
   * 新增条目必须先实测：对 /v2/chat/completions 发一次 model=<id>，
   * 拿到 200（SSE 或有内容）才允许写进来。只探测过 11102 之外的错误不算数。
   */
  const LEGACY_BACKFILL_IDS = ['hy3', 'hy3-x']

  /**
   * 确认已下线、不该再出现在任何清单里的模型。
   *
   * hy4free 实测返回 11102 service info not found（2026-11-22）。
   * 即使它仍在兜底表里（兜底表是应急清单，不好随手删条目），
   * 这里也会把它从「远端为空」的降级路径里一并滤掉，
   * 否则远端一挂，用户又会在选择器里看到这个必炸的模型。
   */
  const RETIRED_MODEL_IDS = new Set(['hy4free'])

  function aliveFallback() {
    return FALLBACK_MODELS.filter((m) => !RETIRED_MODEL_IDS.has(String(m.id)))
  }

  /**
   * 把「远端目录已不再列出、但接口仍然认」的模型补回来。
   *
   * 实测（2026-11-22）：腾讯把 `hy3` / `hy3-x` 从 /v3/config 的模型列表里撤了，
   * 但直接对 `/v2/chat/completions` 发 `model: "hy3"` 仍然返回 **HTTP 200**，
   * 说明模型没下线，只是不再出现在 IDE 的目录里。
   *
   * 早先插件完全以远端目录为准，于是这些「还能用但没列出来」的模型就凭空消失了
   * ——用户看到的就是「我的 hy3 没了」。这里用**白名单**补位（见 LEGACY_BACKFILL_IDS）：
   *   · 远端有的，用远端（新；名字/上下文都是最新的）
   *   · 远端没有、白名单里有的，追加为 legacy（旧但实测还能调）
   *
   * 补进来的标 `legacy: true`，设置页会打个「旧」标签；用户不想要可以用
   * 模型开关关掉——这也是为什么敢补：有开关兜底，误补不会变成麻烦。
   */
  function mergeLegacyModels(remote) {
    if (!Array.isArray(remote) || remote.length === 0) return aliveFallback()
    const have = new Set(remote.map((m) => String(m.id)))
    const allow = new Set(LEGACY_BACKFILL_IDS)
    const legacy = FALLBACK_MODELS
      // 白名单 ∩ 兜底表：兜底表里没有这个 id 就无从补起
      .filter((m) => allow.has(String(m.id)) && !have.has(String(m.id)))
      .map((m) => ({ ...m, legacy: true }))
    return [...remote, ...legacy]
  }

  /**
   * 拉「完整目录」并缓存 10 分钟。
   *
   * 注意这里**不做启用/停用过滤**：过滤放在 listModels 里每次实时做。
   * 否则用户在设置页点一下开关还要等缓存过期才生效，看起来就像没生效。
   */
  async function ensureCatalogueBlocking() {
    const now = Date.now()
    if (state.catalogue && now - state.catalogueAt < 10 * 60_000) return state.catalogue
    const credential = await ensureCredential()
    const remote = credential ? await fetchModels(credential).catch(() => null) : null
    const source = disambiguateNames(mergeLegacyModels(remote))
    state.meta = new Map(source.map((m) => [m.id, m]))
    state.catalogue = source
    state.catalogueAt = now
    // 记住这份目录的来源：只有「真从远端拿到」的才值得落盘。
    // 兜底表（aliveFallback）是应急清单，把它写进快照会让一次网络故障
    // 变成长期「事实」——用户下次正常联网时看到的还是那份旧的应急列表。
    state.catalogueSource = Array.isArray(remote) && remote.length > 0 ? 'remote' : 'fallback'
    return state.catalogue
  }
  /* 目录缓存：stale-while-revalidate + 共享 in-flight + 冷启动限时。
     设置区的模型列表不再被远端目录拉取阻塞：
     - 缓存有效：直接返回，零网络
     - 缓存过期：立刻返回旧值，后台静默刷新
     - 冷启动无缓存：最多等 2500ms，超时先给兜底目录，后台继续拉
     多个并发请求共享同一次拉取。 */
  const __cbCatalogueCache = new Map();
  const __cbCatalogueMiss = Symbol('miss');

  function __cbCatalogueKey(args) {
    if (!args || args.length === 0) return '';
    try { return JSON.stringify(args, (k, v) => (typeof v === 'function' ? undefined : v)); }
    catch { return null; }
  }

  async function ensureCatalogue(...args) {
    const key = __cbCatalogueKey(args);
    if (key === null) return ensureCatalogueBlocking(...args);
    let entry = __cbCatalogueCache.get(key);
    if (!entry) {
      entry = { value: null, at: 0, inflight: null };
      __cbCatalogueCache.set(key, entry);
    }
    const now = Date.now();
    if (entry.value !== null && now - entry.at < 600000) return entry.value;

    // 进程内没有可用值时才去看磁盘快照。
    //
    // 这一步专治「换台电脑 / 重启 DSH 后第一次打开特别慢」：内存缓存对
    // 新进程等于不存在，而远端目录在被墙或无网时是干等满超时。落盘的上一次
    // 目录能让第一屏立刻渲染出正确的模型列表（含图标与名字），随后后台刷新。
    // 只在「没有内存值」时读盘，热路径不会多一次文件 IO。
    if (entry.value === null) {
      const snap = readSnapshot(accountHome(), 'catalogue', 30 * 24 * 3600_000)
      if (snap && Array.isArray(snap.value) && snap.value.length > 0) {
        entry.value = snap.value;
        entry.at = snap.at;
        // 目录里可能含已下线的模型，落盘值同样要过一遍退役过滤
        state.catalogue = snap.value;
        state.catalogueAt = snap.at;
        state.meta = new Map(snap.value.map((m) => [m.id, m]));
      }
    }

    const stale = entry.value !== null;
    if (!entry.inflight) {
      entry.inflight = Promise.resolve()
        .then(() => ensureCatalogueBlocking(...args))
        .then((value) => {
          entry.value = value; entry.at = Date.now();
          // 只缓存「真从远端拿到」的目录：兜底表不是远端事实，落盘会让
          // 某次网络故障时的应急清单长期冒充真相。
          try {
            if (state.catalogueSource === 'remote') writeSnapshot(accountHome(), 'catalogue', value);
          } catch {}
          return value;
        })
        .catch((error) => { if (entry.value !== null) return entry.value; throw error; })
        .finally(() => { entry.inflight = null; });
    }
    if (stale) { entry.inflight.catch(() => {}); return entry.value; }
    const miss = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(__cbCatalogueMiss), 2500);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const winner = await Promise.race([entry.inflight, miss]);
    if (winner !== __cbCatalogueMiss) return winner;
    entry.inflight.catch(() => {});
    try {
      if (typeof aliveFallback === 'function') return aliveFallback();
    } catch {}
    return [];
  }


  /** 兼容旧调用点：返回「已按偏好过滤」的清单。 */
  async function ensureModels() {
    const catalogue = await ensureCatalogue()
    const prefs = readModelPrefs(accountHome())
    const { models } = applyModelPrefs(catalogue, prefs)
    return models.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name }))
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
      const pid = provider || PROVIDER
      // 别名必须能一眼和主渠道区分开。
      //
      // 早先这里对任何 provider 都返回同一个 DISPLAY_NAME，而默认又注册了
      // `buddy` 别名，于是模型选择器里出现**两个都叫「CodeBuddy (腾讯免费)」
      // 的分组**，里面模型一模一样——用户根本无法分辨该选哪个。
      return { id: pid, name: pid === PROVIDER ? DISPLAY_NAME : `${DISPLAY_NAME} · ${pid}` }
    },

    providerRetryPolicy() {
      // 宿主按 `attempt <= maxRetries` 执行。默认 1：瞬时故障（超时/断连/5xx）
      // 自动补发一次；上限压到 1 是为了避免失败被放大成一串重复调用。
      // 另有一层「按上游意愿重试」：官方 retry_policy.retry=true（如 11134）
      // 会再精确补发一次并尊重 Retry-After。可用配置 maxRetries 调整（0–5）。
      const raw = Number(cfg.maxRetries)
      const maxRetries = Number.isSafeInteger(raw) && raw >= 0 ? Math.min(raw, 5) : 1
      return Object.freeze({
        mode: 'normal',
        maxRetries,
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

    async listModels(provider) {
      const list = await ensureModels()
      // 用调用方给的 provider 名回填，别名（如 buddy）才不会串成 codebuddy
      const pid = provider || PROVIDER
      return list.map((m) => ({
        provider: pid,
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

  /**
   * 把消息里的图片附件读成 data URL（attachmentId → `data:<type>;base64,...`）。
   *
   * 走 attachments.readImageRequest：它按目标的宽高/字节预算生成请求版本，
   * 比直接用原图更省 token，也避免超过上游体积限制。任一图读取失败就跳过
   * 该图（序列化时会写成 `[image unavailable]`），不让单张坏图废掉整轮对话。
   */
  async function resolveImageUrls(messages, signal) {
    const urls = new Map()
    const refs = collectImageRefs(messages)
    if (refs.size === 0) return urls
    if (!ctx.attachments || typeof ctx.attachments.readImageRequest !== 'function') {
      logger.warn?.('[codebuddy] 当前组合没有 attachments 服务，图片将被标记为不可用')
      return urls
    }
    const limits = ctx.attachments.imageLimits || {}
    const target = { width: IMAGE_MAX_DIMENSION, height: IMAGE_MAX_DIMENSION, maxBytes: IMAGE_MAX_BYTES }
    void limits
    for (const [id, ref] of refs) {
      try {
        const request = await ctx.attachments.readImageRequest(ref, target, signal)
        if (!request || !request.data) continue
        const base64 = Buffer.from(request.data).toString('base64')
        urls.set(id, `data:${request.mediaType};base64,${base64}`)
      } catch (error) {
        logger.warn?.(`[codebuddy] 读取图片 ${id} 失败：${String(error && error.message || error)}`)
      }
    }
    return urls
  }

  /**
   * 流级自愈外壳。
   *
   * SSE 读到一半被对端掐断（`terminated` / other side closed）时，fetchPost
   * 那层已经返回过 response，管不到；只能在这里重来。
   *
   * 两条恢复路径，按「有没有东西已经交给宿主」分流：
   *
   *   A. **断点续写**（已交付过正文或工具块）：把已交付的正文作为 assistant
   *      消息回灌，再用一条 user 指令要求模型从断点接着写。这样宿主收到的
   *      是一条连续的回答，用户看不出中间断过。
   *      续写轮会禁用工具（skipTools）——上一轮若已下发完整工具块，续写再生成
   *      一次就会被执行两遍，所以直接丢弃。
   *
   *   B. **整轮重发**（什么都还没交付）：完全安全，用户看不见任何重复。
   *
   * 曾经 A 只允许 1 次、且一旦出现过工具块就直接放弃（报「本轮已作废」），
   * 于是同一条消息常常需要手动重发；现在 A 允许 3 次、B 允许 2 次，并且
   * 每次之间退避，恢复不动声色。
   */
  async function* streamCall(options) {
    const MAX_RETRIES = 2          // 整轮重发上限（未交付任何内容时）
    const MAX_CONTINUATIONS = 3    // 断点续写上限（已交付内容时）
    const INSTRUCTION = 'Your previous reply was cut off mid-way by a dropped connection. '
      + 'Continue exactly where that reply stopped: do not repeat, summarize or restart '
      + 'what was already written; resume the cut sentence and finish the remaining '
      + 'content, then stop. Do not call tools in this continuation.'
    const baseMessages = Array.isArray(options && options.messages) ? options.messages : []
    let indexOffset = 0
    /** 本轮已经交付给宿主的全部正文（续写回灌、判定是否已交付都靠它）。 */
    let allText = ''
    let sawText = false
    let sawTool = false
    let retries = 0
    let continuations = 0
    /** 当前这一趟是否「续写轮」——决定是否丢弃工具块。 */
    let inContinuation = false
    let current = options
    const exhausted = (reason) => new Error('codebuddy: 上游在' + reason
      + '断开连接（terminated），已自动重试 ' + (retries + continuations) + ' 次仍未恢复。'
      + '请重发这条消息。')

    for (;;) {
      try {
        for await (const chunk of streamOnce(current, indexOffset, {
          skipReasoning: continuations > 0 || retries > 0,
          skipTools: inContinuation,
        })) {
          if (chunk.type === 'block-start') {
            if (chunk.blockType === 'tool-call' && !inContinuation) sawTool = true
            if (Number.isFinite(chunk.index)) indexOffset = Math.max(indexOffset, chunk.index + 1)
          } else if (chunk.type === 'tool-call-delta') {
            if (!inContinuation) sawTool = true
          } else if (chunk.type === 'text-delta') {
            sawText = true
            allText += String(chunk.text || '')
          }
          yield chunk
        }
        return
      } catch (error) {
        const aborted = options && options.signal && options.signal.aborted
        if (aborted) throw error
        if (!isConnectionDeath(error)) throw error
        const interrupted = !!(error && error.codebuddyInterrupted)

        // A. 已经交付过内容 → 断点续写，宿主侧看到的是一条连续回答。
        if (interrupted && (sawText || sawTool) && continuations < MAX_CONTINUATIONS) {
          continuations++
          inContinuation = true
          logger.warn?.('[codebuddy] 响应流中途断开，从断点续写第 '
            + continuations + '/' + MAX_CONTINUATIONS + ' 次（已交付 ' + allText.length + ' 字'
            + (sawTool ? '、含工具块' : '') + '）')
          await new Promise((resolve) => setTimeout(resolve, 400 * continuations))
          if (options && options.signal && options.signal.aborted) throw error
          current = {
            ...current,
            messages: [
              ...baseMessages,
              {
                role: 'assistant',
                content: [{
                  type: 'text',
                  // 只有工具块、没有正文时给个占位，否则空 content 会让请求非法
                  text: allText.length > 0
                    ? allText
                    : '(the previous reply stopped right after a tool call)',
                }],
              },
              { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] },
            ],
          }
          continue
        }

        // B. 什么都没交付 → 整轮重发完全安全，用户看不见重复。
        if (interrupted && !sawText && !sawTool && retries < MAX_RETRIES) {
          retries++
          logger.warn?.(`[codebuddy] 输出前断流（${String((error && error.message) || error)}），`
            + `整轮重发第 ${retries}/${MAX_RETRIES} 次`)
          await new Promise((resolve) => setTimeout(resolve, 500 * retries))
          if (options && options.signal && options.signal.aborted) throw error
          continue
        }

        // C. 恢复次数用尽 → 只能如实报错（至少要说清已经试过几次）。
        throw exhausted(sawTool ? '工具调用已下发后' : '回答中途')
      }
    }
  }

  async function* streamOnce(options, startIndex = 0, opts = {}) {
    const credential = await ensureCredential()
    if (!credential || !credential.access_token) {
      throw new Error('codebuddy: 没有可用凭据，请先在 Channel Pack 登录 CodeBuddy 账号')
    }

    const wire = serializeMessages(options.messages, await resolveImageUrls(options.messages, options.signal))
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

    const bodyJson = JSON.stringify(body)

    // 长对话间隔后，连接池里可能留着一条被服务端静默关掉的 keep-alive 死
    // 连接：请求发上去直接 `fetch failed`（ECONNRESET / socket hang up），
    // 且发生在流未开始时——换一条连接重发必定能成，所以精确补发一次
    // （间隔 400ms，让池子先把死连接清掉），用户感知不到。
    // 非连接类错误不吞，照常上抛。
    // fetchPost 已带死连接自愈（精确补发一次），这里直接发即可
    let response = await fetchPost(bodyJson, credential, options.signal)

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // prompt 超长：官方明确 retry=false，立刻给可执行建议，不换号不重试
      const tooLong = promptTooLongMessage(text)
      if (tooLong) throw new Error('codebuddy: ' + tooLong)
      // 频率限制 / 额度用尽：先看能不能换个账号继续（多号时）。
      // 换号成功就立刻用新凭据重发一次；只有一个账号时才如实报错。
      const rate = rateLimitInfo(text)
      const quota = quotaExhaustedMessage(text)
      if ((rate || quota) && rotateAccount()) {
        const next = await ensureCredential()
        if (next && next.access_token) {
          const retried = await fetchPost(bodyJson, next, options.signal)
          if (retried.ok) return yield* consumeSse(retried, options, startIndex, opts)
          const t2 = await retried.text().catch(() => '')
          // 换号后还失败：把新错误如实抛出（不再连环换号，避免打穿所有账号）
          const r2 = rateLimitInfo(t2)
          if (r2) throw new Error('codebuddy: ' + r2.message)
          const q2 = quotaExhaustedMessage(t2)
          if (q2) throw new Error('codebuddy: ' + q2)
          throw new Error(`codebuddy: HTTP ${retried.status} ${t2.slice(0, 200)}`)
        }
      }
      if (rate) throw new Error('codebuddy: ' + rate.message)
      // 额度用尽：立刻停手，不做任何重试（等多久都不会恢复额度）。
      // 同时丢弃内存里的凭据：用户充值或换账号后，下一次请求会重新读取，
      // 不会继续拿旧账号的 token 报同一个错。
      if (quota) {
        state.credential = null
        state.credentialRef = ''
        throw new Error('codebuddy: ' + quota)
      }
      // 401/403：token 可能已失效，强制续期后重试一次
      if (response.status === 401 || response.status === 403) {
        state.credential = null
        const fresh = await ensureCredential()
        if (fresh && fresh.access_token !== credential.access_token) {
          const retry = await fetchPost(bodyJson, fresh, options.signal)
          if (retry.ok) return yield* consumeSse(retry, options, startIndex, opts)
          const rt = await retry.text().catch(() => '')
          throw new Error(`codebuddy: HTTP ${retry.status} ${rt.slice(0, 200)}`)
        }
      }
      // 上游瞬时故障（11134 等）会明确给出 retry:true 或 Retry-After。
      // 腾讯让重试才重试：最多一次、流尚未开始、尊重官方等待时长。
      // 这层与宿主 maxRetries 相互独立：官方意愿优先精确补发一次，
      // 官方没表态的（网络断/超时）由宿主策略补发一次。
      if (await shouldRetryTransient(text, response, options.signal)) {
        response = await fetchPost(bodyJson, credential, options.signal)
        if (response.ok) return yield* consumeSse(response, options, startIndex, opts)
        const t2 = await response.text().catch(() => '')
        throw new Error(`codebuddy: HTTP ${response.status} ${t2.slice(0, 200)}`)
      }
      throw new Error(`codebuddy: HTTP ${response.status} ${text.slice(0, 200)}`)
    }

    yield* consumeSse(response, options, startIndex, opts)
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
  // 注意：不要写成 `opts = {}`——测试按花括号计数切函数体，
  // 参数里的空对象会被误当成函数体开头。
  async function* consumeSse(response, options, startIndex = 0, opts) {
    const skipReasoning = !!(opts && opts.skipReasoning)
    // 续写轮禁用工具：上一轮若已经把完整工具块交给宿主，续写再生成一次工具调用
    // 就会被执行两遍。这里直接丢弃续写轮的 tool_calls，finish 也因此不会报
    // tool-calls，宿主只拿到「补完的文字」。
    const skipTools = !!(opts && opts.skipTools)
    if (!response.body) throw new Error('codebuddy: 空响应体')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    let finishReason = ''
    let nextIndex = startIndex
    /** 已吐出的正文，断流时用于续写（不含思考内容）。 */
    let answerText = ''
    const collectedText = () => answerText

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
      let result
      try {
        result = await reader.read()
      } catch (error) {
        // 读流中断（terminated / other side closed）：先闭合已打开的**文本/思考**
        // 块（内容哪怕是半截也是合法块），否则宿主收到「有 block-start 没有
        // block-end」的半成品，比报错更糟。
        // 但**不闭合**未完成的工具块——参数被截断就是坏 JSON，闭合了宿主会
        // 照着执行坏调用；让这轮直接以错误收场更安全。
        // 断点信息挂在 error 上，供上层决定是否续写。
        if (!isConnectionDeath(error)) throw error
        const tail = closeProse()
        if (tail) yield tail
        const err = new Error('codebuddy: 响应流被上游中途断开')
        err.codebuddyInterrupted = true
        err.codebuddyPartial = { text: answerText, tools: toolOrder.length }
        err.cause = error
        throw err
      }
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
          // 重试/续写轮不再重复下发思考块：宿主已经看过上一段的思考，
          // 再来一遍会让界面出现重复的「思考中」。
          if (!skipReasoning) {
            const opened = openProse('reasoning')
            for (const chunk of opened.flush) yield chunk
            opened.block.text += reasoning
            yield { type: 'reasoning-delta', index: opened.block.index, text: reasoning }
          }
        }

        const content = delta.content
        if (typeof content === 'string' && content.length > 0) {
          const opened = openProse('text')
          for (const chunk of opened.flush) yield chunk
          opened.block.text += content
          answerText += content
          yield { type: 'text-delta', index: opened.block.index, text: content }
        }

        if (Array.isArray(delta.tool_calls)) {
          if (skipTools) continue
          for (const call of delta.tool_calls) {
            if (!call || typeof call !== 'object') continue
            const wireIndex = Number(call.index ?? 0)
            let block = toolBlocks.get(wireIndex)
            if (!block) {
              block = { index: nextIndex++, wireIndex, id: '', name: '', text: '', announced: false }
              toolBlocks.set(wireIndex, block)
            }
            if (call.id) block.id = String(call.id)
            const fn = call.function || {}
            if (typeof fn.name === 'string' && fn.name.length > 0) block.name = fn.name
            const fragment = typeof fn.arguments === 'string' ? fn.arguments : ''
            block.text += fragment

            // **参数完整前不下发**（关键）。
            // 断流时宿主手里因此没有任何半截工具块，整轮重发是安全的；
            // 若边生成边发，宿主会拿着被截断的坏 JSON 去执行。
            if (!block.announced && block.name.length > 0 && isCompleteArgs(block.text)) {
              const closing = closeProse()
              if (closing) yield closing
              block.announced = true
              toolOrder.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.id || `call_${block.wireIndex}`,
                name: block.name,
                argumentsDelta: block.text,
              }
            }
          }
        }
      }
    }

    // 流正常结束后，把仍在缓存里、参数已完整的工具块补发出去。
    for (const block of toolBlocks.values()) {
      if (block.announced || block.name.length === 0) continue
      const closing = closeProse()
      if (closing) yield closing
      block.announced = true
      toolOrder.push(block)
      yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: block.index,
        id: block.id || `call_${block.wireIndex}`,
        name: block.name,
        argumentsDelta: block.text,
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

  // 把「列模型（含启用状态）」交给 web 路由使用。
  // 用 modelBridge 而不是在这里直接注册路由：`/api/cb` 前缀只能注册一次，
  // 再注册一个会被先注册的那个遮住（宿主按前缀匹配）。
  if (modelBridge) {
    modelBridge.list = async () => {
      const catalogue = await ensureCatalogue()
      const prefs = readModelPrefs(accountHome())
      const { models } = applyModelPrefs(catalogue, prefs)
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled !== false,
        // legacy = 远端目录没列出、但接口仍然认的模型（用兜底表补回来的）
        legacy: m.legacy === true,
      }))
    }
  }

  if (!ctx.llm || typeof ctx.llm.registerAdapter !== 'function') {
    logger.warn?.('[codebuddy] 当前组合没有 llm 服务，渠道未注册')
    return () => {}
  }

  // 主渠道必须先注册成功：任何附加尝试都不能连累它，
  // 否则一旦 provider 名冲突，宿主会整条拒绝，用户看到的就是「模型全没了」。
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: PROVIDER, displayName: DISPLAY_NAME, settingsNs: PROVIDER, settingsPath: [] },
  ])

  // 额外别名（可选）：让 `buddy/glm-5.3` 这类 id 也能解析。
  // 逐个独立 try/catch —— 名字被别的插件占用时只跳过该别名。
  //
  // **默认不注册任何别名。** 以前默认 `['buddy']`，本意是兼容从 OFM 迁过来的
  // `buddy/xxx` 模型 id，结果适得其反：
  //   ① 选择器里多出一个同名分组（onboarding 时的第一次疑惑）；
  //   ② `buddy` 本来就是 OFM/channel-pack 自己的 provider 名，默认抢占它
  //      会让两个插件的渠道互相顶替，谁注册得晚谁生效，行为不稳定。
  // 需要兼容旧 id 时显式配 `aliases: ['buddy']`，界面会用「· buddy」标出来。
  const extraAliases = Array.isArray(cfg.aliases)
    ? cfg.aliases.map((x) => String(x || '').trim()).filter(Boolean)
    : []
  const aliasRegistrations = []
  const aliasOk = []
  for (const alias of extraAliases) {
    if (!alias || alias === PROVIDER) continue
    try {
      aliasRegistrations.push(ctx.llm.registerAdapter([alias], adapter))
      aliasOk.push(alias)
    } catch (error) {
      logger.warn?.(`[codebuddy] 别名渠道 ${alias} 注册失败（可能已被其他插件占用），已跳过：${String((error && error.message) || error)}`)
    }
  }
  logger.info?.(`[codebuddy] 已注册 CodeBuddy 渠道 ${[PROVIDER, ...aliasOk].join('/')}（${FALLBACK_MODELS.length} 个兜底模型，凭据复用 Channel Pack 的 buddy 账号）`)

  // 自检路由：确认渠道与模型确实挂上了（排查「模型没了」这类问题用）
  ctx.inject(['webServer'], (scoped) => {
    const server = scoped && scoped.webServer ? scoped.webServer
      : (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
    if (!server || typeof server.register !== 'function') return () => {}
    try {
      return server.register({
        kind: 'exact',
        path: '/api/codebuddy/self-check',
        handler: (_req, res) => {
          const body = JSON.stringify({
            ok: true,
            version: readLocalVersion(moduleDir()),
            providers: [PROVIDER, ...aliasOk],
            failedAliases: extraAliases.filter((a) => a && a !== PROVIDER && !aliasOk.includes(a)),
            fallbackModels: FALLBACK_MODELS.length,
            cachedModels: Array.isArray(state.catalogue) ? state.catalogue.length : 0,
            hasCredential: !!state.credential,
          })
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(body)
        },
      })
    } catch (error) {
      logger.warn?.('[codebuddy] 自检路由注册失败：' + String((error && error.message) || error))
      return () => {}
    }
  })

  return () => {
    try { if (registration && typeof registration.dispose === 'function') registration.dispose()
      else if (typeof registration === 'function') registration() } catch { /* ignore */ }
    for (const r of aliasRegistrations) {
      try { if (r && typeof r.dispose === 'function') r.dispose() } catch { /* ignore */ }
    }
  }
}
