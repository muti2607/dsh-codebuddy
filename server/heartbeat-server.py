#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
dsh-codebuddy 心跳接收端 + 仪表盘（Python 标准库版）

为什么要 Python 版：目标机器（Ubuntu 22.04）没有 Node，而 apt 源里只有
Node 12，跑不了插件的 ESM 代码。Python 3 是系统自带的，零依赖，直接能跑。
功能与 server/heartbeat-server.mjs 完全一致。

启动：
    python3 heartbeat-server.py
    默认 http://0.0.0.0:8787

环境变量：
    PORT=8787                 监听端口
    HOST=0.0.0.0              监听地址
    DATA_DIR=./heartbeat-data 数据目录
    ADMIN_TOKEN=xxx           仪表盘口令（暴露公网时必须设置）

端点：
    GET  /          仪表盘（要口令）
    POST /hb        插件上报（公开）
    GET  /stats     JSON 汇总（要口令）
    GET  /health    存活探测（公开）
"""

import json
import os
import re
import sys
import time
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

PORT = int(os.environ.get('PORT', '8787'))
HOST = os.environ.get('HOST', '0.0.0.0')
DATA_DIR = os.environ.get('DATA_DIR') or os.path.join(os.getcwd(), 'heartbeat-data')
ADMIN_TOKEN = os.environ.get('ADMIN_TOKEN', '')
FILE = os.path.join(DATA_DIR, 'events.ndjson')

RATE_WINDOW = 60.0
RATE_MAX = 60
_hits = {}          # ip -> (start, count)
_seen = set()       # "installId:day"
_seen_loaded = False

PLATFORM_LABEL = {'win32': 'Windows', 'darwin': 'macOS', 'linux': 'Linux'}
SOURCE_LABEL = {'git': 'GitHub 源', 'local': '本地包', 'other': '其他', 'unknown': '未知'}


def read_events():
    out = []
    try:
        with open(FILE, 'r', encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return out


def load_seen():
    global _seen_loaded
    if _seen_loaded:
        return
    _seen_loaded = True
    for e in read_events():
        if e.get('installId') and e.get('day'):
            _seen.add(e['installId'] + ':' + e['day'])


def rate_limited(ip):
    now = time.time()
    rec = _hits.get(ip)
    if rec is None or now - rec[0] > RATE_WINDOW:
        _hits[ip] = (now, 1)
        return False
    _hits[ip] = (rec[0], rec[1] + 1)
    return rec[1] + 1 > RATE_MAX


ID_RE = re.compile(r'^[0-9a-f]{8,64}$')
DAY_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def sanitize(body):
    """严格白名单：只接受 6 个字段，多余的一律丢弃。"""
    if not isinstance(body, dict):
        return None
    out = {
        'event': 'install' if body.get('event') == 'install' else 'daily',
        'installId': str(body.get('installId') or '')[:64],
        'version': str(body.get('version') or '')[:32],
        'platform': str(body.get('platform') or '')[:16],
        'source': str(body.get('source') or '')[:16],
        'day': str(body.get('day') or '')[:10],
    }
    if not ID_RE.match(out['installId']):
        return None
    if not DAY_RE.match(out['day']):
        return None
    return out


def day_ms(day):
    try:
        dt = datetime.datetime.strptime(day, '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc)
        return dt.timestamp()
    except Exception:
        return None


def summarize(events):
    installs = {}
    for e in events:
        iid = e.get('installId')
        if not iid:
            continue
        r = installs.get(iid)
        if r is None:
            r = {
                'firstSeen': e.get('receivedAt') or e.get('day'),
                'days': set(),
                'versions': set(),
                'platform': e.get('platform') or '?',
                'source': e.get('source') or '?',
                'firstEvent': e.get('event'),
            }
            installs[iid] = r
        if e.get('day'):
            r['days'].add(e['day'])
        if e.get('version'):
            r['versions'].add(e['version'])
        if e.get('platform'):
            r['platform'] = e['platform']
        if e.get('source'):
            r['source'] = e['source']

    now = time.time()
    DAY = 86400.0

    def last_ms(r):
        vals = [day_ms(d) for d in r['days']]
        vals = [v for v in vals if v is not None]
        return max(vals) if vals else 0.0

    def active_since(sec):
        return sum(1 for r in installs.values() if now - last_ms(r) <= sec)

    by_platform, by_source, by_version = {}, {}, {}
    for r in installs.values():
        by_platform[r['platform']] = by_platform.get(r['platform'], 0) + 1
        by_source[r['source']] = by_source.get(r['source'], 0) + 1
        for v in r['versions']:
            by_version[v] = by_version.get(v, 0) + 1

    daily = []
    for i in range(13, -1, -1):
        d = datetime.datetime.fromtimestamp(now - i * DAY, datetime.timezone.utc).strftime('%Y-%m-%d')
        n = sum(1 for r in installs.values() if d in r['days'])
        daily.append({'day': d, 'n': n})

    lasts = [last_ms(r) for r in installs.values()]
    latest = max(lasts) if lasts else 0.0
    latest_day = datetime.datetime.fromtimestamp(latest, datetime.timezone.utc).strftime('%Y-%m-%d') if latest else None

    rows = []
    for iid, r in installs.items():
        days_sorted = sorted(r['days'])
        rows.append({
            'installId': iid[:8],
            'firstSeen': r['firstSeen'],
            'lastDay': days_sorted[-1] if days_sorted else None,
            'days': len(r['days']),
            'platform': r['platform'],
            'source': r['source'],
            'versions': sorted(r['versions']),
        })
    rows.sort(key=lambda x: str(x['lastDay'] or ''), reverse=True)

    return {
        'totalInstalls': len(installs),
        'active7d': active_since(7 * DAY),
        'active30d': active_since(30 * DAY),
        'activeToday': active_since(DAY),
        'totalEvents': len(events),
        'latestReportDay': latest_day,
        'byPlatform': by_platform,
        'bySource': by_source,
        'byVersion': by_version,
        'daily': daily,
        'installs': rows,
    }


# ───────────────────────────── 页 面 ─────────────────────────────

def esc(s):
    return (str('' if s is None else s)
            .replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;'))


def bar(label, n, total, accent):
    pct = int(round(n / total * 100)) if total > 0 else 0
    return (
        '<div class="row">'
        f'<div class="rowhead"><span class="rowlabel">{esc(label)}</span>'
        f'<span class="rowval">{n}<i>{pct}%</i></span></div>'
        f'<div class="track"><div class="fill" style="width:{pct}%;--c:{accent}"></div></div>'
        '</div>'
    )


def sparkline(daily):
    mx = max([1] + [d['n'] for d in daily])
    w, h, pad = 640.0, 120.0, 8.0
    step = (w - pad * 2) / (len(daily) - 1) if len(daily) > 1 else 0
    pts = []
    for i, d in enumerate(daily):
        x = pad + i * step
        y = h - pad - (d['n'] / mx) * (h - pad * 2)
        pts.append((x, y))
    line = ' '.join(('M' if i == 0 else 'L') + f'{x:.1f} {y:.1f}' for i, (x, y) in enumerate(pts))
    area = line + f' L{pts[-1][0]:.1f} {h - pad} L{pts[0][0]:.1f} {h - pad} Z'
    dots = ''.join(
        f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.5" class="dot"/>'
        for (x, y), d in zip(pts, daily) if d['n']
    )
    return (
        f'<svg viewBox="0 0 {int(w)} {int(h)}" class="spark" preserveAspectRatio="none">'
        '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0%" stop-color="var(--accent)" stop-opacity=".28"/>'
        '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>'
        '</linearGradient></defs>'
        f'<path d="{area}" fill="url(#g)"/>'
        f'<path d="{line}" fill="none" stroke="var(--accent)" stroke-width="2" '
        'stroke-linejoin="round" stroke-linecap="round"/>'
        f'{dots}</svg>'
    )


def version_key(v):
    parts = []
    for p in str(v).split('.'):
        try:
            parts.append(int(re.sub(r'\D', '', p) or 0))
        except Exception:
            parts.append(0)
    return parts


def page(data):
    total = data['totalInstalls']

    def rows_for(mapping, labels, accent):
        items = sorted(mapping.items(), key=lambda kv: -kv[1])
        if not items:
            return '<p class="empty">暂无数据</p>'
        return ''.join(bar(labels.get(k, k), n, total, accent) for k, n in items)

    platform_rows = rows_for(data['byPlatform'], PLATFORM_LABEL, 'var(--c1)')
    source_rows = rows_for(data['bySource'], SOURCE_LABEL, 'var(--c2)')

    vers = sorted(data['byVersion'].items(), key=lambda kv: version_key(kv[0]), reverse=True)
    version_rows = ''.join(bar('v' + k, n, total, 'var(--c3)') for k, n in vers) or '<p class="empty">暂无数据</p>'

    if data['installs']:
        trs = []
        for r in data['installs']:
            trs.append(
                '<tr>'
                f'<td class="mono">{esc(r["installId"])}…</td>'
                f'<td>{esc(PLATFORM_LABEL.get(r["platform"], r["platform"]))}</td>'
                f'<td>{esc(SOURCE_LABEL.get(r["source"], r["source"]))}</td>'
                f'<td class="mono">{esc(", ".join(r["versions"]) or "—")}</td>'
                f'<td class="num">{r["days"]}</td>'
                f'<td class="mono dim">{esc(r["lastDay"] or "—")}</td>'
                '</tr>'
            )
        trs = ''.join(trs)
    else:
        trs = '<tr><td colspan="6" class="empty">还没有任何上报</td></tr>'

    daily = data['daily']
    first_day = daily[0]['day'] if daily else ''
    last_day = daily[-1]['day'] if daily else ''

    return f'''<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-codebuddy · 使用统计</title>
<style>
:root{{
  --bg:#0b0d10; --panel:#13161b; --panel2:#171b21; --line:#232830;
  --fg:#e7ebf0; --dim:#8a94a3; --dim2:#5f6875;
  --accent:#5b9dff; --c1:#5b9dff; --c2:#38d39f; --c3:#b98cff;
  --radius:14px;
}}
@media (prefers-color-scheme: light){{
  :root{{ --bg:#f6f8fb; --panel:#fff; --panel2:#f2f5f9; --line:#e3e8ef;
    --fg:#141a22; --dim:#66707d; --dim2:#98a2b0; }}
}}
*{{box-sizing:border-box}}
body{{
  margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}}
.wrap{{max-width:1080px;margin:0 auto;padding:44px 22px 80px}}
header{{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:34px}}
h1{{margin:0;font-size:26px;font-weight:650;letter-spacing:-.02em}}
h1 span{{color:var(--accent)}}
.sub{{margin:7px 0 0;color:var(--dim);font-size:13.5px}}
.live{{display:inline-flex;align-items:center;gap:7px;color:var(--dim);font-size:12.5px;
  border:1px solid var(--line);background:var(--panel);padding:7px 13px;border-radius:999px}}
.pulse{{width:7px;height:7px;border-radius:50%;background:#38d39f;box-shadow:0 0 0 0 rgba(56,211,159,.55);animation:p 2.2s infinite}}
@keyframes p{{70%{{box-shadow:0 0 0 7px rgba(56,211,159,0)}}100%{{box-shadow:0 0 0 0 rgba(56,211,159,0)}}}}
.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:13px;margin-bottom:13px}}
.card{{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:18px 19px}}
.card .k{{color:var(--dim);font-size:12.5px;letter-spacing:.03em}}
.card .v{{font-size:31px;font-weight:640;letter-spacing:-.03em;margin-top:5px;font-variant-numeric:tabular-nums}}
.card .note{{color:var(--dim2);font-size:12px;margin-top:2px}}
.panel{{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:21px 22px;margin-bottom:13px}}
.panel h2{{margin:0 0 16px;font-size:13px;font-weight:600;color:var(--dim);letter-spacing:.05em;text-transform:uppercase}}
.grid3{{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:13px;margin-bottom:13px}}
.row{{margin-bottom:13px}}
.row:last-child{{margin-bottom:0}}
.rowhead{{display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:6px}}
.rowlabel{{color:var(--fg)}}
.rowval{{color:var(--dim);font-variant-numeric:tabular-nums}}
.rowval i{{font-style:normal;color:var(--dim2);margin-left:7px;font-size:12px}}
.track{{height:6px;background:var(--panel2);border-radius:99px;overflow:hidden}}
.fill{{height:100%;background:var(--c);border-radius:99px;min-width:2px;transition:width .5s cubic-bezier(.4,0,.2,1)}}
.spark{{width:100%;height:118px;display:block}}
.dot{{fill:var(--accent)}}
.days{{display:flex;justify-content:space-between;color:var(--dim2);font-size:11.5px;margin-top:9px;font-variant-numeric:tabular-nums}}
table{{width:100%;border-collapse:collapse;font-size:13.5px}}
th{{text-align:left;color:var(--dim2);font-weight:500;font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;
  padding:0 12px 10px 0;border-bottom:1px solid var(--line)}}
td{{padding:11px 12px 11px 0;border-bottom:1px solid var(--line);color:var(--fg)}}
tr:last-child td{{border-bottom:none}}
td.num{{font-variant-numeric:tabular-nums}}
.mono{{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}}
.dim{{color:var(--dim)}}
.empty{{color:var(--dim2);font-size:13.5px;text-align:center;padding:26px 0}}
footer{{margin-top:26px;color:var(--dim2);font-size:12px;line-height:1.9}}
footer code{{background:var(--panel2);padding:2px 6px;border-radius:5px;font-size:11.5px}}
@media (max-width:600px){{
  .wrap{{padding:28px 15px 60px}}
  h1{{font-size:21px}}
  .card .v{{font-size:26px}}
  table{{font-size:12.5px}}
  th,td{{padding-right:8px}}
}}
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
  <div class="card"><div class="k">总安装数</div><div class="v">{data['totalInstalls']}</div><div class="note">按安装 ID 去重</div></div>
  <div class="card"><div class="k">今日活跃</div><div class="v">{data['activeToday']}</div><div class="note">今天有上报</div></div>
  <div class="card"><div class="k">7 日活跃</div><div class="v">{data['active7d']}</div><div class="note">近 7 天内上报过</div></div>
  <div class="card"><div class="k">30 日活跃</div><div class="v">{data['active30d']}</div><div class="note">近 30 天内上报过</div></div>
</div>

<div class="panel">
  <h2>近 14 天活跃</h2>
  {sparkline(daily)}
  <div class="days"><span>{esc(first_day)}</span><span>{esc(last_day)}</span></div>
</div>

<div class="grid3">
  <div class="panel"><h2>平台分布</h2>{platform_rows}</div>
  <div class="panel"><h2>安装来源</h2>{source_rows}</div>
  <div class="panel"><h2>版本分布</h2>{version_rows}</div>
</div>

<div class="panel">
  <h2>安装明细</h2>
  <table>
    <thead><tr><th>安装 ID</th><th>平台</th><th>来源</th><th>版本</th><th>活跃天数</th><th>最近上报</th></tr></thead>
    <tbody>{trs}</tbody>
  </table>
</div>

<footer>
  共收到 {data['totalEvents']} 条心跳 &nbsp;·&nbsp; 最近一次 {esc(data['latestReportDay'] or '—')}<br>
  同一安装每天最多上报一次；服务端做同样去重。数据不含账号、token、路径、主机名或 IP。<br>
  原始事件：<code>{esc(FILE)}</code>
</footer>
</div>
<script>setTimeout(function(){{location.reload()}},30000)</script>
</body></html>'''


def login_page(error):
    return f'''<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-codebuddy · 登录</title>
<style>
:root{{--bg:#0b0d10;--panel:#13161b;--line:#232830;--fg:#e7ebf0;--dim:#8a94a3;--accent:#5b9dff}}
@media (prefers-color-scheme:light){{:root{{--bg:#f6f8fb;--panel:#fff;--line:#e3e8ef;--fg:#141a22;--dim:#66707d}}}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}}
form{{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:34px 32px;width:min(92vw,352px)}}
h1{{margin:0 0 6px;font-size:19px;font-weight:620;letter-spacing:-.01em}}
p{{margin:0 0 20px;color:var(--dim);font-size:13px}}
input{{width:100%;padding:11px 13px;border-radius:9px;border:1px solid var(--line);
  background:var(--bg);color:var(--fg);font-size:14px;outline:none}}
input:focus{{border-color:var(--accent)}}
button{{margin-top:12px;width:100%;padding:11px;border-radius:9px;border:none;cursor:pointer;
  background:var(--accent);color:#fff;font-size:14px;font-weight:560}}
.err{{color:#ff6b6b;font-size:12.5px;margin-top:11px;min-height:18px}}
</style></head><body>
<form method="GET" action="/">
  <h1>使用统计</h1>
  <p>请输入访问口令</p>
  <input name="token" type="password" placeholder="ADMIN_TOKEN" autofocus>
  <button type="submit">进入</button>
  <div class="err">{esc(error) if error else ''}</div>
</form>
</body></html>'''


# ───────────────────────────── 服 务 ─────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = 'cb-stats'
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):
        # 只记方法和路径，不记 IP（与隐私承诺一致）
        sys.stderr.write('%s %s\n' % (self.command, self.path.split('?')[0]))

    def _send(self, code, body, ctype, extra=None):
        raw = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False), 'application/json; charset=utf-8')

    def _html(self, code, body, extra=None):
        self._send(code, body, 'text/html; charset=utf-8', extra)

    def _ip(self):
        return self.client_address[0] if self.client_address else ''

    def _is_local(self):
        return self._ip() in ('127.0.0.1', '::1')

    def _cookie_token(self):
        c = self.headers.get('Cookie') or ''
        m = re.search(r'(?:^|;\s*)cb_admin=([^;]+)', c)
        return unquote(m.group(1)) if m else ''

    def _authed(self, query):
        given = (query.get('token', [''])[0]
                 or self.headers.get('X-Admin-Token') or ''
                 or self._cookie_token())
        if ADMIN_TOKEN:
            return given == ADMIN_TOKEN
        return self._is_local()

    def do_GET(self):
        # 任何未预料的异常都收敛成 JSON 500，别让 BaseHTTPRequestHandler
        # 吐一段 HTML 错误页——那会让调用方解析 JSON 时莫名报错。
        try:
            self._do_get()
        except Exception:
            try:
                self._json(500, {'ok': False, 'error': 'internal error'})
            except Exception:
                pass

    def do_POST(self):
        try:
            self._do_post()
        except Exception:
            try:
                self._json(500, {'ok': False, 'error': 'internal error'})
            except Exception:
                pass

    def _do_get(self):
        u = urlparse(self.path)
        path = u.path
        query = parse_qs(u.query)
        ip = self._ip()

        if path == '/health':
            return self._json(200, {'ok': True, 'uptime': round(time.time() - START, 1)})

        wants_stats = path in ('/stats', '/api/stats')
        wants_page = path in ('/', '/index.html')

        if wants_stats or wants_page:
            if not self._authed(query):
                if wants_stats:
                    return self._json(403, {'ok': False, 'error': 'forbidden'})
                given = bool(query.get('token', [''])[0] or self.headers.get('X-Admin-Token'))
                return self._html(200, login_page('口令不对' if given else ''))
            data = summarize(read_events())
            if wants_stats:
                return self._json(200, data)
            extra = {}
            if ADMIN_TOKEN and query.get('token', [''])[0] == ADMIN_TOKEN:
                extra['Set-Cookie'] = ('cb_admin=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000'
                                       % unquote(query['token'][0]))
            return self._html(200, page(data), extra)

        if path == '/hb':
            return self._json(405, {'ok': False, 'error': 'method not allowed'})

        return self._json(404, {'ok': False, 'error': 'not found'})

    def _do_post(self):
        u = urlparse(self.path)
        if u.path != '/hb':
            return self._json(404, {'ok': False, 'error': 'not found'})
        ip = self._ip()
        if rate_limited(ip):
            return self._json(429, {'ok': False, 'error': 'too many requests'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            if length > 4096:
                return self._json(413, {'ok': False, 'error': 'payload too large'})
            raw = self.rfile.read(length) if length else b'{}'
            body = sanitize(json.loads(raw.decode('utf-8') or '{}'))
            if body is None:
                return self._json(400, {'ok': False, 'error': 'invalid payload'})

            load_seen()
            key = body['installId'] + ':' + body['day']
            global _seen_lock
            with _seen_lock:
                if key in _seen:
                    return self._json(202, {'ok': True, 'deduped': True})
                _seen.add(key)

            os.makedirs(DATA_DIR, exist_ok=True)
            body['receivedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            with open(FILE, 'a', encoding='utf-8') as fh:
                fh.write(json.dumps(body, ensure_ascii=False) + '\n')
            return self._json(202, {'ok': True})
        except Exception:
            return self._json(400, {'ok': False, 'error': 'bad request'})


import threading
_seen_lock = threading.Lock()
START = time.time()


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print('dsh-codebuddy 心跳接收端已启动')
    print('  监听   http://%s:%d' % (HOST, PORT))
    print('  数据   %s' % FILE)
    print('  鉴权   %s' % ('已设置 ADMIN_TOKEN' if ADMIN_TOKEN else
                          '未设置 ADMIN_TOKEN —— 仅本机可访问，请设置后再暴露公网'))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
