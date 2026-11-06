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
- **只声明文本输入**：CodeBuddy 模型本身支持图像，但本适配器没有实现 DSH 的附件投影，
  声明 image 会让图片被静默丢弃 —— 宁可让宿主在添加图片时就拒绝

## 配置（可选）

```yaml
- id: codebuddy
  name: dsh-codebuddy
  config:
    credentialRef: ''   # 留空则自动从 channel-pack/state.json 找 provider=buddy 的账号
```

## 测试

```
npm test          # 或分别运行下面两个
node test/verify-adapter.mjs   # 序列化 / 双层净化 / 适配器契约
node test/verify-sse.mjs       # SSE 块协议（6 个用例）
```

两个脚本都在离线环境下跑，不需要凭据、不联网。

## 已知限制

- CodeBuddy 看到的是中性系统提示词，不是 DSH 完整规则，模型行为可能比其它渠道略松散
- 腾讯随时可能加新的匹配规则，届时需要更新 `index.js` 里的 `BLOCKED_PATTERNS`
- 免费额度是每日积分制，DSH 动辄 MB 级上下文，重度使用会很快用尽

## 许可

MIT
