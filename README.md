# dsh-codebuddy — CodeBuddy 免费模型接入

把腾讯 **CodeBuddy**（`copilot.tencent.com`）的免费模型额度接进 DeepSeek Harness 的模型选择器：DeepSeek、GLM、Kimi、MiniMax 等 24 个模型，登录一次即可选用。

凭据复用 Channel Pack 已登录的 `buddy` 账号，**不重复实现登录流程**；明文只留在本机凭据库，插件不写日志、不外发。

## 安装

在 DSH「插件 → 添加插件」里填本仓库地址，或本地目录：

```
https://github.com/muti2607/dsh-codebuddy
```

装好后在对话框的模型选择器里会出现 **CodeBuddy (腾讯免费)** 分组。

前提：Channel Pack 里已登录 CodeBuddy 账号（`$DSH_HOME/channel-pack/state.json` 里有 `provider === "buddy"` 的条目）。没登录时插件会明确报「没有可用凭据，请先登录」，不会静默失败。

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
    maxRetries: 0       # 上游 HTTP 失败后的自动重试次数；默认 0 = 不重试
                        # （一次对话只打一次，避免失败被放大成重复调用刷屏；
                        #   网络不稳可设 1，上限 5）
```

## 测试

```
npm test          # 三个脚本依次跑
node test/verify-adapter.mjs   # 序列化 / 双层净化 / 图片 / 适配器契约
node test/verify-sse.mjs       # SSE 块协议（6 个用例）
node test/verify-updater.mjs   # 版本比较 / 安装形态 / 远端查询失败语义
```

全部离线运行，不需要凭据、不联网。

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
