/**
 * dsh-pet 余额查询兼容层。
 *
 * 背景：dsh-pet（桌宠插件）的气泡里会显示「当前服务商的余额」，但它只内置了
 * opencode / commandcode / deepseek 官方 / deepseek 账号四个服务商。用本插件
 * （provider id = codebuddy）时它会报：
 *
 *   「使用这个插件时会反应当前服务商暂不支持余额查询 当前服务商：codebuddy」
 *
 * dsh-pet 为此留了公开扩展点：它把自己挂在 `ctx.provide('petApi7340', …)` 上，
 * 其中 `balance.register(def)` 允许第三方注册自己的服务商（见其
 * src/host/balance/registry.ts）。本文件就是往那儿注册一个 codebuddy 的取数实现。
 *
 * 三条设计约束（都来自 dsh-pet 的契约，不遵守会被它拒收或误显示）：
 *
 *  1. **id 必须与 agentDefaultModel 报告的 provider 名完全一致**。我们报告的
 *     就是 `codebuddy`，别名（buddy 等）是运行时另起的名字，注册表按 id 精确
 *     匹配，所以只注册 `codebuddy` 一个。
 *  2. **第三方 provider 拿不到宿主解析好的 key**（`PluginFetchContext` 里只有
 *     provider），凭证必须自己解决——这也是为什么这里要用本插件自己的账号池。
 *  3. **只走成功路径，失败必须抛错**。dsh-pet 统一把异常落成 fetch-error，
 *     绝不允许我们返回 0 来假装"余额是 0"。
 *
 * 服务名 `petApi7340` 是 dsh-pet 的魔法常量（数字后缀用于避免与别的插件撞名），
 * 只能硬编码；拿不到就静默跳过——没装 dsh-pet 是完全正常的组合。
 */

/**
 * dsh-pet 暴露的服务名。它没有导出常量，只能按源码里的字面量写死。
 */
const PET_API_SERVICE = 'petApi7340'

/**
 * 把积分接口的结果翻译成 dsh-pet 的 `points` 形态。
 *
 * 为什么用 points 而不是 money：CodeBuddy 的额度单位是「积分」，不是货币；
 * dsh-pet 的 points 形态就是为这种场景留的（`unit` 只是数字后缀）。
 *
 * `full`（档位基准）刻意不填：积分包的 `CycleCapacitySize` 是该包的总额，
 * 而余额是多个包累加的，二者不是同一个分母。填错会让气泡上的档位动画
 * 显示成"快用完了"，比不显示更糟。
 *
 * @param {number} total - 可用积分合计
 * @param {{id:string}} account - 取数用的账号（仅用于日志/排障，不进结果）
 * @returns {{ok:true, provider:string, shape:'points', data:{unit:string,total:string}}}
 */
export function toPetPoints(total, provider) {
  // dsh-pet 的 points 契约要求 total 是字符串：它原样显示、不做换算。
  const value = Number.isFinite(total) ? total : 0
  return {
    ok: true,
    provider,
    shape: 'points',
    data: {
      unit: '积分',
      total: formatPoints(value),
    },
  }
}

/**
 * 数字转显示串：整数值不带小数点，小数最多两位。
 *
 * 刻意不直接用 `toFixed(2)`：积分通常是整数，`1234.00` 显示出来既长又假；
 * 而 60.92 这种真实小数必须保住，不能被截成 60（上游 `*Precise` 字段的意义，
 * 实测 `CycleCapacityRemain` 是 60 而 `CycleCapacityRemainPrecise` 是 "60.92"）。
 */
export function formatPoints(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  // 先按两位小数归一，再让 String 天然去掉末尾的 0：
  // 整数 → "1234"，60.9 → "60.9"，60.92 → "60.92"
  return String(Math.round(n * 100) / 100)
}

/**
 * 注册 codebuddy 的余额 provider 到 dsh-pet。
 *
 * 时机与容错：dsh-pet 可能比我们后装载、也完全可能没装。所以这里
 * **不阻塞装载**，由调用方在合适的时机（`ctx.get(service, false)` 拿得到时）
 * 调一次；拿不到服务返回 null，由调用方决定是否重试。
 *
 * @param {object} hostCtx - Cordis 的 ctx（要能 `get(service, false)`）
 * @param {object} deps
 * @param {() => Promise<number>} deps.fetchTotalCredits - 取当前可用积分合计；
 *   失败时**必须抛错**（不要返回 0，那会被当成"余额为 0"显示给用户）
 * @param {{warn:Function, info:Function}} deps.logger
 * @returns {null | (() => void)} 注销函数；没装 dsh-pet 时返回 null
 */
export function registerPetBalance(hostCtx, { fetchTotalCredits, logger }) {
  if (!hostCtx || typeof hostCtx.get !== 'function') return null

  // 第二个参数 false = 取不到时返回 undefined 而不是抛错。
  // dsh-pet 没装是常态，绝不能让这里把插件装载搞崩。
  let petApi
  try {
    petApi = hostCtx.get(PET_API_SERVICE, false)
  } catch {
    return null
  }
  const register = petApi && petApi.balance && petApi.balance.register
  if (typeof register !== 'function') return null

  const def = {
    id: 'codebuddy',
    async fetch({ provider }) {
      // 失败一律抛错：dsh-pet 会把它落成 fetch-error 并显示原因，
      // 这比返回一个假的 0 诚实得多。
      const total = await fetchTotalCredits()
      if (typeof total !== 'number' || !Number.isFinite(total)) {
        throw new Error('CodeBuddy 积分查询没有返回有效数值')
      }
      return toPetPoints(total, provider || 'codebuddy')
    },
  }

  try {
    const dispose = register(def)
    logger?.info?.('[codebuddy] 已向 dsh-pet 注册余额查询（codebuddy → 积分）')
    return typeof dispose === 'function' ? dispose : null
  } catch (error) {
    // 最常见的原因是 id 冲突（重复注册）——被 dsh-pet 明确拒绝，
    // 这种情况只记一条警告，不影响插件其它功能。
    logger?.warn?.(`[codebuddy] 向 dsh-pet 注册余额查询失败：${String((error && error.message) || error)}`)
    return null
  }
}

/**
 * 等 dsh-pet 出现后再注册。
 *
 * 为什么需要等：Cordis 的装载顺序不保证，dsh-pet 可能比我们晚一步把
 * `petApi7340` 挂上去。这里做有限次重试（默认 20 次 × 1.5 秒 ≈ 30 秒），
 * 之后放弃——再晚就不会有用户还盯着气泡看余额了。
 *
 * 定时器必须 `unref()`：否则会拖住宿主进程退出。
 *
 * @returns {{stop: () => void}} 停止等待（插件卸载时调用）
 */
export function registerPetBalanceWhenReady(hostCtx, deps, { tries = 20, intervalMs = 1500 } = {}) {
  let done = false
  let timer = null
  let left = Math.max(1, tries)

  const attempt = () => {
    if (done) return
    const dispose = registerPetBalance(hostCtx, deps)
    if (dispose) {
      done = true
      disposeRef.dispose = dispose
      return
    }
    left -= 1
    if (left <= 0) {
      done = true
      return
    }
    timer = setTimeout(attempt, intervalMs)
    timer.unref?.()
  }

  const disposeRef = { dispose: null }

  // 先试一次：dsh-pet 通常先装载（它是 bundle，进配置树更早）。
  attempt()

  return {
    stop() {
      done = true
      if (timer) clearTimeout(timer)
      timer = null
      if (typeof disposeRef.dispose === 'function') {
        try { disposeRef.dispose() } catch { /* 注销失败不影响卸载 */ }
      }
      disposeRef.dispose = null
    },
  }
}
