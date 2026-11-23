#!/usr/bin/env bash
# dsh-codebuddy 心跳接收端 —— 一键部署到 Linux 服务器
#
# 用法（在服务器上，文件旁边跑）：
#   sudo bash deploy.sh
#
# 自动挑运行时：有 Node >= 18 就用 Node，否则用系统自带的 Python 3。
# 目标机器（Ubuntu 22.04）的 apt 源里只有 Node 12，跑不了插件的 ESM 代码，
# 所以 Python 分支不是备胎，是常见路径。
#
# 它会：
#   1. 挑运行时
#   2. 建目录 /opt/cb-stats
#   3. 生成随机 ADMIN_TOKEN（已存在则保留）
#   4. 装 systemd 服务，开机自启
#   5. 打印访问地址和口令
#
# 卸载：sudo bash deploy.sh uninstall

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cb-stats}"
SERVICE="cb-stats"
PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

c_ok()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_err() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
c_dim() { printf '\033[90m%s\033[0m\n' "$*"; }

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    c_err "需要 root。请用: sudo bash deploy.sh"
    exit 1
  fi
}

# ─── 卸载 ───
if [ "${1:-}" = "uninstall" ]; then
  need_root
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "/etc/systemd/system/$SERVICE.service"
  systemctl daemon-reload || true
  c_ok "已停止并移除服务。数据仍保留在 $DATA_DIR"
  c_dim "要彻底删除: rm -rf $APP_DIR"
  exit 0
fi

need_root

# ─── 挑运行时 ───
RUNTIME=""
ENTRY=""
EXEC=""

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${NODE_MAJOR:-0}" -ge 18 ] && [ -f "$HERE/heartbeat-server.mjs" ]; then
    RUNTIME="node"
    ENTRY="$APP_DIR/heartbeat-server.mjs"
    EXEC="$(command -v node) $ENTRY"
    c_ok "运行时：Node $(node -v)（支持 ESM，走 .mjs 版）"
  fi
fi

if [ -z "$RUNTIME" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    c_dim "没有可用的 Python 3，尝试安装..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq python3
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q python3
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q python3
    fi
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    c_err "既没有 Node>=18 也没有 python3，无法部署"
    exit 1
  fi
  if [ ! -f "$HERE/heartbeat-server.py" ]; then
    c_err "找不到 heartbeat-server.py（应和本脚本在同一目录）"
    exit 1
  fi
  RUNTIME="python"
  ENTRY="$APP_DIR/heartbeat-server.py"
  EXEC="$(command -v python3) $ENTRY"
  c_ok "运行时：Python $(python3 -V 2>&1 | awk '{print $2}')（走标准库版，零依赖）"
fi

# ─── 目录 ───
mkdir -p "$APP_DIR" "$DATA_DIR"
if [ "$RUNTIME" = "node" ]; then
  cp "$HERE/heartbeat-server.mjs" "$ENTRY"
else
  cp "$HERE/heartbeat-server.py" "$ENTRY"
fi

# ─── 口令 ───
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q '^ADMIN_TOKEN=' "$ENV_FILE"; then
  ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  c_dim "沿用已有 ADMIN_TOKEN"
else
  ADMIN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28)"
  c_ok "已生成新的 ADMIN_TOKEN"
fi
cat > "$ENV_FILE" <<EOF
ADMIN_TOKEN=$ADMIN_TOKEN
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA_DIR
EOF
chmod 600 "$ENV_FILE"

# ─── systemd ───
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=dsh-codebuddy 使用统计接收端
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$EXEC
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  c_ok "服务已启动"
else
  c_err "服务启动失败，查看日志: journalctl -u $SERVICE -n 50 --no-pager"
  exit 1
fi

# ─── 自检 ───
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    c_ok "本地自检通过"
  else
    c_err "本地自检失败（端口 $PORT 可能被占用）"
  fi
fi

# 取公网 IP：优先阿里云元数据服务（走内网，不依赖外网）
#
# 注意：元数据服务在"没有绑定公网 IP"时会返回 404 页面而不是空串。
# 之前直接把它当 IP 用，结果打印出整段 HTML。所以这里必须：
#   1. curl 加 -f，HTTP 出错就当没取到
#   2. 取到的值再用 IPv4 正则校验一遍
is_ipv4() { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }
squeeze() { printf '%s' "$1" | tr -d '[:space:]'; }

IP=""
for cand in \
  "$(curl -fsS -m 4 http://100.100.100.200/latest/meta-data/eipv4 2>/dev/null || true)" \
  "$(curl -fsS -m 4 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)" \
  "$(curl -fsS -m 6 https://api.ipify.org 2>/dev/null || true)"; do
  cand="$(squeeze "$cand")"
  if is_ipv4 "$cand"; then IP="$cand"; break; fi
done
[ -z "$IP" ] && IP="<服务器IP>"
c_dim "公网 IP：$IP"

cat <<EOF

────────────────────────────────────────────
  部署完成（运行时：$RUNTIME）
────────────────────────────────────────────
  仪表盘   http://$IP:$PORT/?token=$ADMIN_TOKEN
  数据接口 http://$IP:$PORT/stats?token=$ADMIN_TOKEN
  上报地址 http://$IP:$PORT/hb

  口令     $ADMIN_TOKEN
  数据     $DATA_DIR/events.ndjson
  日志     journalctl -u $SERVICE -f

下一步（重要）：
  1. 云服务器安全组要放行 TCP $PORT
  2. 把上报地址填进插件配置：
       telemetry: true
       telemetryUrl: http://$IP:$PORT/hb

  若用 Nginx 反代并挂 HTTPS，telemetryUrl 记得写 https://
EOF
