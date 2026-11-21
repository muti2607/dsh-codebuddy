/**
 * CodeBuddy / WorkBuddy 原生登录流（协议 1:1 移植自 MIT 上游实现，
 * 逐字段核对法同 _analysis/channel-pack-protocol.md；不依赖 OFM、
 * 不 vendor pack.js，纯 Node：fetch + 系统浏览器 + 本地轮询）。
 *
 * 三步（全部走官方 IDE 插件端点 /v2/plugin/auth/*、/v2/plugin/login/account）：
 *   1. POST {endpoint}/v2/plugin/auth/state?platform=<平台>
 *        -> { data: { state, authUrl } }
 *   2. 浏览器打开 authUrl 登录；轮询
 *      GET {endpoint}/v2/plugin/auth/token?state=<state>
 *        未就绪 code=11217 -> 继续等；成功 -> parseTokenData(data)
 *   3. GET {endpoint}/v2/plugin/login/account?state=<state>（带上一步的 token）
 *        未就绪 code=12151 -> 继续等；成功 -> parseAccountData(data)
 *
 * 组装出的凭据 JSON 与插件现有 loadCredential / refreshCredential 完全兼容
 * （access_token / refresh_token / expires_at / user_id / nickname / …），
 * 由调用方写进 DSH 自身凭据库（ctx.credentials），不依赖任何外部插件。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

const AUTH_STATE_PATH = '/v2/plugin/auth/state'
const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
const LOGIN_TIMEOUT_MS = 5 * 60_000
const POLL_INTERVAL_MS = 1_000
const STATE_REQUEST_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 60_000
const CODE_TOKEN_NOT_READY = 11217
const CODE_ACCOUNT_NOT_READY = 12151

/** 产品配置：CodeBuddy（腾讯，默认）与 WorkBuddy（国际版）。 */
export const PRODUCTS = {
  buddy: {
    id: 'buddy',
    platform: 'ide',
    endpoint: 'https://copilot.tencent.com',
    apiDomain: 'copilot.tencent.com',
    userAgent: 'CodeBuddyIDE/1.106.1',
    defaultCredentialRef: 'BUDDY_ACCESS_TOKEN',
    appendSessionParams: false,
    pluginVersion: '',
  },
  workbuddy: {
    id: 'workbuddy',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    apiDomain: 'www.workbuddy.ai',
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/5.5.2',
    defaultCredentialRef: 'WORKBUDDY_ACCESS_TOKEN',
    appendSessionParams: true,
    pluginVersion: '5.5.2',
  },
}

export function productOf(id) {
  return PRODUCTS[String(id || 'buddy')] || PRODUCTS.buddy
}

/**
 * 轮询等待。刻意 **不加 unref**：登录循环必须能保证推进到下一次轮询，
 * 否则一旦某次 fetch 是纯内存同步返回（测试桩、或极快的本地代理），
 * 事件循环会先被抽干、进程带着未决 promise 退出，登录永远结不了尾。
 * 循环本身受 deadline 约束（默认 5 分钟），不会无限期挂住进程。
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

function readString(record, key) {
  const v = record && record[key]
  return typeof v === 'string' ? v : ''
}
function readNumber(record, key) {
  const v = Number(record && record[key])
  return Number.isFinite(v) && v > 0 ? v : undefined
}
function responseCode(body) {
  const c = body && body.code
  if (typeof c === 'number') return c
  const n = Number(c)
  return Number.isFinite(n) ? n : undefined
}
function responseMessage(body) {
  const m = body && body.message
  return typeof m === 'string' ? m : ''
}
function responseData(body) {
  const d = body && body.data
  return d === null || d === undefined ? undefined : d
}

/** JWT 解码取 claim（exp/iat 秒、sub/nickname 字符串）。 */
function jwtClaim(token, claim) {
  if (typeof token !== 'string' || !token.includes('.')) return undefined
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    const v = payload[claim]
    if (claim === 'nickname' || claim === 'sub') return typeof v === 'string' ? v : ''
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  } catch { return undefined }
}
const jwtExpiresAtMs = (t) => { const e = jwtClaim(t, 'exp'); return e === undefined ? undefined : e * 1000 }
const jwtIssuedAtMs = (t) => { const i = jwtClaim(t, 'iat'); return i === undefined ? undefined : i * 1000 }
const jwtSubject = (t) => { const s = jwtClaim(t, 'sub'); return typeof s === 'string' ? s : '' }
const jwtNickname = (t) => { const n = jwtClaim(t, 'nickname'); return typeof n === 'string' ? n : '' }

/**
 * 绝对过期毫秒串。优先绝对字段；否则相对字段（秒）加 JWT iat（或 now）基准。
 * 都拿不到 -> 空串（对齐上游 unwrap_or(0)）。
 */
function absoluteExpiryMs(record, absKey, relKey, accessToken) {
  const abs = record && record[absKey]
  const absNum = Number(abs)
  if (Number.isFinite(absNum) && absNum > 0) return String(absNum > 1e12 ? absNum : absNum * 1000)
  if (typeof abs === 'string' && abs.trim()) {
    const parsed = Date.parse(abs)
    if (Number.isFinite(parsed)) return String(parsed)
  }
  const rel = readNumber(record, relKey)
  if (rel === undefined) return ''
  const base = jwtIssuedAtMs(accessToken) ?? Date.now()
  return String(base + rel * 1000)
}

export function parseTokenData(data) {
  const record = data && typeof data === 'object' ? data : {}
  const accessToken = readString(record, 'accessToken')
  const tokenType = readString(record, 'tokenType')
  return {
    accessToken,
    refreshToken: readString(record, 'refreshToken'),
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: tokenType || 'Bearer',
    scope: readString(record, 'scope'),
    domain: readString(record, 'domain'),
  }
}

export function parseAccountData(data) {
  const record = data && typeof data === 'object' ? data : {}
  const t = readString(record, 'type')
  return {
    uid: readString(record, 'uid'),
    nickname: readString(record, 'nickname'),
    enterpriseId: readString(record, 'enterpriseId'),
    accountType: t || 'personal',
  }
}

export function buildCredential(token, account) {
  const nickname = account.nickname || jwtNickname(token.accessToken)
  const cred = {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid || jwtSubject(token.accessToken),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
  for (const k of Object.keys(cred)) if (cred[k] === undefined) delete cred[k]
  return cred
}

/** 打开系统浏览器：Windows 用 Start-Process，mac/linux 用 open/xdg-open。 */
export async function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      const script = `Start-Process -FilePath '${String(url).replaceAll("'", "''")}' -ErrorAction Stop`
      const systemRoot = process.env.SystemRoot || 'C:\\Windows'
      await runFile(
        path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 },
      )
    } else {
      await runFile(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url], { timeout: 10000 })
    }
    return true
  } catch { return false }
}

function decorateLoginUrl(authUrl, product) {
  if (!product.appendSessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    if (product.pluginVersion) url.searchParams.set('version', product.pluginVersion)
    url.searchParams.set('loginSessionId', globalThis.crypto?.randomUUID?.() || String(Date.now()))
    return url.toString()
  } catch { return authUrl }
}

async function httpRequest(method, url, headers, opts) {
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), ...(opts.signal ? [opts.signal] : [])])
  let response
  try {
    response = await opts.fetcher(url, { method, headers, signal })
  } catch (error) {
    throw new Error(`${opts.product.id} ${method} 网络错误: ${String((error && error.message) || error)}`)
  }
  let body = null
  try { body = await response.json() } catch { body = null }
  return { status: response.status, body }
}

async function fetchAuthState(fetcher, product, signal) {
  const url = `${product.endpoint}${AUTH_STATE_PATH}?platform=${encodeURIComponent(product.platform)}`
  const headers = {
    'X-Domain': product.apiDomain,
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true',
    'User-Agent': product.userAgent,
  }
  const { status, body } = await httpRequest('POST', url, headers, { fetcher, timeoutMs: STATE_REQUEST_TIMEOUT_MS, product, signal })
  if (status !== 200) throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`)
  const data = responseData(body)
  if (!data || typeof data !== 'object') throw new Error(`auth/state 响应缺少 data: ${JSON.stringify(body).slice(0, 160)}`)
  const state = readString(data, 'state')
  const authUrl = readString(data, 'authUrl')
  if (!state) throw new Error('auth/state 响应缺少 state')
  if (!authUrl) throw new Error('auth/state 响应缺少 authUrl')
  return { state, authUrl }
}

async function loopGetToken(state, opts) {
  const url = `${opts.product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers = { 'X-No-Authorization': 'true', 'User-Agent': opts.product.userAgent }
  const deadline = Date.now() + (opts.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('登录超时（5 分钟内未完成浏览器授权）')
    if (opts.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result
    try {
      result = await httpRequest('GET', url, headers, { ...opts, timeoutMs: REQUEST_TIMEOUT_MS })
    } catch { continue }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseTokenData(data)
      continue
    }
    const code = responseCode(body)
    if (code === CODE_TOKEN_NOT_READY) continue
    throw new Error(`auth/token HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

async function getAccount(state, token, opts) {
  const url = `${opts.product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers = {
    // 空串必须回退到产品域名；登录时服务端刚下发的 domain 权威，优先用它。
    'X-Domain': token.domain || opts.product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'User-Agent': opts.product.userAgent,
  }
  const deadline = Date.now() + (opts.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取账户信息超时')
    if (opts.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result
    try {
      result = await httpRequest('GET', url, headers, { ...opts, timeoutMs: REQUEST_TIMEOUT_MS })
    } catch { continue }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseAccountData(data)
      continue
    }
    const code = responseCode(body)
    if (code === CODE_ACCOUNT_NOT_READY) continue
    throw new Error(`login/account HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

/**
 * 第一步：取 state 与登录 URL（快，秒级）。调用方可立即把 loginUrl 返给 UI，
 * 再把 completeBuddyLogin 放后台跑——登录轮询最长 5 分钟，不能阻塞请求。
 */
export async function beginBuddyLogin(opts = {}) {
  const product = opts.product ?? PRODUCTS.buddy
  const fetcher = opts.fetcher ?? fetch
  const { state, authUrl } = await fetchAuthState(fetcher, product, opts.signal)
  return { state, loginUrl: decorateLoginUrl(authUrl, product), product }
}

/**
 * 第二/三步：轮询 token 与账户，组装凭据。
 * 未带 opts.openBrowser 时不重复打开浏览器（begin 阶段已交给调用方处理）。
 */
export async function completeBuddyLogin(state, opts = {}) {
  const product = opts.product ?? PRODUCTS.buddy
  const fetcher = opts.fetcher ?? fetch
  const pollOpts = {
    fetcher,
    product,
    signal: opts.signal,
    ...opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {},
    ...opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {},
  }
  const token = await loopGetToken(state, pollOpts)
  const account = await getAccount(state, token, pollOpts)
  const credential = buildCredential(token, account)
  return {
    credential,
    credentialJson: JSON.stringify(credential),
    expiresAt: Number(credential.expires_at) || 0,
    refreshable: !!credential.refresh_token,
    userId: credential.user_id || '',
    nickname: credential.nickname || '',
  }
}

/**
 * 一步式登录（CLI / 测试用）：begin + 打开浏览器 + complete。
 * 返回 { credential, credentialJson, expiresAt, loginUrl, refreshable, userId, nickname }。
 * 不在此写凭据库——交给调用方按账号池规则决定 ref 名。
 *
 * @param opts.product       PRODUCTS 项（buddy / workbuddy）
 * @param opts.fetcher       注入 fetch（测试用）
 * @param opts.openBrowser   注入开浏览器（测试可 no-op）
 * @param opts.signal        取消信号
 * @param opts.timeoutMs     整体轮询超时
 * @param opts.pollIntervalMs 轮询间隔
 */
export async function runBuddyLogin(opts = {}) {
  const product = opts.product ?? PRODUCTS.buddy
  const open = opts.openBrowser ?? openBrowser
  const { state, loginUrl } = await beginBuddyLogin({ ...opts, product })
  const opened = await open(loginUrl)
  const done = await completeBuddyLogin(state, { ...opts, product })
  return { ...done, loginUrl, browserOpened: !!opened }
}
