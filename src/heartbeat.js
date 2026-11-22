/**
 * 透明心跳：安装量与活跃度统计。
 *
 * 设计原则（这三条是硬约束，测试逐条断言）：
 *
 * 1. **绝不发送任何身份信息**。没有账号、没有 token、没有 cookie、没有项目路径、
 *    没有用户名、没有机器名、没有硬件指纹。只发送：安装 ID、版本号、平台、
 *    安装来源种类、时间戳。
 * 2. **安装 ID 是本地随机生成的**，与任何真实身份无关，且用户可随时删掉重置。
 * 3. **完全可关**。`telemetry: false` 立即停止；且默认**不阻塞**启动、失败静默。
 *
 * 为什么不发送更多：这个插件的用户大多是被"免费模型"吸引来的普通用户，
 * 他们没有义务为了一份使用统计交出任何数据。少发一点，才敢写在 README 第一页。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 默认上报端点。空串表示"未配置"，此时完全不发请求。 */
export const DEFAULT_TELEMETRY_URL = ''

/** 心跳最多这么多次失败后不再重试（避免无网环境反复打日志）。 */
const MAX_RETRY = 2

/** 主机名/用户名这类字符串一律不进 payload；这里做最后一道过滤。 */
const FORBIDDEN_KEYS = new Set([
  'hostname', 'host', 'username', 'user', 'home', 'cwd', 'path', 'cwdPath',
  'token', 'accessToken', 'access_token', 'refresh_token', 'refreshToken',
  'email', 'machineId', 'mac', 'serial', 'ip', 'argv', 'env',
])

/**
 * 读取（或首次生成）本地安装 ID。
 *
 * 存 `$DSH_HOME/dsh-codebuddy/install-id.json`，只有 `{ id }` 一个字段。
 * 文件损坏、目录不可写、任何异常 → 返回 null，调用方放弃本次上报。
 * 不抛错：统计失败绝不能影响插件主功能。
 */
export function readInstallId(home) {
  try {
    const dir = path.join(String(home || ''), 'dsh-codebuddy')
    const file = path.join(dir, 'install-id.json')
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw && typeof raw.id === 'string' && /^[0-9a-f]{32}$/.test(raw.id)) return raw.id
    } catch { /* 不存在或损坏，下面重建 */ }

    const id = crypto.randomBytes(16).toString('hex')
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ id }), 'utf8')
    } catch { /* 写不了就只用这一次，不持久化 */ }
    return id
  } catch {
    return null
  }
}

/** 组装 payload。纯函数，测试直接调用它断言"不含敏感字段"。 */
export function buildPayload({ installId, version, platform, sourceKind, event }) {
  const payload = {
    // 事件类型：install（首次）/ daily（每日活跃）
    event: event === 'install' ? 'install' : 'daily',
    installId: String(installId || ''),
    version: String(version || ''),
    // 只区分 win32 / darwin / linux，不做更细的平台指纹
    platform: String(platform || ''),
    // git / local / other / unknown：用来区分"能自动更新的"和"不能的"
    source: String(sourceKind || 'unknown'),
    // 只到天，避免精确时序
    day: new Date().toISOString().slice(0, 10),
  }
  for (const k of Object.keys(payload)) {
    if (FORBIDDEN_KEYS.has(k)) delete payload[k]
  }
  return payload
}

/**
 * 决定这次是否要发。
 *
 * 返回 { send: boolean, event, key, reason }。
 * `state` 是本地保存的上次上报信息；同一天不重复上报，避免刷量。
 */
export function planSend({ state, installId, now = Date.now() }) {
  if (!installId) return { send: false, reason: 'no-install-id' }
  const today = new Date(now).toISOString().slice(0, 10)
  const prev = state && typeof state === 'object' ? state : {}

  // 失败退避：端点挂了（作者关机器、服务器搬迁、被墙）时不要每次启动都重试。
  // 30 分钟起步，逐次翻倍，封顶 24 小时。这样即使对方天天重启，
  // 也最多每天试一次，不会刷日志、不会反复超时。
  if (prev.failAt) {
    const fails = Math.max(1, Number(prev.failCount) || 1)
    const wait = Math.min(24 * 3_600_000, 1_800_000 * Math.pow(2, Math.min(fails - 1, 6)))
    if (now - Number(prev.failAt) < wait) return { send: false, reason: 'backoff' }
  }

  if (prev.day === today) return { send: false, reason: 'already-reported-today' }
  // 从来没上报过 → install；之后都是 daily
  const event = prev.firstAt ? 'daily' : 'install'
  return { send: true, event, key: `${installId}:${today}` }
}

/** 读/写上传统计状态。失败静默。 */
export function readState(home) {
  try {
    const p = path.join(String(home || ''), 'dsh-codebuddy', 'telemetry.json')
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

export function writeState(home, state) {
  try {
    const dir = path.join(String(home || ''), 'dsh-codebuddy')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'telemetry.json'), JSON.stringify(state), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 发一次心跳。**永不 throw、永不 reject**。
 *
 * 用短超时（4s）+ AbortController：没网时不能让后台任务挂住。
 * 返回 { ok, skipped?, error? } 供调用方记日志与自检。
 */
export async function sendHeartbeat({
  url = DEFAULT_TELEMETRY_URL,
  payload,
  fetchImpl = fetch,
  timeoutMs = 4000,
} = {}) {
  if (!url) return { ok: false, skipped: true, error: 'telemetry-url-not-configured' }
  if (!payload || !payload.installId) return { ok: false, skipped: true, error: 'no-install-id' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch { /* ignore */ } }, timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    // 202/204/200 都算成功；不解析响应体，少一次解析就少一处风险
    return { ok: res && res.ok === true, status: res && res.status }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 在后台排一次心跳。不阻塞装载，失败不影响任何功能。
 *
 * 与自动更新一样用 unref 定时器：不阻止进程退出。
 */
export function scheduleHeartbeat({ cfg, logger, home, version, sourceKind, platform, fetchImpl, delayMs = 20_000 }) {
  // 默认开启（这是"透明"的另一半：能被审计、能被关掉，但默认工作在岗）。
  if (cfg && cfg.telemetry === false) return null
  const url = String((cfg && cfg.telemetryUrl) || DEFAULT_TELEMETRY_URL || '').trim()
  if (!url) return null

  const run = async () => {
    try {
      const installId = readInstallId(home)
      const state = readState(home)
      const plan = planSend({ state, installId })
      if (!plan.send) return
      const payload = buildPayload({ installId, version, platform, sourceKind, event: plan.event })
      const result = await sendHeartbeat({ url, payload, fetchImpl })
      if (result.ok) {
        writeState(home, {
          day: payload.day,
          firstAt: state.firstAt || Date.now(),
          lastAt: Date.now(),
          count: (Number(state.count) || 0) + 1,
          version,
          // 成功即清零失败计数
          failAt: 0,
          failCount: 0,
        })
      } else if (!result.skipped) {
        const failCount = (Number(state.failCount) || 0) + 1
        // 记下失败时刻，供 planSend 做退避
        writeState(home, { ...state, failAt: Date.now(), failCount })
        // 只在**当天第一次**失败时说话。作者关机器、服务器搬迁都可能让端点长时间不可达，
        // 那不是用户的问题，不该让人每次启动都看见一条红字。
        if (!state.failAt || String(state.failDay || '') !== payload.day) {
          logger?.warn?.(`[codebuddy] 心跳上报失败（不影响使用，将自动重试）：${result.error || result.status}`)
        }
        writeState(home, { ...readState(home), failDay: payload.day })
      }
    } catch (error) {
      logger?.warn?.(`[codebuddy] 心跳任务异常（不影响使用）：${String(error && error.message || error)}`)
    }
  }

  // 错开启动高峰：更新检查是 60s，心跳放 20s，避免两个请求撞在一起。
  const timer = setTimeout(run, Math.max(1000, delayMs))
  timer.unref?.()
  return timer
}
