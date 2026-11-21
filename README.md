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

## 许可

MIT
