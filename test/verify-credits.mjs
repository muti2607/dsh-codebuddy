/**
 * 积分模块单元测试（不打网络：用桩 fetch 喂真实抓到的响应）。
 *
 * 断言重点：
 *   · 三个 billing 端点都是 POST，且带 X-Product-Code（缺了会被当成未知产品）
 *   · 余额只累加「有效」包，且优先读 *Precise 字段（整数字段会把 60.92 截成 60）
 *   · 已领取(10001/1001) / 无资格(1002) / 活动结束(1003) 分别映射成不同状态
 *   · 两个端点的失败互不影响（余额挂了仍返回签到状态）
 */
import {
  fetchCreditBalance,
  fetchCheckinStatus,
  claimDailyCredit,
  fetchCreditOverview,
  creditHeaders,
} from '../src/credits.js'
import { PRODUCTS } from '../src/buddy-login.js'

const product = PRODUCTS.buddy
const credential = { access_token: 'tok-test', user_id: 'uid-1', domain: 'www.codebuddy.cn' }

/** 收集每次请求，便于断言方法与请求头。 */
const calls = []
function stubFetch(handler) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const result = handler(url, init)
    // handler 可以返回 { body, status } 来模拟「HTTP 非 2xx 但带业务码」
    const isWrapped = result && typeof result === 'object' && 'body' in result && 'status' in result
    const payload = isWrapped ? result.body : result
    const status = isWrapped ? result.status : 200
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    }
  }
}

const results = []
const check = (name, ok) => results.push({ name, ok: !!ok })

// ── 1. 请求头 ──
{
  const h = creditHeaders(product, credential)
  check('X-Product-Code 存在', h.get('x-product-code') === 'codebuddy')
  check('Accept 是 json（不是 event-stream）', h.get('accept') === 'application/json')
  check('Authorization 是 Bearer', h.get('authorization') === 'Bearer tok-test')
  check('X-Domain 取产品域名', h.get('x-domain') === 'copilot.tencent.com')
  check('X-User-Id 带上', h.get('x-user-id') === 'uid-1')
  check('X-Product 是 SaaS', h.get('x-product') === 'SaaS')
}

// ── 2. 余额：只算有效包，优先 Precise ──
{
  stubFetch(() => ({
    code: 0,
    data: {
      Response: {
        Data: {
          Accounts: [
            {
              PackageName: '有效包A', CapacityUnit: 'credits', Status: 0,
              CycleCapacityRemain: 60, CycleCapacityRemainPrecise: '60.92000001',
              CycleCapacitySize: 100, CycleCapacitySizePrecise: '100',
            },
            {
              PackageName: '有效包B', CapacityUnit: 'credits', Status: 0,
              CycleCapacityRemainPrecise: '100', CycleCapacitySizePrecise: '100',
            },
            {
              PackageName: '过期包', CapacityUnit: 'credits', Status: 3,
              CycleCapacityRemainPrecise: '500', CycleCapacitySizePrecise: '500',
            },
            {
              // 过期时间已过 → 即使 Status 不是 3 也算失效
              PackageName: '过期时间已过', CapacityUnit: 'credits', Status: 0,
              ExpiredTime: '2020-01-01 00:00:00',
              CycleCapacityRemainPrecise: '999', CycleCapacitySizePrecise: '999',
            },
          ],
        },
      },
    },
  }))
  const balance = await fetchCreditBalance(product, credential)
  check('余额用 POST', calls[0].init.method === 'POST')
  check('余额路径正确', calls[0].url.endsWith('/v2/billing/meter/get-user-resource'))
  check('body 是空 JSON', calls[0].init.body === '{}')
  check('只累加有效包 = 160.92', balance.total === 160.92)
  check('过期合计 = 1499', balance.expiredTotal === 1499)
  check('available 为 true', balance.available === true)
  check('包数量 4', balance.packages.length === 4)
  check('Precise 优先于整数', balance.packages[0].remaining === 60.92)
}

// ── 3. 余额：Accounts 缺失 → 0 且 available=false（不是抛错）──
{
  stubFetch(() => ({ code: 0, data: {} }))
  const balance = await fetchCreditBalance(product, credential)
  check('无数据时 total=0', balance.total === 0)
  check('无数据时 available=false', balance.available === false)
}

// ── 4. 签到状态映射 ──
{
  stubFetch(() => ({
    code: 0,
    data: {
      active: true, today_checked_in: true, streak_days: 25,
      daily_credit: 100, total_credits: 2500,
      activity_name: 'Buddy应用', claim_button_text: '立即领取',
      week_progress: [true, true, true, true, true, true, false],
    },
  }))
  const status = await fetchCheckinStatus(product, credential)
  check('签到路径正确', calls[0].url.endsWith('/v2/billing/meter/checkin-activity-status'))
  check('今日已领', status.checkedInToday === true)
  check('已领时 canClaim=false', status.canClaim === false)
  check('连签 25 天', status.streakDays === 25)
  check('每日 100', status.dailyCredit === 100)
  check('周进度 7 格', status.weekProgress.length === 7)
}

// ── 5. 签到：活动进行中且未领 → canClaim=true ──
{
  stubFetch(() => ({ code: 0, data: { active: true, today_checked_in: false, streak_days: 3 } }))
  const status = await fetchCheckinStatus(product, credential)
  check('未领时 canClaim=true', status.canClaim === true)
}

// ── 6. 签到：活动已结束 → 即使未领也不可领取 ──
{
  stubFetch(() => ({ code: 0, data: { active: false, today_checked_in: false } }))
  const status = await fetchCheckinStatus(product, credential)
  check('活动结束 canClaim=false', status.canClaim === false)
}

// ── 7. 领取成功 ──
{
  stubFetch(() => ({ code: 0, msg: 'OK', data: { credit: 100, streak_days: 26, is_streak_day: false } }))
  const r = await claimDailyCredit(product, credential)
  check('领取走 POST', calls[0].init.method === 'POST')
  check('领取路径正确', calls[0].url.endsWith('/v2/billing/meter/daily-checkin'))
  check('状态 claimed', r.status === 'claimed')
  check('到账 100', r.credit === 100)
  check('连签 26', r.streakDays === 26)
}

// ── 8. 已领取（两种 code）──
for (const code of [10001, 1001]) {
  stubFetch(() => ({ code, msg: '今日已签到' }))
  const r = await claimDailyCredit(product, credential)
  check(`code ${code} → already-claimed`, r.status === 'already-claimed')
  check(`code ${code} 带服务端文案`, r.message === '今日已签到')
}

// ── 8b. 回归：HTTP 400 + code 10001 必须是 already-claimed，不是 failed ──
//
// 真机实测：daily-checkin 在「今天已签到」时返回 **HTTP 400**，body 仍是
// `{"code":10001,...}`。早期实现先判 !response.ok 就抛错，结果已签到被显示成
// 「领取失败」。这条断言锁死修复。
for (const code of [10001, 1001]) {
  stubFetch(() => ({ status: 400, body: { code, msg: '今天已签到，请明天再来' } }))
  const r = await claimDailyCredit(product, credential)
  check(`HTTP400 + code ${code} → already-claimed`, r.status === 'already-claimed')
}
{
  stubFetch(() => ({ status: 400, body: { code: 1002, msg: '签到活动未开启或已过期' } }))
  const r = await claimDailyCredit(product, credential)
  check('HTTP400 + code 1002 → inactive', r.status === 'inactive')
}
{
  // 真故障：HTTP 500 且 body 没有业务码 → 仍要 failed 并带状态码
  stubFetch(() => ({ status: 500, body: { message: 'boom' } }))
  const r = await claimDailyCredit(product, credential)
  check('HTTP500 无 code → failed', r.status === 'failed')
  check('HTTP500 文案含 500', r.message.includes('500'))
}

// ── 9. 无资格 / 活动结束 ──
for (const code of [1002, 1003]) {
  stubFetch(() => ({ code, msg: '当前无领取资格' }))
  const r = await claimDailyCredit(product, credential)
  check(`code ${code} → inactive`, r.status === 'inactive')
}

// ── 10. 其它错误码 → failed（不抛）──
{
  stubFetch(() => ({ code: 500, msg: '服务异常' }))
  const r = await claimDailyCredit(product, credential)
  check('未知 code → failed', r.status === 'failed')
  check('failed 带文案', r.message === '服务异常')
}

// ── 11. 网络异常 → failed（不抛）──
{
  calls.length = 0
  globalThis.fetch = async () => { throw new Error('boom') }
  const r = await claimDailyCredit(product, credential)
  check('网络异常 → failed', r.status === 'failed')
  check('网络异常带原因', r.message.includes('boom'))
}

// ── 12. overview：一半失败不影响另一半 ──
{
  globalThis.fetch = async (url) => {
    if (url.includes('get-user-resource')) {
      return { ok: false, status: 500, text: async () => 'server error' }
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { active: true, today_checked_in: false } }),
    }
  }
  const overview = await fetchCreditOverview(product, credential)
  check('overview 仍 ok', overview.ok === true)
  check('余额失败为 null', overview.balance === null)
  check('余额失败有原因', overview.balanceError.length > 0)
  check('签到他半正常', overview.checkin && overview.checkin.active === true)
  check('签到无错误', overview.checkinError === '')
}

// ── 13. 非 JSON 响应 → 抛错（余额/签到）或 failed（领取）──
{
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>nope</html>' })
  let threw = false
  try { await fetchCreditBalance(product, credential) } catch { threw = true }
  check('非 JSON 余额抛错', threw)
  const r = await claimDailyCredit(product, credential)
  check('非 JSON 领取变 failed', r.status === 'failed')
}

// ── 汇总 ──
let bad = 0
for (const { name, ok } of results) {
  if (!ok) bad += 1
  console.log((ok ? 'OK   ' : 'FAIL ') + name)
}
console.log(bad === 0 ? `\n积分模块 ${results.length} 项检查全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
