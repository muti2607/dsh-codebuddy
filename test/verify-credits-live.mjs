/**
 * 积分模块真机验证（需要真实凭据）：
 *   node test/verify-credits-live.mjs
 *
 * 只做只读验证（余额 + 签到状态），不调用领取接口——
 * 领取是写操作，留给用户点按钮，测试不去消耗。
 */
import fs from 'node:fs'
import { PRODUCTS } from '../src/buddy-login.js'
import { fetchCreditOverview, creditHeaders } from '../src/credits.js'

const YAML = 'C:\\Users\\ming\\.dsh\\.credentials.yaml'
const OUT = 'D:\\dfyqq\\dfyduihua消费记录\\_verify-credits.txt'

const lines = []
const log = (s) => lines.push(String(s))

function readCredential(ref) {
  const all = fs.readFileSync(YAML, 'utf8').split(/\r?\n/)
  const startIdx = all.findIndex((l) => l.includes(ref + ':'))
  if (startIdx < 0) return null
  let acc = ''
  for (let i = startIdx; i < all.length && i < startIdx + 40; i++) {
    const seg = i === startIdx ? all[i].slice(all[i].indexOf(':') + 1) : all[i]
    acc += (acc ? ' ' : '') + seg.trim()
    if (acc.trim().endsWith("'")) break
  }
  let v = acc.trim()
  if (v.startsWith("'")) v = v.slice(1)
  if (v.endsWith("'")) v = v.slice(0, -1)
  return JSON.parse(v.replace(/''/g, "'"))
}

const CASES = [
  { provider: 'buddy', ref: 'BUDDY_ACCOUNT_A81E3A3F' },
  { provider: 'workbuddy', ref: 'WORKBUDDY_ACCOUNT_05704C1E' },
]

let failed = 0
for (const item of CASES) {
  const product = PRODUCTS[item.provider]
  const credential = readCredential(item.ref)
  log('===== ' + item.provider + ' =====')
  if (!credential) { log('跳过：无凭据'); log(''); continue }

  log('productCode=' + product.productCode + ' endpoint=' + product.endpoint)
  const h = creditHeaders(product, credential)
  log('headers: x-domain=' + h.get('x-domain') + ' x-product-code=' + h.get('x-product-code')
    + ' accept=' + h.get('accept') + ' auth=' + (h.get('authorization') || '').slice(0, 14) + '…')

  const started = Date.now()
  try {
    const overview = await fetchCreditOverview(product, credential)
    log('耗时 ' + (Date.now() - started) + 'ms')
    if (overview.balance) {
      log('  余额 total=' + overview.balance.total + ' 单位=' + overview.balance.unit
        + ' 有效包=' + overview.balance.packages.filter((p) => p.active).length + '/' + overview.balance.packages.length)
      for (const p of overview.balance.packages.filter((x) => x.active)) {
        log('    有效包 ' + p.name + ' 剩余=' + p.remaining + '/' + p.total)
      }
    } else {
      log('  余额查询失败：' + overview.balanceError)
      failed++
    }
    if (overview.checkin) {
      const c = overview.checkin
      log('  签到 active=' + c.active + ' 今日已领=' + c.checkedInToday + ' 可领取=' + c.canClaim)
      log('        连签=' + c.streakDays + '天 每日=' + c.dailyCredit + ' 活动=' + c.activityName)
    } else {
      log('  签到查询失败：' + overview.checkinError)
      failed++
    }
  } catch (error) {
    log('  overview 抛异常：' + (error && error.message ? error.message : String(error)))
    failed++
  }
  log('')
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
console.log('failed=' + failed)
process.exit(failed > 0 ? 1 : 0)
