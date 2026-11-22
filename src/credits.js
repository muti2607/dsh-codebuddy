/**
 * CodeBuddy / WorkBuddy 积分：查询余额 + 每日领取。
 *
 * 协议来自腾讯官方 IDE 插件用的 billing 端点（与 OFM/channel-pack 的
 * `credits.claimAll` / `credits.balances` 完全一致），三个端点都是
 * **POST + 空 JSON body**：
 *
 *   POST {endpoint}/v2/billing/meter/checkin-activity-status    签到活动状态（只读）
 *   POST {endpoint}/v2/billing/meter/get-user-resource          积分包余额（只读）
 *   POST {endpoint}/v2/billing/meter/daily-checkin              领取今日积分（写操作）
 *
 * 为什么不用 GET：这三个路由只注册了 POST，GET 一律 404（实测：26 个
 * 候选路径全是 404，换 POST 后立刻 200）。请求头里的 `X-Product-Code`
 * 是必需的，缺了会被当成未知产品。
 *
 * 实测返回（2026-11-21，CodeBuddy 个人版）：
 *   checkin-activity-status →
 *     { active, today_checked_in, streak_days, daily_credit, today_credit,
 *       total_credits, checkin_dates[], week_progress[], claim_button_text, … }
 *   get-user-resource →
 *     { data: { Response: { Data: { Accounts: [{ PackageName, CapacityUnit,
 *       CycleCapacityRemain, CycleCapacitySize, CycleCapacityRemainPrecise,
 *       Status, CycleStartTime, CycleEndTime, ExpiredTime, DeductionEndTime }] } } } }
 *   daily-checkin →
 *     { code: 0, data: { credit, streak_days, is_streak_day, message? } }
 *     已领过 → code 10001 或 1001；无资格 → 1002；活动结束 → 1003
 */

const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
const USER_RESOURCE_PATH = '/v2/billing/meter/get-user-resource'
const DAILY_CHECKIN_PATH = '/v2/billing/meter/daily-checkin'

const REQUEST_TIMEOUT_MS = 20_000

/** 积分包状态：3 = 已过期（服务端枚举，其它值都算有效）。 */
const PACKAGE_STATUS_EXPIRED = 3

const CODE_ALREADY_CLAIMED = 10001
const CODE_ALREADY_CLAIMED_ALT = 1001
const CODE_NO_QUALIFICATION = 1002
const CODE_ACTIVITY_ENDED = 1003

function readString(record, key) {
  const v = record && record[key]
  return typeof v === 'string' ? v : ''
}

function readNumber(record, key) {
  const v = record && record[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function readBool(record, key) {
  return !!(record && record[key])
}

/**
 * 精确数值优先用 `*Precise` 字符串字段。
 *
 * 服务端给的 `CycleCapacityRemain` 是整数（会把 60.92 截成 60），
 * 而 `CycleCapacityRemainPrecise` 保留小数——实测同一积分包分别是
 * `60` 与 `"60.92000001"`，所以必须优先读 Precise。
 */
function readPreciseNumber(source, baseKey) {
  const precise = source && source[`${baseKey}Precise`]
  if (typeof precise === 'string') {
    const parsed = Number.parseFloat(precise)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof precise === 'number' && Number.isFinite(precise)) return precise
  return readNumber(source, baseKey)
}

function roundCredits(value) {
  return Math.round(value * 100) / 100
}

/** 单个积分包：算出是否仍然有效，并取出剩余/总量。 */
function parsePackage(entry) {
  const status = entry && entry.Status
  const expiredTime = readString(entry, 'ExpiredTime')
  const expiredAt = expiredTime ? Date.parse(expiredTime.replace(' ', 'T')) : Number.NaN
  const deductionEndTime = readNumber(entry, 'DeductionEndTime')
  const active = status !== PACKAGE_STATUS_EXPIRED
    && !(Number.isFinite(expiredAt) && Date.now() >= expiredAt)
    && !(deductionEndTime > 0 && Date.now() >= deductionEndTime)
  return {
    name: readString(entry, 'PackageName') || readString(entry, 'SubProductName') || readString(entry, 'PackageCode'),
    unit: readString(entry, 'CapacityUnit') || readString(entry, 'OriginUnit'),
    remaining: roundCredits(readPreciseNumber(entry, 'CycleCapacityRemain')),
    total: roundCredits(readPreciseNumber(entry, 'CycleCapacitySize')),
    cycleStart: readString(entry, 'CycleStartTime'),
    cycleEnd: readString(entry, 'CycleEndTime'),
    expiresAt: expiredTime,
    active,
  }
}

/**
 * 统一的请求头。
 *
 * 与聊天端点（`buildHeaders`）的差别：这里 `X-Product-Code` 是
 * `codebuddy` / `workbuddy`，而聊天端点是产品代号；`Accept` 必须是
 * `application/json`（聊天用 `text/event-stream`，会拿到非 JSON 响应）。
 */
export function creditHeaders(product, credential) {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  headers.set('Content-Type', 'application/json')
  headers.set('X-Domain', product?.apiDomain || credential.domain || '')
  headers.set('X-Product', 'SaaS')
  headers.set('X-Product-Code', product?.productCode || product?.id || '')
  if (credential.user_id) headers.set('X-User-Id', String(credential.user_id))
  if (credential.enterprise_id) {
    headers.set('X-Enterprise-Id', String(credential.enterprise_id))
    headers.set('X-Tenant-Id', String(credential.enterprise_id))
  }
  headers.set('User-Agent', product?.userAgent || 'CodeBuddyIDE/1.106.1')
  return headers
}

async function postJson(product, credential, path, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout
  const response = await fetchWithTimeout(`${product.endpoint}${path}`, {
    method: 'POST',
    headers: creditHeaders(product, credential),
    body: '{}',
    signal: combined,
  })
  const text = await response.text()
  // 关键：**先解析 body，再看 HTTP 状态**。
  //
  // daily-checkin 在「今天已签到」时返回 HTTP 400，但 body 里是
  // `{"code":10001,"msg":"今天已签到，请明天再来"}` —— 这是业务码不是故障码。
  // 若照常规先判 !response.ok 就抛错，会把「已签到」显示成「领取失败」，
  // 用户重复点一次就看到红字（实测踩到过）。
  let parsed
  let parseFailed = false
  try {
    parsed = JSON.parse(text)
  } catch {
    parseFailed = true
  }
  if (!parseFailed && parsed && typeof parsed === 'object') {
    // 业务码优先：调用方按 code 判定成功/已领/无资格
    if (parsed.code !== undefined) return parsed
    if (response.ok) return parsed
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 120)}` : ''}`)
  }
  throw new Error('服务端返回了非 JSON 响应')
}

/**
 * 查询签到活动状态。
 *
 * @returns {Promise<{active:boolean, checkedInToday:boolean, streakDays:number,
 *   dailyCredit:number, todayCredit:number, canClaim:boolean,
 *   activityName:string, claimLabel:string, weekProgress:boolean[]}>}
 */
export async function fetchCheckinStatus(product, credential, signal) {
  const body = await postJson(product, credential, CHECKIN_STATUS_PATH, signal)
  if (body && Number(body.code) !== 0) {
    throw new Error(readString(body, 'msg') || `查询签到状态失败（code ${body.code}）`)
  }
  const d = (body && body.data) || {}
  const active = readBool(d, 'active')
  const checkedInToday = readBool(d, 'today_checked_in')
  return {
    active,
    checkedInToday,
    streakDays: readNumber(d, 'streak_days'),
    dailyCredit: readNumber(d, 'daily_credit'),
    todayCredit: readNumber(d, 'today_credit'),
    totalCredits: readNumber(d, 'total_credits'),
    // 只有「活动进行中且今天还没领」才允许点领取：这是服务端给的真状态，
    // 比客户端自己记日期可靠（换设备、跨天都能对上）。
    canClaim: active && !checkedInToday,
    activityName: readString(d, 'activity_name') || readString(d, 'theme_name'),
    claimLabel: readString(d, 'claim_button_text') || '领取',
    weekProgress: Array.isArray(d.week_progress) ? d.week_progress.map(Boolean) : [],
  }
}

/**
 * 查询积分余额。
 *
 * 返回值永远不是 null：没数据时给 `{total: 0, packages: [], available: false}`，
 * 让界面能区分「查询成功但为 0」与「查询失败」。
 */
export async function fetchCreditBalance(product, credential, signal) {
  const body = await postJson(product, credential, USER_RESOURCE_PATH, signal)
  if (body && Number(body.code) !== 0) {
    throw new Error(readString(body, 'msg') || `查询余额失败（code ${body.code}）`)
  }
  const accounts = body?.data?.Response?.Data?.Accounts
  if (!Array.isArray(accounts)) {
    return { total: 0, expiredTotal: 0, packages: [], available: false, unit: 'credits' }
  }
  const packages = accounts.filter((a) => a && typeof a === 'object').map(parsePackage)
  const total = roundCredits(packages.reduce((sum, p) => sum + (p.active ? p.remaining : 0), 0))
  const expiredTotal = roundCredits(packages.reduce((sum, p) => sum + (p.active ? 0 : p.remaining), 0))
  const units = [...new Set(packages.map((p) => p.unit).filter(Boolean))]
  return {
    total,
    expiredTotal,
    packages,
    // 有账户记录就算查到了；哪怕全是已过期包（total 为 0）也给 true，
    // 这样界面不会把「额度用完了」误报成「查询失败」。
    available: true,
    unit: units.length === 1 ? units[0] : 'credits',
  }
}

/**
 * 领取今日积分（写操作）。
 *
 * 幂等性靠服务端状态码：已领过返回 10001/1001，视为 `already-claimed`
 * 而不是失败——否则用户重复点会看到红色报错，观感很差。
 *
 * @returns {Promise<{status:'claimed'|'already-claimed'|'inactive'|'failed',
 *   credit:number, streakDays:number, message:string}>}
 */
async function __raw_claimDailyCredit(product, credential, signal) {
  let body
  try {
    body = await postJson(product, credential, DAILY_CHECKIN_PATH, signal)
  } catch (error) {
    return { status: 'failed', credit: 0, streakDays: 0, message: String((error && error.message) || error) }
  }
  const code = Number(body && body.code)
  const message = readString(body, 'msg')
  if (code === CODE_ALREADY_CLAIMED || code === CODE_ALREADY_CLAIMED_ALT) {
    return { status: 'already-claimed', credit: 0, streakDays: 0, message: message || '今天已经领过了' }
  }
  if (code === CODE_NO_QUALIFICATION || code === CODE_ACTIVITY_ENDED) {
    return { status: 'inactive', credit: 0, streakDays: 0, message: message || '当前没有可领取的积分' }
  }
  if (code !== 0) {
    return { status: 'failed', credit: 0, streakDays: 0, message: message || `领取失败（code ${body && body.code}）` }
  }
  const d = (body && body.data) || {}
  return {
    status: 'claimed',
    credit: readNumber(d, 'credit'),
    streakDays: readNumber(d, 'streak_days'),
    message: message || readString(d, 'message') || '领取成功',
  }
}

/**
 * 一次拿到「余额 + 签到状态」，供界面一次刷新用。
 *
 * 两个端点互不依赖，并发发；任一失败只影响自己那一半，
 * 不把整个结果打成错误（余额查不到时仍能显示签到进度）。
 */
async function __raw_fetchCreditOverview(product, credential, signal) {
  const [balance, checkin] = await Promise.all([
    fetchCreditBalance(product, credential, signal).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: String((error && error.message) || error) }),
    ),
    fetchCheckinStatus(product, credential, signal).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error: String((error && error.message) || error) }),
    ),
  ])
  return {
    ok: true,
    balance: balance.ok ? balance.value : null,
    balanceError: balance.ok ? '' : balance.error,
    checkin: checkin.ok ? checkin.value : null,
    checkinError: checkin.ok ? '' : checkin.error,
    fetchedAt: Date.now(),
  }
}


const __CREDIT_TTL_MS = 30000;
const __creditCache = new Map();
const __creditInflight = new Map();

export function invalidateCreditCache() {
  __creditCache.clear();
  __creditInflight.clear();
}

export async function fetchCreditOverview(product, credential, signal) {
  const key = JSON.stringify([product, credential, signal]);
  const hit = __creditCache.get(key);
  if (hit && Date.now() - hit.at < __CREDIT_TTL_MS) return hit.value;

  // 并发调用共享同一次拉取：否则缓存过期瞬间被多个入口同时触发，
  // 会把同一组 billing 请求打出去好几遍。
  const startRefresh = () => {
    const running = __creditInflight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const value = await __raw_fetchCreditOverview(product, credential, signal);
        if (value && typeof value === 'object' && !value.error) {
          __creditCache.set(key, { at: Date.now(), value });
        }
        return value;
      } finally {
        __creditInflight.delete(key);
      }
    })();
    __creditInflight.set(key, task);
    return task;
  };

  // 缓存过期：立刻返回旧值，后台静默刷新（stale-while-revalidate）。
  //
  // 上游 billing 实测会抽到 2.6s，而 TTL 只有 30s —— 若过期后同步等，
  // 恰好在那 30s 边界打开设置区的人就要干等一次。旧值并不比新值错，
  // 差的是几十秒的新鲜度，用户完全感觉不到；干等 2.6s 却很明显。
  if (hit) {
    startRefresh().catch(() => {});
    return hit.value;
  }

  // 冷启动没有任何旧值可用，只能等（受 fetchWithTimeout 的 4s 上限约束）。
  return startRefresh();
}

export async function claimDailyCredit(product, credential, signal) {
  try {
    return await __raw_claimDailyCredit(product, credential, signal);
  } finally {
    invalidateCreditCache();
  }
}


/**
 * 带超时的 fetch：上游 billing 接口一旦变慢或挂住，
 * 必须在有限时间内失败，绝不能让设置区的积分卡片无限期等待。
 *
 * 调用方传入的 signal 必须继续生效（取消请求时立刻停），
 * 所以这里把外部 signal 与超时 signal 合并，而不是覆盖掉。
 */
async function fetchWithTimeout(input, init = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {}
  }, timeoutMs);
  const outer = init.signal;
  let signal = controller.signal;
  if (outer) {
    if (typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([outer, controller.signal]);
    } else if (typeof outer.addEventListener === 'function') {
      if (outer.aborted) controller.abort();
      else outer.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    // 只有「超时触发、且不是调用方主动取消」才包装成超时错误；
    // 调用方取消时原样抛 AbortError，让上层按取消处理。
    if (controller.signal.aborted && !(outer && outer.aborted)) {
      const timeoutError = new Error('上游接口超时（' + timeoutMs + 'ms）：' + String(input));
      timeoutError.name = 'TimeoutError';
      timeoutError.code = 'ETIMEDOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
