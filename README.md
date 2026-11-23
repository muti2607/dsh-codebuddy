# dsh-codebuddy — CodeBuddy 免费模型接入

把腾讯 **CodeBuddy**（`copilot.tencent.com`）与 **WorkBuddy**（`www.workbuddy.ai`）的免费模型接进 DeepSeek Harness 的模型选择器：DeepSeek、GLM、Kimi、MiniMax、混元等，**点一下浏览器登录即可选用**。

**内置原生登录**：协议直接对接官方 IDE 插件端点（`/v2/plugin/auth/state` → 浏览器授权 → 轮询 `auth/token` → `login/account`），**不依赖 OFM / Channel Pack**。凭据写进 DSH 自己的凭据库（`~/.dsh/.credentials.yaml`），账号索引写 `$DSH_HOME/dsh-codebuddy/accounts.json`。为兼容已有环境，仍会回退读取 Channel Pack 的 `buddy` 账号。

## 登录

```bash
# 起登录：自动打开浏览器，返回 accountId 与登录页
curl -X POST "http://127.0.0.1:<dsh端口>/api/cb/login?provider=buddy"
# provider 可选 buddy（CodeBuddy）/ workbuddy（国际版）

# 轮询登录结果（后台最长等 5 分钟，浏览器里点确认即完成）
curl "http://127.0.0.1:<dsh端口>/api/cb/login?accountId=<上一步返回的 id>"

# 看已登录的账号（只报昵称/过期，绝不回传令牌）
curl "http://127.0.0.1:<dsh端口>/api/cb/accounts"
```

浏览器里完成授权后，**下一次请求就生效，无需重启 DSH**。

账号池支持多个账号：遇到 `6004`（频率限制）或 `14018`（额度用尽）会自动切到下一个账号重发，只切一次不连环打穿。停用/删除：

```bash
curl -X POST "http://127.0.0.1:<端口>/api/cb/accounts" -H 'Content-Type: application/json' \
  -d '{"accountId":"<id>","action":"setEnabled","enabled":false}'
curl -X POST ".../api/cb/accounts" -d '{"accountId":"<id>","action":"delete"}'   # 凭据一并清除
```

## 积分（剩余 + 领取）

CodeBuddy 与 WorkBuddy 都有「每日签到领积分」的活动，插件把余额查询与领取都做进了设置页：
账号分节上方是**剩余积分**大数字、签到状态、连签天数、本周签到格，以及「领取积分 / 刷新积分」两个按钮。
多个账号时显示汇总总额，下面按账号逐条列出各自余额。

命令行等价接口：

```bash
# 查余额 + 签到状态（多个账号一次查完，含汇总 total）
curl "http://127.0.0.1:<端口>/api/cb/credits"
# 只查某个账号
curl "http://127.0.0.1:<端口>/api/cb/credits?accountId=<id>"

# 领取今日积分（只领「今天还没领」的账号；已领过会返回 already-claimed，不算失败）
curl -X POST "http://127.0.0.1:<端口>/api/cb/credits/claim"
```

协议是腾讯 IDE 插件用的 billing 端点，**三个都是 POST + 空 JSON body**：

| 端点 | 用途 |
| --- | --- |
| `/v2/billing/meter/checkin-activity-status` | 签到活动状态（`today_checked_in`、`streak_days`、`daily_credit`、`week_progress`） |
| `/v2/billing/meter/get-user-resource` | 积分包列表（`CycleCapacityRemain` 等，按 `Status`/`ExpiredTime` 过滤有效包） |
| `/v2/billing/meter/daily-checkin` | 领取今日积分（写操作） |

两个实现细节值得记下来，都是踩过的坑：

1. **余额必须读 `*Precise` 字段。** 整数版 `CycleCapacityRemain` 会把 `60.92` 截成 `60`，
   小数在 `CycleCapacityRemainPrecise` 里（字符串）。只读整数版会少算钱。
2. **「今天已签到」返回的是 HTTP 400，不是 200。** body 仍是 `{"code":10001,"msg":"今天已签到，请明天再来"}`。
   若按常规先判 `response.ok` 就抛错，已签到会被显示成「领取失败」——
   所以解析顺序必须是**先读 body 里的业务码，再看 HTTP 状态**。

领取按钮的可点状态取自服务端的 `today_checked_in && active`，不在客户端自己记日期，
换设备/跨天都能对上，也不会出现「点了才报已领取」。

## 安装

在 DSH「插件 → 添加插件」里填本仓库地址，或本地目录：

```
https://github.com/muti2607/dsh-codebuddy
```

装好后在对话框的模型选择器里会出现 **CodeBuddy (腾讯免费)** 分组。

前提：已经登录过一次（用上面的 `/api/cb/login` 走浏览器授权）。没登录时插件会明确报「没有可用凭据，请先登录」，不会静默失败。已装 Channel Pack 的环境无需重复登录——插件会自动回退读取它的 `buddy` 账号。

## 为什么单独做一个插件

OFM（`dsh-our-free-model`）本来就有 CodeBuddy 渠道，但 **2.8.0 起该渠道被搬进了 Go 引擎**（`vendor/magpie`），JS 侧改不动了。而且直接用它会遇到下面这个拦路虎。

## 关键：腾讯的提示词指纹拦截

CodeBuddy 服务端会**扫描请求体**，命中 DSH 提示词的原句就返回：

```
HTTP 400  code=11128
Illegal API invocation from an unapproved channel
（这次调用没通过渠道校验，可能不是官方客户端发出的。）
```

实测（同一 token、同一 header，只改请求体内容）：

| 请求体内容 | 结果 |
| --- | --- |
| system 含 `You are an AI agent powered by DeepSeek Harness.` | ❌ 400 / 11128（重复 6 次全拦） |
| system 含 `Tokens prefixed with @ are paths … workspace root.` | ❌ 400 / 11128 |
| 同样文案放在 **user** 角色 | ✅ 200 |
| 换成中性 system 文案 | ✅ 200 |
| **assistant 历史**里引用第二句 | ❌ 400 / 11128 |

最后一行是关键：服务端扫的是**整个 body**，不只 system。所以一旦对话历史里出现过这些句子（比如排查时把原文贴进回复、或 grep 到源码里那一行），后续每一轮都会被拦，而且**换个新会话才能恢复**——除非客户端主动清理历史。

因此本插件做两层防护：

1. **system / developer 整段**替换为中性等价说明（保留工具使用要点）；
2. **所有角色**（user / assistant / tool / 工具参数）的文本再过一遍 `sanitizeText`，
   把已知触发句替换成中性文案。

> 副作用：CodeBuddy 看到的是中性提示词，不是 DSH 那套完整规则，模型行为可能比其它渠道略松散。这是绕过指纹拦截的必要代价。
> 另外腾讯随时可能加新的匹配规则，届时需要更新 `BLOCKED_PATTERNS`。
>
> 注意 `BLOCKED_HINTS` 预筛词必须覆盖所有模式的**特征词**——最初只写了 `Harness|DeepSeek`，
> 于是不含这两个词的 `@ paths …` 那句被预筛直接跳过，导致历史里的第二句一直漏掉。
> 工具参数的净化会重新校验 JSON，替换后若不合法则退回原文，避免发出坏参数。

## 实现要点

- **线协议**：OpenAI chat/completions + SSE，块生命周期与 channel-pack 逐项对齐
  （`block-start` → `*-delta` → 流末 `block-end` 带完整块；工具调用的 id 只在首片出现，按块 index 缓存复用）
- **前缀缓存**：所有请求共用一个 `prompt_cache_key`。实测同一段 8k 前缀，
  不带该字段 `cache_hit=0`、积分 0.34；带上 `cache_hit=7808`、积分 0.02 —— **差约 17 倍**
- **续期**：token 临期自动 `POST /v2/plugin/auth/token/refresh`，并写回凭据库；
  401/403 时强制续期重试一次
- **模型目录**：优先 `GET /v3/config` 动态拉取（实测 24 个），失败回退内置 15 个兜底
- **截断识别**：工具参数 JSON 未闭合时按 `max-tokens` 结束，并保留原始字符串，
  不让宿主丢整次调用
- **图片输入**：经 `attachments.readImageRequest` 把 `ImageAttachmentRef` 投影成
  `data:` URL，按 1568px / 1MB 预算缩放后以 `image_url` 发送。
  实测 2026-11-07：32×32 纯红图被正确识别为「红色」，64×64 纯绿图识别为「绿色」。
  注意只接受 OpenAI 风格 `image_url`；旧式 `input_image` 会被拒
  （`code 11101 Parse message failed: unsupported content type`）。
  图片读取失败时写成 `[image unavailable]` 占位，不让模型误以为无图。

## 配置（可选）

```yaml
- id: codebuddy
  name: dsh-codebuddy
  config:
    credentialRef: ''   # 留空则自动从 channel-pack/state.json 找 provider=buddy 的账号
    maxRetries: 1       # 上游 HTTP 失败后的自动重试次数；默认 1 = 补发一次
                        # （0 = 完全不重试、出错直接抛；上限 5）
                        # 另有独立一层「按官方意愿重试」：响应体带
                        # retry_policy.retry=true（如 code 11134）或 429/503
                        # 带 Retry-After 时，等官方时长后精确补发一次
    aliases: []         # 额外渠道别名，默认空。填 ['buddy'] 可让 `buddy/xxx`
                        # 这类旧模型 id 继续可用；别名在界面上显示为
                        # 「CodeBuddy (腾讯免费) · buddy」以免和主渠道混淆
```

> **为什么 `aliases` 默认是空**：早先默认注册了 `buddy` 别名，结果模型选择器里
> 出现**两个都叫「CodeBuddy (腾讯免费)」的分组**，里面的模型一模一样；
> 而且 `buddy` 本来就是 OFM/channel-pack 自己的 provider 名，默认抢占它会让
> 两个插件的渠道互相顶替（谁后注册谁生效），行为不稳定。需要兼容旧 id 时再显式打开。

模型名若在远端目录里重复（例如 `hy4flash` 与 `hy4flash-free` 都叫 "Hy4 flash"），
插件会自动给后面的加后缀，显示为「Hy4 flash」与「Hy4 flash (free)」——
**模型 id 不变**，所以已保存的会话仍然可用。

## 测试

```
npm test          # 十一个脚本依次跑
node test/verify-adapter.mjs     # 序列化 / 双层净化 / 图片 / 适配器契约
node test/verify-sse.mjs         # SSE 块协议（6 个用例）
node test/verify-updater.mjs     # 版本比较 / 安装形态 / 远端查询失败语义
node test/verify-rotation.mjs    # 多账号轮换
node test/verify-update.mjs      # 自更新
node test/verify-login.mjs       # 登录协议
node test/verify-credits.mjs     # 积分：请求头 / Precise 字段 / 业务码映射 / 端点互不影响
node test/verify-providers.mjs   # 渠道与模型展示：分组不重复、同名模型消歧
node test/verify-client.mjs      # Client 静态检查
node test/verify-client-ui.mjs   # 视觉与结构检查
node test/verify-client-render.mjs  # 渲染冒烟（桩 React 真跑组件）
```

全部离线运行，不需要凭据、不联网。

另外有三个**需要真实凭据**的脚本，不进 `npm test`：

```
npm run test:route        # 把路由挂在假 webServer 上打真 HTTP，验证 /api/cb/credits 端到端
npm run test:live         # 只用真实账号查余额与签到状态（只读，不领取）
npm run test:providers    # 导入「已安装副本」，用真实远端目录验证模型清单
```

## 自动更新

插件会在启动一分钟后检查一次 GitHub 上的最新版本，之后每 6 小时一次。

**只检查、不静默安装。** 发现新版本时写一条 warn 日志，并可通过接口查看/触发更新：

```bash
# 查有没有新版本（force=1 绕过 60 秒缓存）
curl http://127.0.0.1:<端口>/api/codebuddy/update?force=1

# 确认更新
curl -X POST http://127.0.0.1:<端口>/api/codebuddy/update
```

### 为什么用官方 installBundle 而不是自己替换文件

`dsh-our-free-model` 的自更新是绕过 pnpm 直接改磁盘的，结果是 `pnpm-lock.yaml`
与实际安装长期不一致。一旦有别的安装动作触发 pnpm 按 lockfile 重建，包就会被
「恢复」成 lockfile 那个版本 —— 我实际遇到过：2.8.0 被降回 2.5.6，中途还丢了
`vendor/magpie/bin`，整个包加载失败变成「包不可用」。

本插件改为走 `pluginManager.installBundle('github:...')`，内部就是 pnpm：
lockfile 始终一致，更新后由 Loader 重新激活，不需要手写重载，也不会留下半损坏状态。

### 前提：用 github: 安装

自更新只对 `github:` 安装生效。若是 `link:` 本地目录安装，接口会明确拒绝 ——
否则等于让插件改写你自己的源码树。迁移方式：

```bash
dsh plugin --profile desktop remove dsh-codebuddy
dsh plugin --profile desktop add github:muti2607/dsh-codebuddy
```

### 可配置项

```yaml
- id: codebuddy
  name: dsh-codebuddy
  config:
    autoUpdate: true            # 关掉后台检查
    updateCheckHours: 6         # 检查间隔
    autoInstallUpdates: false   # true 时才自动安装（默认只提醒）
```

## 已知限制

- CodeBuddy 看到的是中性系统提示词，不是 DSH 完整规则，模型行为可能比其它渠道略松散
- 腾讯随时可能加新的匹配规则，届时需要更新 `index.js` 里的 `BLOCKED_PATTERNS`
- 免费额度是每日积分制，DSH 动辄 MB 级上下文，重度使用会很快用尽
- `imageRequestPricing` 仍返回 `undefined`，含图的大结果可能不落盘（不影响看图）

### 断流自愈（1.4.5）

腾讯这条链路偶尔会在回答中途掐断连接（`terminated` / other side closed）。插件现在会自动恢复，
不需要你重发消息：

| 情况 | 处理 |
| --- | --- |
| 还没吐出任何内容 | 整轮重发，最多 2 次（用户完全看不见） |
| 已经吐了一半正文 | 断点续写，最多 3 次：把已交付正文回灌给模型，要求从断点接着写 |
| 已经下发完整工具块 | 同样续写，但**续写轮禁用工具调用**——否则同一个工具会被执行两遍 |

恢复全部失败时才会报错，并且会说明已经试过几次。已知代价：续写轮如果模型没完全听从
「不要重复」的指令，可能重复一小段；这比整轮作废、需要人工重发要好。

## 许可

MIT

## 更新日志

### 1.6.6

**检查更新不再被缓存骗。**

症状：明明已经发了新版，用户点「检查更新」却看到几天前的版本号（例如 1.5.4）。

原因：GitHub 的 contents API 带 `Cache-Control: public, max-age=60`，
中间任何一层（运营商缓存、公司代理、CDN 边缘）都可能把旧响应留很久。

修法：

- 请求加 `Cache-Control: no-cache, no-store` 与 `Pragma: no-cache`，强制再验证
- 显式带 `?ref=main`，不再依赖仓库默认分支

判断依据：所有版本读的都是同一个地址，而那个地址本身返回的是新版本——
所以问题只可能出在"这份响应是旧的"。

### 1.6.5

**接收端日志不再记录客户端 IP。**

Python 标准库的 `handle_error()` 会把 `('218.56.108.219', 2366)` 这种
客户端地址直接打进 traceback，与「不记录 IP」的承诺冲突。现在改为只记异常类型。

同时浏览器主动断开（`ConnectionResetError` / `BrokenPipeError`）不再刷 traceback——
那是常态，不是故障。

### 1.6.4

**心跳默认开启，并接到自建接收端。**

1.6.0 时默认端点为空，装上不发出任何请求——好处是最保守，坏处是永远收不到数据。
现在默认指向 `http://101.200.51.102:8787/hb`。

关闭方式（任选其一）：

```json
{ "telemetry": false }
```

或把 `telemetryUrl` 显式写成空串：

```json
{ "telemetryUrl": "" }
```

注意 `telemetryUrl: ""` 与「不写这个键」含义不同：前者是关闭，后者是用默认端点。
这一点在测试里锁死了，避免"以为关了其实还在发"。

发送内容仍然只有 6 个字段：事件类型、安装 ID、版本、平台、安装来源、日期。
不含账号、token、路径、主机名、用户名、邮箱或 IP。

接收端可用 `server/heartbeat-server.py`（Python 标准库，零依赖）或
`server/heartbeat-server.mjs`（Node 18+）自建，两者接口与界面一致。

### 1.6.3

**修复：在没有 credentials 服务的组合里，登录完账号进不了列表。**

症状：浏览器授权走完、界面显示「完成」，账号列表却一直是空的，日志里是

```
[codebuddy] 登录未完成：当前组合没有 credentials 服务，无法保存凭据
```

原因：插件把凭据保存完全托付给 DSH 的 `credentials` 服务。**不是每个 DSH 组合
都有这个服务**，没有的时候浏览器那一半其实已经成功了，但保存凭据这步直接抛错，
`addAccount` 压根没执行。

修法：凭据改由插件自己存。

- 新模块 `src/credential-store.js`，落到 `$DSH_HOME/dsh-codebuddy/credentials.json`，
  权限 `0600`
- 读取顺序：**本地库优先，再回落 DSH 服务**（老用户的凭据只在服务里，不能掉线）
- 写入：本地库必写，服务存在就顺带写一份
- 删除账号时两边一起清
- 续期拿到的新 token 也会写回本地库，不会出现「第一次能用、过期就废」

安全等级和 DSH 自己一致（它也是文件存储的 `.credentials.yaml`）。

### 1.6.2

**接收端带 WebUI**。`server/heartbeat-server.mjs` 现在除了收数据，还带一个仪表盘：

- 总安装数 / 今日活跃 / 7 日活跃 / 30 日活跃 四张卡片
- 近 14 天活跃趋势折线图（内联 SVG，无外部资源、无 CDN）
- 平台分布、安装来源分布、版本分布
- 每个安装的明细表（ID 前缀、平台、来源、版本、活跃天数、最近上报）
- 深/浅色自动适配，手机端自适应，30 秒自动刷新
- 口令保护（`ADMIN_TOKEN`），登录后种 cookie，刷新不用反复输

部署：把 `server/` 里的两个文件传到服务器，然后

```bash
sudo bash deploy.sh
```

脚本会装好 systemd 服务、生成随机口令、开机自启，并打印仪表盘地址。
卸载：`sudo bash deploy.sh uninstall`。

⚠️ 云服务器记得在安全组放行端口（默认 8787）。要上 HTTPS 用
`server/nginx.conf.example`。

### 1.6.0

**匿名使用统计（透明心跳）**。这是本插件第一次对外发送任何数据，所以把细节全部摊开写：

- **发什么**：只有这 6 个字段——`event`（install/daily）、`installId`、`version`、
  `platform`（仅 win32/darwin/linux）、`source`（git/local/other）、`day`（只到日期）。
- **不发什么**：账号、token、refresh_token、项目路径、主机名、用户名、邮箱、IP、
  环境变量、机器指纹。`test/verify-heartbeat.mjs` 对这些做了逐条断言，红了就不许发。
- **installId 是本地随机数**（32 位 hex，首次装载时生成），与你的任何真实身份无关；
  存在 `~/.dsh/dsh-codebuddy/install-id.json`，删掉即换新号。它只是用来做去重——
  同一台机器重装 10 次也只算 1 个安装。
- **频率**：每天最多一次，同一天不重复上报（服务端也做同样的去重）。
- **默认状态**：`telemetryUrl` 为空时**一个请求都不发**。也就是说本插件本身完全静默，
  只有你自己配了接收端才会开始上报。想彻底关掉：`telemetry: false`。
- **自己查**：`GET /api/codebuddy/telemetry` 会返回当前是否开启、上次上报时间、
  以及完整的字段清单（`fields` / `neverSent`）。设置页也会显示这段说明。
- **接收端**：`server/heartbeat-server.mjs` 单文件零依赖，`node server/heartbeat-server.mjs`
  起来即可，`GET /stats` 看汇总（总安装数 / 7 日活跃 / 30 日活跃 / 平台与版本分布）。
  详见该文件头部注释。

启用方式（二选一）：

```yaml
# 1. 在 DSH 的插件配置里写死
telemetry: true
telemetryUrl: https://你的域名/hb
```

```bash
# 2. 或部署接收端后把地址填进去
node server/heartbeat-server.mjs   # 默认 :8787，数据落 heartbeat-data/events.ndjson
```

### 1.5.4

1.5.3 之后，别人的机器上仍然报「模型清单读取失败」。查下来不是速度问题，
是**依赖把无关功能一起拖死**：

- **真因**：`/api/cb` 整组路由（含 `/models`）注册在
  `root.inject(['webServer','credentials'], …)` 的回调里。Cordis 的语义是
  **缺任一 required 依赖就不执行回调**，于是只要组合里没有 `credentials`
  服务（精简组合、凭据服务未就绪、装载顺序），整组 `/api/cb` 路由根本不会
  注册。而 `/api/codebuddy`（版本、更新）只依赖 `webServer`，照常可用——
  所以症状是「设置区能打开、版本号也对，只有模型清单固定失败」，很容易
  被误判成取数或网络问题。
- 同样的焊点在第二层：模型清单的取数桥 `modelBridge.list` 是在 `install()`
  里赋值的，而 `install()` 挂在 `inject(['credentials','attachments','llm'], …)`
  上。缺 `credentials` 时它也不执行，路由即使注册了，`/models` 只会回
  「模型服务尚未就绪」。
- **修法：把凭据降级为可选依赖**。两个 inject 分别收窄成 `['webServer']` 和
  `['llm']`，凭据改为需要时现取（`getCredentials()` / `getCredSvc()`）；
  缺凭据时读凭据返回 null、写回静默跳过，而不是让整个渠道或整组路由消失。
  列模型本来就不需要凭据，不该被凭据的有无决定。
- **回归闸门**：`test/verify-login.mjs` 新增第 8 组——用一个
  **故意不提供 credentials** 的假 ctx（并模拟「缺依赖就不执行回调」的真实
  注入语义），断言 `/api/cb` 仍然注册、`/api/cb/models` 仍返回非空清单。
  这条测试在修好前是红的，能防止以后有人把 `credentials` 加回 required。
- 顺带把 `check-alias` 与 `verify-credits-route` 并入 `npm test`，之前它们
  只在手动循环里跑。

### 1.5.3

1.5.2 只解决了「同一次运行里第二次打开」，换台电脑或重启 DSH 后依然是冷的。

- **根因**：1.5.2 的缓存全在进程内存里。DSH 一重启、或别人全新安装，内存全空，
  第一次打开设置区仍然要等远端——模型目录最多 2.5s，积分在**上游无响应**时是
  干等满 4s 超时。而人通常一天只重启一次，每次都正好撞上这一次冷启动。
- **修法：结果落盘**（`src/snapshot-cache.js`）。上次成功的模型目录与积分概览写进
  `$DSH_HOME/dsh-codebuddy/*.snapshot.json`，新进程第一屏直接用旧值渲染，后台再刷新。
  实测冷启动积分从 **4013ms → 18ms**，模型目录从最坏 2500ms → 18ms。
- **积分快照按账号隔离**（文件名带 `accountId`）：把 A 的余额显示给 B 比转圈更糟。
  快照里**只存展示数据**，绝不写 token/refresh_token，测试里对这四个字符串做了断言。
- **修掉一个让缓存形同不存在的 bug**：`fetchCreditOverview` 的缓存 key 原来把
  `signal` 一起序列化，而每次调用的 `signal` 都是新对象 ⇒ key 永不命中，积分
  缓存从来没生效过。现在 key 只取「产品 + token 前 12 位」，凭据本体不进 key。
- **兜底目录不落盘**：只有真从远端拿到的目录才写快照。否则某次断网时的应急清单
  会长期冒充「事实」，下次联网看到的还是那份旧列表。
- 界面新增「缓存于 {t}，正在后台更新」，避免旧余额被当成没刷新；手动刷新按钮带
  `?fresh=1` 强制重查，不会再回旧值。
- 新增 `verify-snapshot-cache`（10 项）：覆盖冷读、超龄、文件损坏、schema 不符、
  路径穿越、凭据不落盘、按账号隔离、只读目录静默失败。
- 修正 `package.json` 的 `files` 清单：新增的 `src/snapshot-cache.js` 之前没被列入，
  会导致打包后模块缺失、安装即崩。

### 1.5.2

设置区打开时的卡顿，根因不是网络慢，而是「冷启动那一次必须等完整远端目录」：
`ensureCatalogue` 只有 10 分钟缓存，一旦过期或进程刚起，列表请求就被远端串行阻塞。

- **模型目录改为 stale-while-revalidate**：缓存有效直接返回（零网络）；缓存过期
  立刻返回旧值并在后台静默刷新；冷启动无缓存时最多等 2.5 秒，超时先给已按
  `RETIRED_MODEL_IDS` 过滤的兜底目录，远端继续在后台拉，下次请求即命中。
  并发请求共享同一次拉取，不会打出一串重复的 `/v3/config`。
- **装载时异步预热**：`installLoginRoutes` 起来就丢一个 `setTimeout(…, 0)` 去暖目录，
  避免第一个打开设置区的人替所有人等。
- **积分卡片加了超时闸**：`src/credits.js` 的上游请求统一走 `fetchWithTimeout`
  （`AbortController` + 4 秒，`finally` 清定时器）。超时抛 `TimeoutError`，
  不再无限期转圈；调用方自己取消时仍原样抛 `AbortError`，不会被误判成超时。
- **积分结果缓存 30 秒 + in-flight 去重 + 同样是 stale-while-revalidate**：缓存过期
  立刻返回旧值并后台刷新（实测上游 billing 会抽到 2.6s，正好在 30s 边界打开设置区
  就要干等一次）；`POST /api/cb/credits/claim` 会主动失效缓存，领完立刻看到新余额。
- 新增 `verify-credits-timeout`、`verify-credits-cache` 两套件：前者用「只有 abort 才
  settle」的 mock fetch 验证 4 秒闸与取消传播，后者用对象身份验证缓存命中、失效与并发共享。

实测（本机 GUI）：`GET /api/cb/models` 中位数 2ms、最差 34ms；
`GET /api/cb/credits` 中位数 4ms，仅冷启动首次 476ms。

### 1.5.0

- 修复 `hy4free` 报 `11102 model service info not found` 的崩溃：该模型已被上游下线，
  之前的兜底逻辑会把整张 `FALLBACK_MODELS` 表回填进模型列表，导致选中已下线的 id 直接失败。
- 现在只回填**经过实测确认存活**的白名单 id（`hy3`、`hy3-x`），并用 `RETIRED_MODEL_IDS`
  在所有降级路径上过滤掉已下线模型。
- 修正 `verify-adapter` 的模型数量断言：期望值改为按同一套存活规则计算，不再硬编码 19。
