#!/usr/bin/env bash
# dsh-codebuddy 心跳接收端 —— 一键部署到 Linux 服务器
#
# 用法（在服务器上，文件旁边跑）：
#   bash deploy.sh
#
# 它会：
#   1. 检查 Node（没有就装）
#   2. 建目录 /opt/cb-stats
#   3. 生成随机 ADMIN_TOKEN（已存在则保留）
#   4. 装 systemd 服务，开机自启
#   5. 打印访问地址和口令
#
# 卸载：bash deploy.sh uninstall

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/cb-stats}"
SERVICE="cb-stats"
PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/heartbeat-server.mjs"

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

if [ ! -f "$SRC" ]; then
  c_err "找不到 heartbeat-server.mjs（应和本脚本在同一目录）"
  exit 1
fi

# ─── Node ───
if ! command -v node >/dev/null 2>&1; then
  c_dim "未检测到 Node，正在安装..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q nodejs
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q nodejs
  else
    c_err "无法自动安装 Node，请手动装 nodejs 后重试"
    exit 1
  fi
fi
NODE_BIN="$(command -v node)"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  c_err "Node 版本过低 ($("$NODE_BIN" -v))，需要 >= 18"
  exit 1
fi
c_ok "Node $("$NODE_BIN" -v)"

# ─── 目录 ───
mkdir -p "$APP_DIR" "$DATA_DIR"
cp "$SRC" "$APP_DIR/heartbeat-server.mjs"

# ─── 口令 ───
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ] && grep -q '^ADMIN_TOKEN=' "$ENV_FILE"; then
  ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  c_dim "沿用已有 ADMIN_TOKEN"
else
  ADMIN_TOKEN="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
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
ExecStart=$NODE_BIN $APP_DIR/heartbeat-server.mjs
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

IP="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo '<服务器IP>')"

cat <<EOF

────────────────────────────────────────────
  部署完成
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
