/**
 * Client 渲染冒烟测试：用桩 React 真正执行 SettingsPage，把 createElement 树展开。
 *
 * 目的：静态检查只能证明「字符串存在」，证明不了「渲染不炸」。
 * 这里给出最小可用的 React 桩（useState/useEffect/useRef/createElement）、
 * 假的 fetch 与 document，然后把 renderer 跑一遍，断言：
 *   · 不抛异常
 *   · 余额数字真的出现在树里
 *   · 今日已签到时领取按钮 disabled
 *   · 未签到时领取按钮可点
 *   · 查询失败时显示错误文案而不是崩掉
 *
 * 这样即使没有浏览器，也能抓出 `xx is not defined`、空指针之类的问题。
 */
import { readFileSync } from 'node:fs'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail })
  if (!ok && detail !== undefined) console.log('   detail: ' + detail)
}

/** 最小 React 桩：state 存在 hook 槽位里，setState 直接改值并记录。 */
function makeReact() {
  const slot = { states: [], effects: [], refs: [], cursor: 0, component: null }
  const resetCursor = () => { slot.cursor = 0 }

  function createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
  }
  function useState(initial) {
    const i = slot.cursor++
    if (!(i in slot.states)) slot.states[i] = typeof initial === 'function' ? initial() : initial
    const set = (next) => {
      slot.states[i] = typeof next === 'function' ? next(slot.states[i]) : next
    }
    return [slot.states[i], set]
  }
  function useEffect(fn) {
    const i = slot.cursor++
    slot.effects[i] = fn
  }
  function useRef(initial) {
    const i = slot.cursor++
    if (!(i in slot.refs)) slot.refs[i] = { current: initial }
    return slot.refs[i]
  }
  return { createElement, useState, useEffect, useRef, slot, resetCursor }
}

/** 收集树里的文本，便于断言「界面上真的出现了这个数字」。 */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.children) return node.children.map(textOf).join(' ')
  return ''
}

/** 按 className 找节点。 */
function findByClass(node, cls, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach((n) => findByClass(n, cls, out)); return out }
  const cn = node.props && node.props.className
  if (typeof cn === 'string' && cn.split(/\s+/).includes(cls)) out.push(node)
  if (node.children) node.children.forEach((n) => findByClass(n, cls, out))
  return out
}

/**
 * 载入 client.js 并拿到 settings.section 的渲染函数。
 *
 * 注意：**不能在载入后就还原全局对象**。client.js 的组件在「渲染时」才会调用
 * `fetch` / `document`，如果载入完就还原，组件拿到的是 Node 的真实 fetch，
 * 会去请求真实端口而不是桩——表现为「数据永远不出现」，非常难查。
 * 因此这里返回 restore()，由调用方在整个场景结束后再还原。
 */
function loadClient(reactStub, fetchImpl) {
  const registered = []
  const globals = {
    window: {
      __ModuleLoader__: {
        load(spec) {
          const exported = spec.factory((name) => {
            if (name === 'react') return reactStub
            throw new Error('unexpected require: ' + name)
          })
          registered.push({ spec, exported })
        },
      },
    },
    document: { baseURI: 'http://127.0.0.1:53399/' },
    fetch: fetchImpl,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const saved = {}
  for (const [k, v] of Object.entries(globals)) {
    saved[k] = globalThis[k]
    globalThis[k] = v
  }
  const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // 以函数方式求值，作用域干净（不污染本文件的模块作用域）
  // eslint-disable-next-line no-new-func
  new Function(src)()
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k]
      else globalThis[k] = v
    }
  }
  return { registered: registered[0], restore }
}

/** 把 apply 跑一遍，取出 settings.section 注册的 renderer，并展开函数组件到真实树。 */
function makeRenderer(spec, reactStub, props) {
  let renderer = null
  const ctx = {
    locale: { register: () => () => {} },
    slots: {
      inject(name, cb) { cb() },
      register(_meta, fn) { renderer = fn; return () => {} },
    },
  }
  spec.exported.apply(ctx)
  if (!renderer) throw new Error('settings.section 未注册')
  return () => {
    reactStub.resetCursor()
    reactStub.slot.effects.length = 0
    let tree = renderer(props || { t: (k) => k })
    let guard = 0
    while (tree && typeof tree.type === 'function' && guard++ < 10) {
      const fn = tree.type
      reactStub.resetCursor()
      reactStub.slot.effects.length = 0
      tree = fn(tree.props)
    }
    return tree
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 跑 render → effect → 等 promise → 再 render，直到状态稳定。
 *
 * 真实浏览器里 useEffect 在首帧之后跑，异步数据回来再触发一次渲染。
 * 桩环境必须手工模拟这个循环，否则断言看到的永远是「数据还没到」的首帧。
 */
async function renderSettled(render, reactStub, rounds = 12) {
  let tree = render()
  for (let r = 0; r < rounds; r++) {
    const effects = reactStub.slot.effects.slice()
    if (r > 0 && effects.length === 0) break
    for (const fn of effects) {
      if (typeof fn !== 'function') continue
      try { fn() } catch { /* effect 内部错误由组件自己处理 */ }
    }
    await tick(); await tick(); await tick()
    tree = render()
  }
  return tree
}

// ─────────────────────────── 场景 ───────────────────────────

const BASE_ACCOUNTS = {
  ok: true,
  accounts: [
    { id: 'buddy-1', provider: 'buddy', nickname: '有充电宝不用去中厅', enabled: true, refreshable: true, expiresAt: 1797679824000, createdAt: 1, hasCredential: true },
  ],
  pending: [],
}

function makeCredits({ total, checkedInToday, canClaim, balanceOk = true }) {
  return {
    ok: true,
    total,
    accounts: [{
      accountId: 'buddy-1',
      provider: 'buddy',
      nickname: '有充电宝不用去中厅',
      ok: balanceOk,
      balance: balanceOk ? { total, expiredTotal: 12.5, packages: [], available: true, unit: 'credits' } : null,
      balanceError: balanceOk ? '' : 'HTTP 500',
      checkin: {
        active: true,
        checkedInToday,
        canClaim,
        streakDays: 25,
        dailyCredit: 100,
        totalCredits: 2500,
        activityName: 'Buddy应用',
        claimLabel: '立即领取',
        weekProgress: [true, true, true, true, true, true, false],
      },
      checkinError: '',
      fetchedAt: Date.now(),
    }],
  }
}

function makeFetch(handlers) {
  return async (url, init) => {
    const path = String(url)
    let body
    for (const [frag, value] of handlers) {
      if (path.includes(frag)) { body = typeof value === 'function' ? value(init) : value; break }
    }
    if (body === undefined) body = { ok: false, error: 'no-handler:' + path }
    return { ok: true, status: 200, text: async () => JSON.stringify(body) }
  }
}

/** 模型清单桩：默认全部启用。 */
function makeModels(disabled = []) {
  const ids = [
    ['auto', 'Auto'], ['hy4std', 'Hy4'], ['hy4flash', 'Hy4 flash'],
    ['hy4flash-free', 'Hy4 flash (free)'], ['glm-5.3', 'GLM-5.3'],
  ]
  const off = new Set(disabled)
  const models = ids.map(([id, name]) => ({ id, name, enabled: !off.has(id) }))
  const enabledCount = models.filter((m) => m.enabled).length
  return { ok: true, models, total: models.length, enabledCount, allDisabled: enabledCount === 0 }
}

const scenarios = [
  {
    name: '已签到 → 余额显示 + 领取按钮禁用',    handlers: [
      ['/api/cb/credits', makeCredits({ total: 460.92, checkedInToday: true, canClaim: false })],
      ['/api/cb/models', makeModels()],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.0' }],
    ],
    assert(tree) {
      const text = textOf(tree)
      check('余额 460.92 出现在界面', text.includes('460.92'), text.slice(0, 200))
      const creditsVal = findByClass(tree, 'cb_creditval')
      check('有余额大数字节点', creditsVal.length === 1, String(creditsVal.length))
      const btns = findByClass(tree, 'cb_btn')
      const claimBtn = btns.find((b) => textOf(b).includes('claim'))
      check('找到领取按钮', !!claimBtn)
      check('已签到时领取按钮 disabled', claimBtn && claimBtn.props.disabled === true)
      check('出现「今日已签到」', text.includes('checkedIn'))
      check('出现连签天数', text.includes('streak'))
    },
  },
  {
    name: '未签到 → 领取按钮可点',
    handlers: [
      ['/api/cb/credits', makeCredits({ total: 560.92, checkedInToday: false, canClaim: true })],
      ['/api/cb/models', makeModels()],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.0' }],
    ],
    assert(tree) {
      const btns = findByClass(tree, 'cb_btn')
      const claimBtn = btns.find((b) => textOf(b).includes('claim'))
      check('未签到时领取按钮 enabled', claimBtn && claimBtn.props.disabled === false)
      check('未签到不显示 checkedIn', !textOf(tree).includes('checkedIn'))
    },
  },
  {
    name: '余额查询失败 → 显示错误不崩',
    handlers: [
      ['/api/cb/credits', makeCredits({ total: 0, checkedInToday: false, canClaim: true, balanceOk: false })],
      ['/api/cb/models', makeModels()],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.0' }],
    ],
    assert(tree) {
      check('失败时仍渲染出根节点', findByClass(tree, 'cb_root').length === 1)
      const text = textOf(tree)
      check('有余额为 0 的兜底显示', text.includes('0'))
    },
  },
  {
    name: '无账号 → 显示空态',
    handlers: [
      ['/api/cb/credits', { ok: false, error: '还没有可用账号，请先添加账号' }],
      ['/api/cb/models', makeModels()],
      ['/api/cb/accounts', { ok: true, accounts: [], pending: [] }],
      ['/api/codebuddy/version', { ok: true, version: '1.4.0' }],
    ],
    assert(tree) {
      const text = textOf(tree)
      check('无账号显示空态文案', text.includes('noAccount'))
      check('无账号时领取按钮禁用', (() => {
        const btn = findByClass(tree, 'cb_btn').find((b) => textOf(b).includes('claim'))
        return btn && btn.props.disabled === true
      })())
    },
  },
  {
    name: '模型开关 → 渲染全部模型并可切换',
    handlers: [
      ['/api/cb/models', makeModels(['hy4flash-free'])],
      ['/api/cb/credits', makeCredits({ total: 460.92, checkedInToday: true, canClaim: false })],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.7' }],
    ],
    assert(tree) {
      const rows = findByClass(tree, 'cb_modrow')
      check('渲染出所有模型行', rows.length === 5, String(rows.length))
      const names = rows.map((r) => textOf(findByClass(r, 'cb_modname')[0] || r))
      check('模型名都显示出来', names.some((n) => n.includes('Hy4 flash (free)')), names.join(' | '))
      const offRows = rows.filter((r) => String(r.props.className).includes('off'))
      check('停用的那行有 off 标记', offRows.length === 1, String(offRows.length))
      check('渲染了启用计数文案', textOf(tree).includes('modelsCount'))
      const enableAllBtn = findByClass(tree, 'cb_btn').find((b) => textOf(b).includes('modelsEnableAll'))
      check('有「全部启用」按钮', !!enableAllBtn)
      check('未全启用时「全部启用」可点', enableAllBtn && enableAllBtn.props.disabled === false)
      check('每个模型行都有开关按钮', findByClass(tree, 'cb_mini').length >= 5,
        String(findByClass(tree, 'cb_mini').length))
    },
  },
  {
    name: '全部停用 → 给出警示',
    handlers: [
      ['/api/cb/models', makeModels(['auto', 'hy4std', 'hy4flash', 'hy4flash-free', 'glm-5.3'])],
      ['/api/cb/credits', makeCredits({ total: 0, checkedInToday: false, canClaim: false })],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.7' }],
    ],
    assert(tree) {
      check('全部停用时出现警示文案', textOf(tree).includes('modelsAllDisabled'))
      const enableAllBtn = findByClass(tree, 'cb_btn').find((b) => textOf(b).includes('modelsEnableAll'))
      check('全部停用时「全部启用」可点', enableAllBtn && enableAllBtn.props.disabled === false)
      const rows = findByClass(tree, 'cb_modrow')
      check('全部行都是 off', rows.every((r) => String(r.props.className).includes('off')), String(rows.length))
    },
  },
  {
    name: '一个账号无签到活动 → 状态分三态并说明原因',
    handlers: [
      ['/api/cb/models', makeModels()],
      ['/api/cb/credits', {
        ok: true,
        total: 810.92,
        accounts: [
          {
            accountId: 'buddy-1', provider: 'buddy', nickname: '有充电宝不用去中厅', ok: true,
            balance: { total: 460.92, expiredTotal: 0, packages: [], available: true, unit: 'credits' },
            balanceError: '',
            checkin: {
              active: true, checkedInToday: true, canClaim: false, streakDays: 25,
              dailyCredit: 100, weekProgress: [true, true, true, true, true, true, false],
            },
            checkinError: '',
          },
          {
            accountId: 'wb-1', provider: 'workbuddy', nickname: 'muti2607', ok: true,
            balance: { total: 350, expiredTotal: 0, packages: [], available: true, unit: 'credits' },
            balanceError: '',
            // 关键：活动未开通。today_checked_in 同样是 false，但这不是「今天没签」
            checkin: {
              active: false, checkedInToday: false, canClaim: false, streakDays: 0,
              dailyCredit: 100, activityName: '', weekProgress: [],
            },
            checkinError: '',
          },
        ],
      }],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.8' }],
    ],
    assert(tree) {
      const text = textOf(tree)
      check('无活动账号显示「无签到活动」', text.includes('checkinNoActivity'))
      check('已签账号仍显示「今日已签到」', text.includes('checkedIn'))
      check('不再误报「今日未签到」', !text.includes('notCheckedIn'), '出现了 notCheckedIn')
      const claimBtn = findByClass(tree, 'cb_btn').find((b) => textOf(b).includes('claim'))
      check('无可领取时领取按钮仍禁用', claimBtn && claimBtn.props.disabled === true)
      check('给出「已领完」的原因', text.includes('claimHintAllDone'))
      check('同时说明还有账号没活动', text.includes('claimHintSomeInactive'))
      check('原因渲染在 creditreason 块里', findByClass(tree, 'cb_creditreason').length === 1,
        String(findByClass(tree, 'cb_creditreason').length))
    },
  },
  {
    name: '已签到 → 提示「明天再来」而不是「没活动」',
    handlers: [
      ['/api/cb/models', makeModels()],
      ['/api/cb/credits', {
        ok: true,
        total: 460.92,
        accounts: [{
          accountId: 'buddy-1', provider: 'buddy', nickname: 'A', ok: true,
          balance: { total: 460.92, expiredTotal: 0, packages: [], available: true, unit: 'credits' },
          balanceError: '',
          checkin: { active: true, checkedInToday: true, canClaim: false, streakDays: 25, dailyCredit: 100, weekProgress: [true] },
          checkinError: '',
        }],
      }],
      ['/api/cb/accounts', BASE_ACCOUNTS],
      ['/api/codebuddy/version', { ok: true, version: '1.4.8' }],
    ],
    assert(tree) {
      const text = textOf(tree)
      check('已领完时提示明天再来', text.includes('claimHintAllDone'))
      check('已领完时不说「没活动」', !text.includes('claimHintNoActivity'))
    },
  },
]

// 跑「渲染 → effect → 等数据 → 再渲染」，断言落定后的界面
for (const sc of scenarios) {
  const reactStub = makeReact()
  const { registered, restore } = loadClient(reactStub, makeFetch(sc.handlers))
  try {
    check(`[${sc.name}] client.js 已注册`, !!registered)
    check(`[${sc.name}] 导出 apply 与 inject`, registered && typeof registered.exported.apply === 'function'
      && Array.isArray(registered.exported.inject))
    if (!registered) continue

    const render = makeRenderer(registered, reactStub)
    let tree = null
    let threw = ''
    try {
      tree = await renderSettled(render, reactStub)
    } catch (error) {
      threw = String((error && error.stack) || error)
    }
    check(`[${sc.name}] 渲染（含数据落定）不抛异常`, threw === '', threw.slice(0, 400))
    if (!tree) { check(`[${sc.name}] 返回根节点`, false); continue }
    check(`[${sc.name}] 返回根节点`, tree.props && tree.props.className === 'cb_root')
    try { sc.assert(tree) } catch (error) {
      check(`[${sc.name}] 断言执行不抛异常`, false, String((error && error.message) || error))
    }
  } finally {
    restore()
  }
}

let bad = 0
for (const { name, ok } of results) {
  if (!ok) bad += 1
  console.log((ok ? 'OK   ' : 'FAIL ') + name)
}
console.log(bad === 0 ? `\n渲染冒烟 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
