/**
 * dsh-codebuddy 心跳接收端（极简、可自托管）
 *
 * 单文件、零依赖、只用 Node 内置模块。目的：让你能真的看到「有多少人在用」，
 * 而不是装了一个只会往外发、却没人接的发报机。
 *
 * 跑起来：
 *   node server/heartbeat-server.mjs
 *   # 默认 http://0.0.0.0:8787  数据落在同目录 heartbeat-data/
 *
 * 环境变量：
 *   PORT=8787               监听端口
 *   DATA_DIR=./heartbeat-data  数据目录
 *   ADMIN_TOKEN=xxx         查看统计需要带的 token（GET /stats?token=xxx）
 *                           不设置则只允许本机访问 /stats
 *
 * 端点：
 *   POST /hb                接收心跳（插件调这个）
 *   GET  /stats             汇总（需要 ADMIN_TOKEN 或来自本机）
 *   GET  /health            存活探测
 *
 * 存什么：只有插件发来的 6 个字段 + 收到时间。
 * 不存 IP（如果你需要防刷，用下面的 rate limit 而不是记录 IP）。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const PORT = Number(process.env.PORT || 8787)
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'heartbeat-data')
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '')

const FILE = path.join(DATA_DIR, 'events.ndjson')

/** 同一安装同一天只记一次：防止重放刷量。 */
const seen = new Set()
/** 简易内存限流：每 IP 每分钟最多 30 次。只用于限流，不落盘。 */
const hits = new Map()
const RATE_WINDOW = 60_000
const RATE_MAX = 30

function rateLimited(ip) {
  const now = Date.now()
  const rec = hits.get(ip)
  if (!rec || now - rec.start > RATE_WINDOW) {
    hits.set(ip, { start: now, n: 1 })
    return false
  }
  rec.n += 1
  return rec.n > RATE_MAX
}

/** 严格白名单：只接受这 6 个字段，多余字段一律丢弃。 */
function sanitize(body) {
  const out = {
    event: body.event === 'install' ? 'install' : 'daily',
    installId: typeof body.installId === 'string' ? body.installId.slice(0, 64) : '',
    version: typeof body.version === 'string' ? body.version.slice(0, 32) : '',
    platform: typeof body.platform === 'string' ? body.platform.slice(0, 16) : '',
    source: typeof body.source === 'string' ? body.source.slice(0, 16) : '',
    day: typeof body.day === 'string' ? body.day.slice(0, 10) : '',
  }
  if (!/^[0-9a-f]{8,64}$/.test(out.installId)) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.day)) return null
  return out
}

function readEvents() {
  try {
    return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 汇总：这是你真正想要的那几个数。 */
function summarize(events) {
  const installs = new Map() // installId -> { firstSeen, days:Set, versions:Set, platform, source }
  for (const e of events) {
    let r = installs.get(e.installId)
    if (!r) {
      r = { firstSeen: e.receivedAt || e.day, days: new Set(), versions: new Set(), platform: e.platform, source: e.source }
      installs.set(e.installId, r)
    }
    r.days.add(e.day)
    if (e.version) r.versions.add(e.version)
    if (e.platform) r.platform = e.platform
    if (e.source) r.source = e.source
  }

  const now = Date.now()
  const DAY = 86_400_000
  const activeSince = (ms) => [...installs.values()].filter((r) => {
    const last = Math.max(...[...r.days].map((d) => Date.parse(d + 'T00:00:00Z')))
    return now - last <= ms
  }).length

  const byPlatform = {}
  const bySource = {}
  const byVersion = {}
  for (const r of installs.values()) {
    byPlatform[r.platform || '?'] = (byPlatform[r.platform || '?'] || 0) + 1
    bySource[r.source || '?'] = (bySource[r.source || '?'] || 0) + 1
    for (const v of r.versions) byVersion[v] = (byVersion[v] || 0) + 1
  }

  return {
    // 总安装数：不同 installId 的个数。这是"重复安装不重复计数"的口径。
    totalInstalls: installs.size,
    active7d: activeSince(7 * DAY),
    active30d: activeSince(30 * DAY),
    totalEvents: events.length,
    byPlatform,
    bySource,
    byVersion,
    // 每个安装的明细，方便看图
    installs: [...installs.entries()].map(([id, r]) => ({
      installId: id.slice(0, 8) + '…',
      firstSeen: r.firstSeen,
      lastDay: [...r.days].sort().pop(),
      days: r.days.size,
      platform: r.platform,
      source: r.source,
      versions: [...r.versions],
    })).sort((a, b) => String(b.lastDay).localeCompare(String(a.lastDay))),
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const ip = req.socket.remoteAddress || '?'
  const json = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  if (url.pathname === '/health') return json(200, { ok: true })

  if (url.pathname === '/hb') {
    if (req.method !== 'POST') return json(405, { ok: false, error: 'method not allowed' })
    if (rateLimited(ip)) return json(429, { ok: false, error: 'too many requests' })
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 4096) { req.destroy(); return json(413, { ok: false, error: 'payload too large' }) }
      }
      const body = sanitize(JSON.parse(raw || '{}'))
      if (!body) return json(400, { ok: false, error: 'invalid payload' })

      const key = body.installId + ':' + body.day
      if (seen.has(key)) return json(202, { ok: true, deduped: true })
      seen.add(key)

      fs.mkdirSync(DATA_DIR, { recursive: true })
      fs.appendFileSync(FILE, JSON.stringify({ ...body, receivedAt: new Date().toISOString() }) + '\n', 'utf8')
      return json(202, { ok: true })
    } catch {
      return json(400, { ok: false, error: 'bad request' })
    }
  }

  if (url.pathname === '/stats') {
    // 没设 ADMIN_TOKEN 就只允许本机，避免数据裸奔
    const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'
    const tok = url.searchParams.get('token') || req.headers['x-admin-token']
    if (ADMIN_TOKEN ? tok !== ADMIN_TOKEN : !local) {
      return json(403, { ok: false, error: 'forbidden' })
    }
    return json(200, summarize(readEvents()))
  }

  return json(404, { ok: false, error: 'not found' })
})

server.listen(PORT, () => {
  console.log(`heartbeat receiver on http://0.0.0.0:${PORT}`)
  console.log(`data: ${FILE}`)
  console.log(`stats: curl -H 'x-admin-token: <ADMIN_TOKEN>' http://127.0.0.1:${PORT}/stats`)
})
