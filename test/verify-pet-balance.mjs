/**
 * dsh-pet 余额查询兼容层测试。
 *
 * 重点验证与 dsh-pet 的**契约**，而不是实现细节：
 *   · id 必须是 codebuddy（否则它的注册表按 id 精确匹配会找不到）
 *   · 成功结果的形状必须是 ok/provider/shape/data，且 total 是字符串
 *   · 失败必须抛错（不能返回 0 假装余额为零）
 *   · 没装 dsh-pet 时不得抛错、不得阻塞装载
 *   · 注销函数能真正撤掉注册
 */
import { formatPoints, toPetPoints, registerPetBalance, registerPetBalanceWhenReady } from '../src/pet-balance.js'

let bad = 0
function check(name, ok, detail = '') {
  if (!ok) bad += 1
  console.log((ok ? '  ok  ' : '  FAIL') + ' ' + name + (detail ? '：' + detail : ''))
}

// ---- formatPoints ----
console.log('— 积分显示串 —')
check('整数不带小数点', formatPoints(1234) === '1234', formatPoints(1234))
check('真实小数保住两位', formatPoints(60.92) === '60.92', formatPoints(60.92))
check('一位小数不被补零', formatPoints(60.9) === '60.9', formatPoints(60.9))
check('0 显示为 "0"', formatPoints(0) === '0', formatPoints(0))
check('非法值退回 "0"', formatPoints(Number.NaN) === '0', formatPoints(Number.NaN))
// 这条是真正的回归点：上游 CycleCapacityRemain=60 会把 60.92 截成 60，
// 我们必须显示 60.92，不能被截断。
check('不把 60.92 截成 60', formatPoints(60.92) !== '60', formatPoints(60.92))

// ---- toPetPoints ----
console.log('— 结果形状（dsh-pet 契约）—')
const sample = toPetPoints(88.5, 'codebuddy')
check('ok 为 true', sample.ok === true)
check('provider 原样回填', sample.provider === 'codebuddy')
check('shape 为 points', sample.shape === 'points')
check('data.total 是字符串（契约要求）', typeof sample.data.total === 'string', typeof sample.data.total)
check('data.unit 是字符串', typeof sample.data.unit === 'string', sample.data.unit)
check('total 值正确', sample.data.total === '88.5', sample.data.total)
check('不含 full（避免错误的档位动画）', sample.data.full === undefined)

// ---- 没装 dsh-pet ----
console.log('— 没装 dsh-pet 时的容错 —')
check('ctx 为空返回 null', registerPetBalance(null, { fetchTotalCredits: async () => 1, logger: {} }) === null)
check('ctx 没有 get 返回 null', registerPetBalance({}, { fetchTotalCredits: async () => 1, logger: {} }) === null)
check(
  'get 抛错返回 null（不炸装载）',
  registerPetBalance({ get() { throw new Error('boom') } }, { fetchTotalCredits: async () => 1, logger: {} }) === null,
)
check(
  '服务在场但没有 balance.register 返回 null',
  registerPetBalance({ get: () => ({ balance: {} }) }, { fetchTotalCredits: async () => 1, logger: {} }) === null,
)
check(
  '服务在场但 balance 缺失返回 null',
  registerPetBalance({ get: () => ({}) }, { fetchTotalCredits: async () => 1, logger: {} }) === null,
)

// ---- 正常注册 ----
console.log('— 注册与取数 —')
const registered = []
const fakePet = {
  balance: {
    register(def) {
      registered.push(def)
      return () => {
        const i = registered.indexOf(def)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  },
}
const fakeCtx = { get(name) { return name === 'petApi7340' ? fakePet : undefined } }

const dispose = registerPetBalance(fakeCtx, {
  fetchTotalCredits: async () => 1234.5,
  logger: {},
})
check('返回了注销函数', typeof dispose === 'function')
check('注册表收到 1 条', registered.length === 1)
check('id 是 codebuddy（契约要求与 provider 名一致）', registered[0]?.id === 'codebuddy', registered[0]?.id)
check('fetch 是函数', typeof registered[0]?.fetch === 'function')

const out = await registered[0].fetch({ provider: 'codebuddy' })
check('取数成功 ok=true', out.ok === true)
check('取数 provider 正确', out.provider === 'codebuddy')
check('取数 total 正确', out.data.total === '1234.5', out.data.total)

dispose()
check('注销后注册表为空', registered.length === 0)

// ---- 失败路径 ----
console.log('— 失败必须抛错，不能伪造 0 —')
const reg2 = []
const fakePet2 = { balance: { register(def) { reg2.push(def); return () => { reg2.length = 0 } } } }
registerPetBalance({ get: () => fakePet2 }, {
  fetchTotalCredits: async () => { throw new Error('上游挂了') },
  logger: {},
})
let thrown = null
try { await reg2[0].fetch({ provider: 'codebuddy' }) } catch (e) { thrown = e }
check('取数失败会抛错', thrown instanceof Error, thrown && thrown.message)
check('抛的是原始原因', thrown && thrown.message === '上游挂了', thrown && thrown.message)

// 返回 undefined / NaN 也必须变成错误
const reg3 = []
const fakePet3 = { balance: { register(def) { reg3.push(def); return () => {} } } }
registerPetBalance({ get: () => fakePet3 }, { fetchTotalCredits: async () => Number.NaN, logger: {} })
let thrown2 = null
try { await reg3[0].fetch({ provider: 'codebuddy' }) } catch (e) { thrown2 = e }
check('返回 NaN 也抛错（不显示成 0）', thrown2 instanceof Error, thrown2 && thrown2.message)

// ---- id 冲突 ----
console.log('— 重复注册被拒时不炸 —')
const warnings = []
const dupPet = { balance: { register() { throw new Error('该服务商 id 已被注册: codebuddy') } } }
const dupResult = registerPetBalance({ get: () => dupPet }, {
  fetchTotalCredits: async () => 1,
  logger: { warn: (m) => warnings.push(m), info() {} },
})
check('返回 null', dupResult === null)
check('记了一条警告', warnings.length === 1, warnings[0] || '')

// ---- 延迟等待：dsh-pet 晚到 ----
console.log('— dsh-pet 晚装载时能补注册 —')
const lateRegs = []
let petReady = false
const lateCtx = {
  get(name) {
    if (name !== 'petApi7340') return undefined
    return petReady ? { balance: { register(def) { lateRegs.push(def); return () => { lateRegs.length = 0 } } } } : undefined
  },
}
const waiter = registerPetBalanceWhenReady(lateCtx, {
  fetchTotalCredits: async () => 7,
  logger: {},
}, { tries: 10, intervalMs: 50 })
check('dsh-pet 还没到时没有注册', lateRegs.length === 0)
petReady = true
await new Promise((r) => setTimeout(r, 220))
check('dsh-pet 出现后自动补注册', lateRegs.length === 1, String(lateRegs.length))
waiter.stop()
check('stop() 撤掉注册', lateRegs.length === 0)

// ---- 等待超时后放弃 ----
console.log('— 始终没装 dsh-pet 时安静放弃 —')
let attempts = 0
const neverCtx = { get() { attempts += 1; return undefined } }
const w2 = registerPetBalanceWhenReady(neverCtx, { fetchTotalCredits: async () => 1, logger: {} }, {
  tries: 3,
  intervalMs: 30,
})
await new Promise((r) => setTimeout(r, 260))
check('尝试次数有上限（不会无限重试）', attempts === 3, '实际 ' + attempts)
w2.stop()

console.log(bad === 0 ? '\nPASS pet-balance（dsh-pet 兼容层）' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
