/**
 * 透明心跳测试：把「透明」这两个字变成可执行的断言。
 *
 * 重点不是"能发出去"，而是**发出去的东西里不许有身份信息**。
 * 任何一条红了，就说明 README 里那句承诺变成了假话。
 *
 * Run: node test/verify-heartbeat.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_TELEMETRY_URL,
  readInstallId,
  buildPayload,
  planSend,
  readState,
  writeState,
  sendHeartbeat,
  scheduleHeartbeat,
} from '../src/heartbeat.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }
const ok = (m) => console.log('  ok ' + m)

// ---- 1. 安装 ID：本地随机、稳定、可持久化 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb-'))
  try {
    const a = readInstallId(home)
    const b = readInstallId(home)
    if (!a) fail('应生成安装 ID')
    if (!/^[0-9a-f]{32}$/.test(a)) fail('安装 ID 应是 32 位 hex: ' + a)
    if (a !== b) fail('同一台机器上安装 ID 必须稳定')
    // 不同 home 必须得到不同 ID（否则等于给所有人发同一个号）
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb2-'))
    const c = readInstallId(home2)
    if (a === c) fail('不同安装必须得到不同 ID')
    // 文件里只允许有 id 一个字段
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'dsh-codebuddy', 'install-id.json'), 'utf8'))
    if (Object.keys(raw).join(',') !== 'id') fail('install-id.json 只应有 id 字段，实际: ' + Object.keys(raw).join(','))
    fs.rmSync(home2, { recursive: true, force: true })
    ok('安装 ID 随机且稳定，文件只含 id')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 2. payload 契约：只允许这 6 个字段，且不含任何身份信息 ----
{
  const p = buildPayload({
    installId: 'a'.repeat(32),
    version: '1.5.4',
    platform: 'linux',
    sourceKind: 'git',
    event: 'install',
  })
  const allowed = ['event', 'installId', 'version', 'platform', 'source', 'day']
  const keys = Object.keys(p).sort()
  if (keys.join(',') !== [...allowed].sort().join(',')) {
    fail('payload 字段必须恰好是 ' + allowed.join(',') + '，实际: ' + keys.join(','))
  }
  // 逐条确认没有任何身份/环境字段
  const banned = ['hostname', 'username', 'user', 'home', 'cwd', 'path', 'token',
    'accessToken', 'access_token', 'refresh_token', 'email', 'machineId', 'mac', 'ip', 'env', 'argv']
  const json = JSON.stringify(p)
  for (const b of banned) {
    if (json.includes('"' + b + '"')) fail('payload 不得包含字段: ' + b)
  }
  // 值本身也不许出现这些东西
  for (const bad of ['/', '\\', '@', 'Bearer', 'eyJ']) {
    if (String(p.version).includes(bad) || String(p.source).includes(bad)) fail('字段值不应含 ' + bad)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day)) fail('day 只精确到日期: ' + p.day)
  ok('payload 只有 6 个白名单字段，无身份信息')
}

// ---- 3. 间隔节流：默认 1 小时一次；首报是 install，之后是 daily ----
{
  const id = 'b'.repeat(32)
  const today = '2026-11-22'
  const now = Date.parse(today + 'T10:00:00Z')
  const first = planSend({ state: {}, installId: id, now })
  if (!first.send) fail('首次应上报')
  if (first.event !== 'install') fail('首次事件应是 install，实际 ' + first.event)

  // 刚报过 → 1 小时内不再报（防刷量）
  const justNow = planSend({ state: { firstAt: now - 86400000, lastAt: now - 60_000 }, installId: id, now })
  if (justNow.send) fail('刚报过 1 分钟内不得重复上报（会刷量）')
  if (justNow.reason !== 'throttled') fail('应说明 throttled，实际 ' + justNow.reason)

  // 过了 1 小时 → 应再报一次，且事件为 daily
  const hourLater = planSend({ state: { firstAt: now - 86400000, lastAt: now - 3_600_001 }, installId: id, now })
  if (!hourLater.send) fail('超过默认间隔应上报')
  if (hourLater.event !== 'daily') fail('后续事件应是 daily，实际 ' + hourLater.event)

  // 自定义间隔：10 分钟配置下，11 分钟前报过就该再报
  const custom = planSend({
    state: { firstAt: now - 86400000, lastAt: now - 660_000 }, installId: id, now, intervalMs: 600_000,
  })
  if (!custom.send) fail('自定义 10 分钟间隔下，11 分钟前应已可上报')

  // 下限保护发生在 index.js 接收用户配置那一层（夹到 5 分钟），
  // 这一层只保证"传多少就按多少节流"。这里验证 5 分钟配置下的行为。
  const floor = planSend({
    state: { firstAt: now - 86400000, lastAt: now - 60_000 }, installId: id, now, intervalMs: 300_000,
  })
  if (floor.send) fail('间隔下限 5 分钟：1 分钟前报过不应再报')

  const noId = planSend({ state: {}, installId: null, now })
  if (noId.send) fail('没有安装 ID 时不得上报')
  if (noId.reason !== 'no-install-id') fail('应说明 no-install-id')
  ok('间隔节流、install/daily 区分、间隔下限')
}

// ---- 4. 未配置端点 → 一个请求都不发 ----
{
  let called = 0
  const fakeFetch = async () => { called++; return new Response('{}', { status: 202 }) }
  const r = await sendHeartbeat({
    url: '',
    payload: buildPayload({ installId: 'c'.repeat(32), version: '1', platform: 'linux', sourceKind: 'git' }),
    fetchImpl: fakeFetch,
  })
  if (called !== 0) fail('未配置端点时不得发请求，实际发了 ' + called + ' 次')
  if (!r.skipped) fail('未配置端点应标记 skipped')
  if (r.ok) fail('skipped 不应算成功')
  ok('端点为空的默认状态：零请求')
}

// ---- 5. 网络失败绝不 throw（统计不能影响主功能）----
{
  const boom = async () => { throw new Error('ECONNREFUSED') }
  const r = await sendHeartbeat({
    url: 'http://127.0.0.1:9/x',
    payload: buildPayload({ installId: 'd'.repeat(32), version: '1', platform: 'linux', sourceKind: 'git' }),
    fetchImpl: boom,
  })
  if (r.ok) fail('抛错不应算成功')
  if (!r.error) fail('应带回错误信息供日志用')
  // 关键：这里没有 throw，函数正常返回了
  ok('网络失败被吞掉，不 throw')
}

// ---- 6. 超时会被 abort，不会挂住后台任务 ----
{
  // 永不 resolve 的 fetch，必须被 timeout 掐断
  const hang = (url, init) => new Promise((_res, rej) => {
    init.signal.addEventListener('abort', () => rej(new Error('aborted')))
  })
  const started = Date.now()
  const r = await sendHeartbeat({
    url: 'http://127.0.0.1:9/x',
    payload: buildPayload({ installId: 'e'.repeat(32), version: '1', platform: 'linux', sourceKind: 'git' }),
    fetchImpl: hang,
    timeoutMs: 300,
  })
  const took = Date.now() - started
  if (r.ok) fail('超时不应算成功')
  if (took > 2000) fail('超时未生效，耗时 ' + took + 'ms')
  ok('超时生效（' + took + 'ms）')
}

// ---- 7. telemetry:false 一个定时器都不建 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb3-'))
  try {
    const t = scheduleHeartbeat({
      cfg: { telemetry: false, telemetryUrl: 'http://127.0.0.1:9/x' },
      logger: {},
      home,
      version: '1',
      sourceKind: 'git',
      platform: 'linux',
    })
    if (t !== null) fail('telemetry:false 时不得建立定时器')
    ok('telemetry:false 完全关闭')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 8. 状态读写失败静默 ----
{
  const state = readState('Z:/definitely/not/a/real/path/xyz')
  if (typeof state !== 'object') fail('读不到状态应返回空对象')
  const w = writeState('Z:/definitely/not/a/real/path/xyz', { day: 'x' })
  if (w !== false) fail('写不进去应返回 false')
  ok('状态读写失败静默')
}

// ---- 9. 默认端点的约定（1.6.4 起默认为开启）----
// 以前默认是空串（装上即静默）。现在作者自建了接收端，默认指向它，
// 否则收不到任何数据。这里锁死三条约定：
//   ① 默认端点必须是一个合法的 http(s) /hb 地址
//   ② 显式 `telemetryUrl: ''` 必须等于关闭（不能回落成默认值）
//   ③ 未配置时用的就是默认端点（用假 fetch 验证，绝不真的出网）
{
  const d = String(DEFAULT_TELEMETRY_URL || '')
  if (!/^https?:\/\/[^\s]+$/.test(d)) fail('默认端点必须是合法 http(s) 地址，实际 ' + JSON.stringify(d))
  if (!/\/hb$/.test(d)) fail('默认端点应以 /hb 结尾，实际 ' + d)
  ok('默认端点合法：' + d)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb9-'))
  try {
    // 显式空串 = 关闭，绝不能回落默认端点
    const t1 = scheduleHeartbeat({
      cfg: { telemetryUrl: '' }, logger: { warn() {} }, home,
      version: '1.6.4', sourceKind: 'git', platform: 'linux', delayMs: 1000,
    })
    if (t1 !== null) { clearTimeout(t1); fail('telemetryUrl 显式为空串时必须完全不发') }
    else ok('telemetryUrl 显式空串 = 关闭，不回落默认值')

    // 未配置 trelemetryUrl → 走默认端点（假 fetch 拦截，不出网）
    const sent = []
    const fakeFetch = async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response('{}', { status: 202 })
    }
    const t2 = scheduleHeartbeat({
      cfg: {}, logger: { warn() {} }, home,
      version: '1.6.4', sourceKind: 'git', platform: 'linux',
      fetchImpl: fakeFetch, delayMs: 1000,
    })
    await new Promise((r) => setTimeout(r, 1800))
    if (t2) clearTimeout(t2)
    if (sent.length !== 1) fail('未配置时应发 1 次到默认端点，实际 ' + sent.length)
    else if (!String(sent[0].url).startsWith(d)) fail('应发到默认端点，实际 ' + sent[0].url)
    else ok('未配置时默认上报到内置接收端')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 10. 完整链路：配置端点后能发且状态落盘 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb4-'))
  try {
    const sent = []
    const fakeFetch = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) })
      return new Response('', { status: 202 })
    }
    const timer = scheduleHeartbeat({
      cfg: { telemetryUrl: 'http://127.0.0.1:9/hb', dshHome: home },
      logger: {},
      home,
      version: '1.5.4',
      sourceKind: 'git',
      platform: 'linux',
      fetchImpl: fakeFetch,
      delayMs: 1000,
    })
    if (!timer) fail('配置端点后应建立定时器')
    // 等它真的跑一次
    await new Promise((r) => setTimeout(r, 1600))
    if (sent.length !== 1) fail('应发出 1 次心跳，实际 ' + sent.length)
    if (sent[0] && sent[0].body.event !== 'install') fail('第一次应是 install')
    if (sent[0] && sent[0].body.version !== '1.5.4') fail('应带版本号')
    const st = readState(home)
    if (!st.day) fail('发送成功后状态应落盘')
    if (Number(st.count) !== 1) fail('count 应为 1，实际 ' + st.count)
    ok('配置端点后发出 1 次并落盘')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 11. 端点不可达（= 作者关机器）不得影响功能，且要退避 ----
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb5-'))
  try {
    const logs = []
    const logger = { warn: (m) => logs.push(String(m)) }

    // 前提：昨天成功上报过，说明是"老用户"，今天端点挂了
    const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    writeState(home, { day: y, firstAt: Date.now() - 172800000, lastAt: Date.now() - 86400000, count: 5, version: '1.6.0' })

    // 第一次失败：应该试一次，并记一条警告
    let t = scheduleHeartbeat({
      cfg: { telemetryUrl: 'http://127.0.0.1:1/hb' }, logger, home,
      version: '1.6.0', sourceKind: 'git', platform: 'linux', delayMs: 1000,
    })
    await new Promise((r) => setTimeout(r, 1800))
    if (t) clearTimeout(t)
    if (logs.length !== 1) fail('首次失败应记 1 条警告，实际 ' + logs.length)
    const st1 = readState(home)
    if (!st1.failAt) fail('失败应落盘 failAt 以启用退避')
    if (Number(st1.failCount) !== 1) fail('failCount 应为 1，实际 ' + st1.failCount)

    // 立刻再重启一次：退避期内不得再试、不得再刷日志
    const before = logs.length
    t = scheduleHeartbeat({
      cfg: { telemetryUrl: 'http://127.0.0.1:1/hb' }, logger, home,
      version: '1.6.0', sourceKind: 'git', platform: 'linux', delayMs: 1000,
    })
    await new Promise((r) => setTimeout(r, 1800))
    if (t) clearTimeout(t)
    if (logs.length !== before) fail('退避期内不应再刷警告，实际多了 ' + (logs.length - before) + ' 条')
    ok('端点不可达：首次记一条警告，随后退避不再打扰')

    // 退避窗口应随时间指数增长且封顶 24h
    // 失败 1 次 → 窗口 30 分钟：刚失败(1 分钟前)必须还退避
    const p1 = planSend({ state: { failAt: Date.now() - 60000, failCount: 1 }, installId: 'f'.repeat(32) })
    if (p1.send) fail('失败 1 次后 30 分钟内应退避')
    if (p1.reason !== 'backoff') fail('应返回 backoff，实际 ' + p1.reason)
    // 过了 30 分钟就该重试
    const p2 = planSend({ state: { failAt: Date.now() - 1900000, failCount: 1 }, installId: 'f'.repeat(32) })
    if (!p2.send) fail('超过 30 分钟退避窗口后应重试')
    // 失败很多次 → 封顶 24h：23 小时内仍退避
    const p3 = planSend({ state: { failAt: Date.now() - 1800000, failCount: 99 }, installId: 'f'.repeat(32), now: Date.now() + 23 * 3600000 })
    if (p3.send) fail('封顶 24h：23 小时内仍应退避，实际会重试')
    // 超过 24h 应重试
    const p4 = planSend({ state: { failAt: Date.now() - 1800000, failCount: 99 }, installId: 'f'.repeat(32), now: Date.now() + 25 * 3600000 })
    if (!p4.send) fail('封顶 24h：超过 24 小时应重试')
    ok('退避指数增长且封顶 24h')

    // 恢复后应清零失败计数，回到正常日报节奏
    writeState(home, { ...readState(home), failAt: 0, failCount: 0 })
    const sent = []
    const fakeFetch = async (u, i) => { sent.push(JSON.parse(i.body)); return new Response('', { status: 202 }) }
    t = scheduleHeartbeat({
      cfg: { telemetryUrl: 'http://127.0.0.1:9/hb' }, logger, home,
      version: '1.6.0', sourceKind: 'git', platform: 'linux', fetchImpl: fakeFetch, delayMs: 1000,
    })
    await new Promise((r) => setTimeout(r, 1800))
    if (t) clearTimeout(t)
    if (sent.length !== 1) fail('恢复后应正常上报 1 次，实际 ' + sent.length)
    const st2 = readState(home)
    if (Number(st2.failCount) !== 0) fail('成功后 failCount 应清零，实际 ' + st2.failCount)
    ok('恢复后清零失败计数并继续上报')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

// ---- 12. 周期上报：DSH 开着就一直报，且能停 ----
// 旧实现是一次性 setTimeout，开着不关的机器一辈子只报一次，
// 统计里自然看起来"频率太低"。
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hb12-'))
  try {
    const sent = []
    const fakeFetch = async (url, init) => {
      sent.push(JSON.parse(init.body))
      return new Response('{}', { status: 202 })
    }
    const h = scheduleHeartbeat({
      cfg: { telemetryUrl: 'http://127.0.0.1:9/hb' },
      logger: { warn() {} }, home,
      version: '1.7.0', sourceKind: 'git', platform: 'win32',
      fetchImpl: fakeFetch,
      delayMs: 100,      // 首报
      intervalMs: 300,   // 之后每 300ms 一次（测试专用，真实默认 1 小时）
    })
    if (!h || typeof h.stop !== 'function') fail('应返回可停止的句柄')

    await new Promise((r) => setTimeout(r, 900))
    if (sent.length < 2) fail('周期上报未生效：900ms 内只发了 ' + sent.length + ' 次')
    const atStop = sent.length

    h.stop()
    await new Promise((r) => setTimeout(r, 700))
    if (sent.length !== atStop) fail('stop() 之后不应再发，实际又发了 ' + (sent.length - atStop) + ' 次')
    ok('周期上报生效，且 stop() 能彻底停掉（共 ' + atStop + ' 次）')
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}

console.log(process.exitCode ? '\nHEARTBEAT FAILED' : 'PASS heartbeat (no identity fields, opt-out works, periodic, backoff bounded)')
