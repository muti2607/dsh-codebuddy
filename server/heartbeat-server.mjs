/**
 * dsh-codebuddy 心跳接收端 + 仪表盘
 *
 * 单文件、零依赖、只用 Node 内置模块。
 *
 * 启动：
 *   node server/heartbeat-server.mjs
 *   默认 http://0.0.0.0:8787
 *
 * 环境变量：
 *   PORT=8787                 监听端口
 *   HOST=0.0.0.0              监听地址
 *   DATA_DIR=./heartbeat-data 数据目录
 *   ADMIN_TOKEN=xxx           仪表盘口令（强烈建议设置）
 *                             不设置则只允许本机访问
 *
 * 端点：
 *   GET  /          仪表盘（要口令）
 *   POST /hb        插件上报（公开）
 *   GET  /stats     JSON 汇总（要口令）
 *   GET  /health    存活探测（公开）
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'heartbeat-data')
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '')

const FILE = path.join(DATA_DIR, 'events.ndjson')

/** 内存去重：同安装同一天只记一次。进程重启后靠文件里的记录再兜一层。 */
const seen = new Set()
let seenLoaded = false

function loadSeen() {
  if (seenLoaded) return
  seenLoaded = true
  for (const e of readEvents()) {
    if (e && e.installId && e.day) seen.add(e.installId + ':' + e.day)
  }
}

/** 简易限流：每 IP 每分钟 60 次。只用于防刷，不落盘、不记录。 */
const hits = new Map()
const RATE_WINDOW = 60_000
const RATE_MAX = 60
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
  if (!body || typeof body !== 'object') return null
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
    return fs.readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function dayMs(d) { return Date.parse(d + 'T00:00:00Z') }

function summarize(events) {
  const installs = new Map()
  for (const e of events) {
    let r = installs.get(e.installId)
    if (!r) {
      r = {
        firstSeen: e.receivedAt || e.day,
        days: new Set(),
        versions: new Set(),
        platform: e.platform || '?',
        source: e.source || '?',
        firstEvent: e.event,
      }
      installs.set(e.installId, r)
    }
    r.days.add(e.day)
    if (e.version) r.versions.add(e.version)
    if (e.platform) r.platform = e.platform
    if (e.source) r.source = e.source
  }

  const now = Date.now()
  const DAY = 86_400_000
  const lastMs = (r) => Math.max(...[...r.days].map(dayMs).filter((n) => !Number.isNaN(n)))
  const activeSince = (ms) => [...installs.values()].filter((r) => now - lastMs(r) <= ms).length

  const byPlatform = {}, bySource = {}, byVersion = {}
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1 }
  for (const r of installs.values()) {
    bump(byPlatform, r.platform)
    bump(bySource, r.source)
    for (const v of r.versions) bump(byVersion, v)
  }

  // 最近 14 天的每日活跃（按上报去重后的天）
  const daily = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY).toISOString().slice(0, 10)
    const n = [...installs.values()].filter((r) => r.days.has(d)).length
    daily.push({ day: d, n })
  }

  const sortedLast = [...installs.values()].map(lastMs)
  const latest = sortedLast.length ? Math.max(...sortedLast) : 0

  return {
    totalInstalls: installs.size,
    active7d: activeSince(7 * DAY),
    active30d: activeSince(30 * DAY),
    activeToday: activeSince(1 * DAY),
    totalEvents: events.length,
    latestReportDay: latest ? new Date(latest).toISOString().slice(0, 10) : null,
    byPlatform, bySource, byVersion, daily,
    installs: [...installs.entries()].map(([id, r]) => ({
      installId: id.slice(0, 8),
      firstSeen: r.firstSeen,
      lastDay: [...r.days].sort().pop(),
      days: r.days.size,
      platform: r.platform,
      source: r.source,
      versions: [...r.versions].sort(),
    })).sort((a, b) => String(b.lastDay).localeCompare(String(a.lastDay))),
  }
}

// ───────────────────────────── 页 面 ─────────────────────────────

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }
const SOURCE_LABEL = {
  git: 'GitHub 源', local: '本地包', other: '其他', unknown: '未知',
}

function bar(label, n, total, accent) {
  const pct = total > 0 ? Math.round((n / total) * 100) : 0
  return `<div class="row">
    <div class="rowhead"><span class="rowlabel">${esc(label)}</span><span class="rowval">${n}<i>${pct}%</i></span></div>
    <div class="track"><div class="fill" style="width:${pct}%;--c:${accent}"></div></div>
  </div>`
}

function sparkline(daily) {
  const max = Math.max(1, ...daily.map((d) => d.n))
  const w = 640, h = 120, pad = 8
  const step = daily.length > 1 ? (w - pad * 2) / (daily.length - 1) : 0
  const pts = daily.map((d, i) => {
    const x = pad + i * step
    const y = h - pad - (d.n / max) * (h - pad * 2)
    return [x, y]
  })
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')
  const area = line + ` L${pts[pts.length - 1][0].toFixed(1)} ${h - pad} L${pts[0][0].toFixed(1)} ${h - pad} Z`
  const dots = pts.map((p, i) => {
    if (!daily[i].n) return ''
    return `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" class="dot"/>`
  }).join('')
  return `<svg viewBox="0 0 ${w} ${h}" class="spark" preserveAspectRatio="none">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#g)"/>
    <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
  </svg>`
}

function page(data, authed) {
  const total = data.totalInstalls
  const platformRows = Object.entries(data.byPlatform).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => bar(PLATFORM_LABEL[k] || k, n, total, 'var(--c1)')).join('') || '<p class="empty">暂无数据</p>'
  const sourceRows = Object.entries(data.bySource).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => bar(SOURCE_LABEL[k] || k, n, total, 'var(--c2)')).join('') || '<p class="empty">暂无数据</p>'
  const versionRows = Object.entries(data.byVersion).sort((a, b) => {
    const pa = a[0].split('.').map(Number), pb = b[0].split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] || 0) - (pa[i] || 0)
      if (d) return d
    }
    return 0
  }).map(([k, n]) => bar('v' + k, n, total, 'var(--c3)')).join('') || '<p class="empty">暂无数据</p>'

  const rows = data.installs.length
    ? data.installs.map((r) => `<tr>
        <td class="mono">${esc(r.installId)}…</td>
        <td>${esc(PLATFORM_LABEL[r.platform] || r.platform)}</td>
        <td>${esc(SOURCE_LABEL[r.source] || r.source)}</td>
        <td class="mono">${esc((r.versions || []).join(', ') || '—')}</td>
        <td class="num">${r.days}</td>
        <td class="mono dim">${esc(r.lastDay || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" class="empty">还没有任何上报</td></tr>'

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-codebuddy · 使用统计</title>
<style>
:root{
  --bg:#0b0d10; --panel:#13161b; --panel2:#171b21; --line:#232830;
  --fg:#e7ebf0; --dim:#8a94a3; --dim2:#5f6875;
  --accent:#5b9dff; --c1:#5b9dff; --c2:#38d39f; --c3:#b98cff;
  --radius:14px;
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f6f8fb; --panel:#fff; --panel2:#f2f5f9; --line:#e3e8ef;
    --fg:#141a22; --dim:#66707d; --dim2:#98a2b0; }
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.wrap{max-width:1080px;margin:0 auto;padding:44px 22px 80px}
header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:34px}
h1{margin:0;font-size:26px;font-weight:650;letter-spacing:-.02em}
h1 span{color:var(--accent)}
.sub{margin:7px 0 0;color:var(--dim);font-size:13.5px}
.live{display:inline-flex;align-items:center;gap:7px;color:var(--dim);font-size:12.5px;
  border:1px solid var(--line);background:var(--panel);padding:7px 13px;border-radius:999px}
.pulse{width:7px;height:7px;border-radius:50%;background:#38d39f;box-shadow:0 0 0 0 rgba(56,211,159,.55);animation:p 2.2s infinite}
@keyframes p{70%{box-shadow:0 0 0 7px rgba(56,211,159,0)}100%{box-shadow:0 0 0 0 rgba(56,211,159,0)}}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:13px;margin-bottom:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 19px}
.card .k{color:var(--dim);font-size:12.5px;letter-spacing:.03em}
.card .v{font-size:31px;font-weight:640;letter-spacing:-.03em;margin-top:5px;font-variant-numeric:tabular-nums}
.card .note{color:var(--dim2);font-size:12px;margin-top:2px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:21px 22px;margin-bottom:13px}
.panel h2{margin:0 0 16px;font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.05em;text-transform:uppercase}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:13px;margin-bottom:13px}
.row{margin-bottom:13px}
.row:last-child{margin-bottom:0}
.rowhead{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:6px}
.rowlabel{color:var(--fg)}
.rowval{color:var(--dim);font-variant-numeric:tabular-nums}
.rowval i{font-style:normal;color:var(--dim2);margin-left:7px;font-size:12px}
.track{height:6px;background:var(--panel2);border-radius:99px;overflow:hidden}
.fill{height:100%;background:var(--c);border-radius:99px;min-width:2px;transition:width .5s cubic-bezier(.4,0,.2,1)}
.spark{width:100%;height:118px;display:block}
.dot{fill:var(--accent)}
.days{display:flex;justify-content:space-between;color:var(--dim2);font-size:11.5px;margin-top:9px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--dim2);font-weight:500;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  padding:0 12px 10px 0;border-bottom:1px solid var(--line)}
td{padding:11px 12px 11px 0;border-bottom:1px solid var(--line);color:var(--fg)}
tr:last-child td{border-bottom:none}
td.num{font-variant-numeric:tabular-nums}
.mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
.dim{color:var(--dim)}
.empty{color:var(--dim2);font-size:13.5px;text-align:center;padding:26px 0}
footer{margin-top:26px;color:var(--dim2);font-size:12px;line-height:1.9}
footer code{background:var(--panel2);padding:2px 6px;border-radius:5px;font-size:11.5px}
@media (max-width:600px){
  .wrap{padding:28px 15px 60px}
  h1{font-size:21px}
  .card .v{font-size:26px}
  table{font-size:12.5px}
  th,td{padding-right:8px}
}
</style></head>
<body><div class="wrap">
<header>
  <div>
    <h1>dsh-codebuddy <span>·</span> 使用统计</h1>
    <p class="sub">匿名心跳汇总 &nbsp;·&nbsp; 只含版本、平台、安装来源与日期，不含任何身份信息</p>
  </div>
  <div class="live"><span class="pulse"></span>自动刷新 30s</div>
</header>

<div class="cards">
  <div class="card"><div class="k">总安装数</div><div class="v">${data.totalInstalls}</div><div class="note">按安装 ID 去重</div></div>
  <div class="card"><div class="k">今日活跃</div><div class="v">${data.activeToday}</div><div class="note">今天有上报</div></div>
  <div class="card"><div class="k">7 日活跃</div><div class="v">${data.active7d}</div><div class="note">近 7 天内上报过</div></div>
  <div class="card"><div class="k">30 日活跃</div><div class="v">${data.active30d}</div><div class="note">近 30 天内上报过</div></div>
</div>

<div class="panel">
  <h2>近 14 天活跃</h2>
  ${sparkline(data.daily)}
  <div class="days"><span>${esc(data.daily[0]?.day || '')}</span><span>${esc(data.daily[data.daily.length - 1]?.day || '')}</span></div>
</div>

<div class="grid3">
  <div class="panel"><h2>平台分布</h2>${platformRows}</div>
  <div class="panel"><h2>安装来源</h2>${sourceRows}</div>
  <div class="panel"><h2>版本分布</h2>${versionRows}</div>
</div>

<div class="panel">
  <h2>安装明细</h2>
  <table>
    <thead><tr><th>安装 ID</th><th>平台</th><th>来源</th><th>版本</th><th>活跃天数</th><th>最近上报</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>

<footer>
  共收到 ${data.totalEvents} 条心跳 &nbsp;·&nbsp; 最近一次 ${esc(data.latestReportDay || '—')}<br>
  同一安装每天最多上报一次；服务端做同样去重。数据不含账号、token、路径、主机名或 IP。<br>
  原始事件：<code>${esc(FILE)}</code>
</footer>
</div>
<script>setTimeout(()=>location.reload(),30000)</script>
</body></html>`
}

function loginPage(error) {
  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-codebuddy · 登录</title>
<style>
:root{--bg:#0b0d10;--panel:#13161b;--line:#232830;--fg:#e7ebf0;--dim:#8a94a3;--accent:#5b9dff}
@media (prefers-color-scheme:light){:root{--bg:#f6f8fb;--panel:#fff;--line:#e3e8ef;--fg:#141a22;--dim:#66707d}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
form{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:34px 32px;width:min(92vw,352px)}
h1{margin:0 0 6px;font-size:19px;font-weight:620;letter-spacing:-.01em}
p{margin:0 0 20px;color:var(--dim);font-size:13px}
input{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);font-size:14px;outline:none}
input:focus{border-color:var(--accent)}
button{margin-top:12px;width:100%;padding:11px;border-radius:9px;border:none;cursor:pointer;
  background:var(--accent);color:#fff;font-size:14px;font-weight:560}
.err{color:#ff6b6b;font-size:12.5px;margin-top:11px;min-height:18px}
</style></head><body>
<form method="GET" action="/">
  <h1>使用统计</h1>
  <p>请输入访问口令</p>
  <input name="token" type="password" placeholder="ADMIN_TOKEN" autofocus>
  <button type="submit">进入</button>
  <div class="err">${error ? esc(error) : ''}</div>
</form>
</body></html>`
}

// ───────────────────────────── 服 务 ─────────────────────────────

function clientIp(req) {
  const a = req.socket.remoteAddress || ''
  return a.replace(/^::ffff:/, '')
}
const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  const ip = clientIp(req)

  const send = (code, body, headers = {}) => {
    res.writeHead(code, { 'Cache-Control': 'no-store', ...headers })
    res.end(body)
  }
  const json = (code, body) => send(code, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8' })
  const html = (code, body) => send(code, body, { 'Content-Type': 'text/html; charset=utf-8' })

  // ---- 鉴权 ----
  const cookieToken = (() => {
    const c = req.headers.cookie || ''
    const m = c.match(/(?:^|;\s*)cb_admin=([^;]+)/)
    return m ? decodeURIComponent(m[1]) : ''
  })()
  const queryToken = url.searchParams.get('token') || ''
  const headerToken = String(req.headers['x-admin-token'] || '')
  const given = queryToken || headerToken || cookieToken

  const authed = ADMIN_TOKEN
    ? given === ADMIN_TOKEN
    : isLocal(ip)

  if (url.pathname === '/health') return json(200, { ok: true, uptime: process.uptime() })

  // ---- 上报（公开）----
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

      loadSeen()
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

  // ---- 仪表盘 / 数据 ----
  const wantsStats = url.pathname === '/stats' || url.pathname === '/api/stats'
  const wantsPage = url.pathname === '/' || url.pathname === '/index.html'

  if (wantsStats || wantsPage) {
    if (!authed) {
      if (wantsStats) return json(403, { ok: false, error: 'forbidden' })
      return html(200, loginPage(given ? '口令不对' : ''))
    }
    const data = summarize(readEvents())
    if (wantsStats) return json(200, data)
    // 口令正确时种一个 cookie，之后刷新就不用再带 ?token=
    const headers = {}
    if (ADMIN_TOKEN && queryToken === ADMIN_TOKEN) {
      headers['Set-Cookie'] = `cb_admin=${encodeURIComponent(ADMIN_TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
    }
    return send(200, page(data, true), { 'Content-Type': 'text/html; charset=utf-8', ...headers })
  }

  return json(404, { ok: false, error: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log('dsh-codebuddy 心跳接收端已启动')
  console.log(`  监听   http://${HOST}:${PORT}`)
  console.log(`  数据   ${FILE}`)
  console.log(`  鉴权   ${ADMIN_TOKEN ? '已设置 ADMIN_TOKEN' : '未设置 ADMIN_TOKEN —— 仅本机可访问，请设置后再暴露公网'}`)
})
