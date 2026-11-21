/**
 * dsh-codebuddy — Client half (Web).
 *
 * 设置页「CodeBuddy 账号」。视觉沿用 Our Free Model 的设计语言：
 *   · 全部色值取自宿主 --dsw-alias-* 令牌，昼夜随宿主切换，不写死颜色
 *   · 层级约定：layer-3 凹槽/卡面 · layer-2 面板 · layer-1 浮起元素
 *   · 卡片双层 bezel（hairline 边框 + 顶部内高光 + 柔和外阴影）
 *   · 动效只用 transform/opacity，150–300ms
 *
 * 交互：
 *   · 「添加账号 / 添加 WorkBuddy」→ /api/cb/login 拿登录页并自动开浏览器，
 *     面板转「等待浏览器授权」，每 1.5s 轮询到 done/failed
 *   · 账号卡片：昵称、可用状态、续期能力、有效期；停用/启用/删除
 *   · 同页显示版本与自更新；两组路由分别硬编码，避免前缀互相遮蔽
 */
window.__ModuleLoader__.load({
  id: 'dsh-codebuddy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const NS = 'dsh-codebuddy'

    const DICT = {
      zh: {
        nav: 'CodeBuddy 账号',
        'meta.title': 'CodeBuddy 免费模型',
        'meta.description': '腾讯 CodeBuddy / WorkBuddy 免费模型接入，内置浏览器登录。',
        title: 'CodeBuddy 账号',
        sub: '点「添加账号」后浏览器会打开登录页，确认即完成，无需复制任何内容。',
        add: '添加账号',
        addWork: '添加 WorkBuddy',
        waiting: '等待浏览器授权…',
        waitingHint: '浏览器没有自动打开？点下面的链接手动前往',
        openManual: '打开登录页',
        cancel: '取消',
        done: '登录完成',
        failed: '登录未完成',
        retry: '重试',
        secAccounts: '账号',
        secAccountsHint: '登录一次即可，模型选择器里立刻可用',
        noAccount: '还没有账号',
        noAccountHint: '点上面的按钮登录一次，凭据只存在本机',
        enabled: '可用',
        disabled: '已停用',
        disable: '停用',
        enable: '启用',
        del: '删除',
        refreshable: '可续期',
        noRefresh: '不可续期',
        expires: '有效期至',
        noExpiry: '有效期未知',
        loading: '读取中…',
        error: '操作失败',
        secSystem: '插件',
        version: '版本',
        checkUpdate: '检查更新',
        update: '立即更新',
        updating: '更新中…',
        upToDate: '已是最新',
        updateAvailable: '有新版本',
        restartNeeded: '已应用，重启 DSH 后生效',
        updateLocalHint: '当前是从本地文件安装的，插件不能自己替换文件，所以这里不提供「立即更新」。'
          + '要启用自更新，请重新安装：dsh plugin --profile desktop add github:muti2607/dsh-codebuddy',
        reloadHint: '登录后即可在模型选择器里选择；若列表未刷新，切换一次模型即可。',
        neverExpire: '长期有效',
        // ── 积分 ──
        secCredits: '积分',
        secCreditsHint: '每日签到可领积分，余额实时查询',
        creditsLeft: '剩余积分',
        creditsAccounts: '{n} 个账号合计',
        creditsTotal: '共 {n} 积分',
        creditsUnit: '积分',
        creditsLoading: '查询中…',
        creditsRefresh: '刷新积分',
        creditsFailed: '积分查询失败',
        creditsNoData: '暂无积分数据',
        claim: '领取积分',
        claiming: '领取中…',
        claimDone: '已领取 +{n} 积分',
        claimAlready: '今日已领取',
        claimInactive: '当前无可领取积分',
        claimFailed: '领取失败',
        claimHintNoActivity: '没有可领取的积分：当前账号都没有进行中的签到活动',
        claimHintAllDone: '今天已经领过了，明天再来',
        claimHintSomeInactive: '另有 {n} 个账号没有签到活动',
        checkedIn: '今日已签到',
        notCheckedIn: '今日未签到',
        checkinNoActivity: '无签到活动',
        checkinNoActivityHint: '这个账号在服务端没有进行中的签到活动，所以没有积分可领',
        checkinAvailable: '可领取',
        streak: '连签 {n} 天',
        dailyCredit: '每日 {n}',
        creditsExpiredHint: '另有 {n} 积分已过期',
        creditsPackages: '{n} 个有效权益包',
        creditsPerAccount: '各账号余额',
        creditsNoAccount: '登录账号后即可查看积分',
        // ── 模型开关 ──
        secModels: '模型',
        secModelsHint: '关掉的模型不会出现在模型选择器里',
        modelsCount: '已启用 {n} / {total}',
        modelsRefresh: '刷新模型',
        modelsEnableAll: '全部启用',
        modelsFailed: '模型清单读取失败',
        modelEnable: '启用',
        modelDisable: '停用',
        modelsAllDisabled: '所有模型都已停用，模型选择器里将看不到这个分组；点「全部启用」可恢复。',
        modelsNote: '改动立即生效。模型选择器如果还显示旧列表，关掉重开一次即可。',
      },
      en: {
        nav: 'CodeBuddy accounts',
        'meta.title': 'CodeBuddy free models',
        'meta.description': 'Tencent CodeBuddy / WorkBuddy free models with built-in browser login.',
        title: 'CodeBuddy accounts',
        sub: 'Click "Add account" and confirm in the browser that opens. Nothing to copy.',
        add: 'Add account',
        addWork: 'Add WorkBuddy',
        waiting: 'Waiting for browser sign-in…',
        waitingHint: 'Browser did not open? Use the link below',
        openManual: 'Open sign-in page',
        cancel: 'Cancel',
        done: 'Signed in',
        failed: 'Sign-in did not complete',
        retry: 'Retry',
        secAccounts: 'Accounts',
        secAccountsHint: 'Sign in once — models become available immediately',
        noAccount: 'No account yet',
        noAccountHint: 'Sign in once with the button above; credentials stay on this machine',
        enabled: 'Active',
        disabled: 'Disabled',
        disable: 'Disable',
        enable: 'Enable',
        del: 'Delete',
        refreshable: 'Refreshable',
        noRefresh: 'Not refreshable',
        expires: 'Expires',
        noExpiry: 'Expiry unknown',
        loading: 'Loading…',
        error: 'Failed',
        secSystem: 'Plugin',
        version: 'Version',
        checkUpdate: 'Check update',
        update: 'Update now',
        updating: 'Updating…',
        upToDate: 'Up to date',
        updateAvailable: 'Update available',
        restartNeeded: 'Applied — restart DSH to take effect',
        updateLocalHint: 'Installed from a local file, so the plugin cannot replace itself. '
          + 'Reinstall to enable self-update: dsh plugin --profile desktop add github:muti2607/dsh-codebuddy',
        reloadHint: 'Models are selectable right after sign-in. If the picker looks stale, switch models once.',
        neverExpire: 'No expiry',
        // ── credits ──
        secCredits: 'Credits',
        secCreditsHint: 'Daily check-in grants credits; balance queried live',
        creditsLeft: 'Credits left',
        creditsAccounts: '{n} accounts total',
        creditsTotal: '{n} credits total',
        creditsUnit: 'credits',
        creditsLoading: 'Querying…',
        creditsRefresh: 'Refresh credits',
        creditsFailed: 'Credit query failed',
        creditsNoData: 'No credit data',
        claim: 'Claim credits',
        claiming: 'Claiming…',
        claimDone: 'Claimed +{n} credits',
        claimAlready: 'Already claimed today',
        claimInactive: 'Nothing to claim right now',
        claimFailed: 'Claim failed',
        claimHintNoActivity: 'Nothing to claim: no check-in activity is running for these accounts',
        claimHintAllDone: 'Already claimed today — come back tomorrow',
        claimHintSomeInactive: '{n} other account(s) have no check-in activity',
        checkedIn: 'Checked in today',
        notCheckedIn: 'Not checked in today',
        checkinNoActivity: 'No check-in activity',
        checkinNoActivityHint: 'The server has no running check-in activity for this account, so there are no credits to claim',
        checkinAvailable: 'Claimable',
        streak: '{n}-day streak',
        dailyCredit: '{n} per day',
        creditsExpiredHint: '{n} credits already expired',
        creditsPackages: '{n} active packages',
        creditsPerAccount: 'Balance per account',
        creditsNoAccount: 'Sign in an account to see credits',
        // ── model toggles ──
        secModels: 'Models',
        secModelsHint: 'Disabled models are hidden from the model picker',
        modelsCount: '{n} of {total} enabled',
        modelsRefresh: 'Refresh models',
        modelsEnableAll: 'Enable all',
        modelsFailed: 'Could not load the model list',
        modelEnable: 'Enable',
        modelDisable: 'Disable',
        modelsAllDisabled: 'All models are disabled, so this group disappears from the picker. Use "Enable all" to restore.',
        modelsNote: 'Changes take effect immediately. If the picker still shows the old list, reopen it.',
      },
    }

    // 两组前缀分别硬编码：/api/cb 登录与账号，/api/codebuddy 版本与自更新。
    const CB = (() => { try { return new URL('api/cb', document.baseURI).pathname } catch { return '/api/cb' } })()
    const MAIN = (() => { try { return new URL('api/codebuddy', document.baseURI).pathname } catch { return '/api/codebuddy' } })()

    async function request(url, options) {
      const { timeout = 15000, ...rest } = options || {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(url, { ...rest, signal: ctrl.signal, redirect: 'error' })
        const text = await r.text()
        let body
        try { body = text ? JSON.parse(text) : {} } catch { body = { error: text.slice(0, 200) } }
        return body
      } finally { clearTimeout(timer) }
    }
    const api = (path, opts) => request(CB + path, opts)
    const apiMain = (path, opts) => request(MAIN + path, opts)
    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    const fmtTime = (ms) => {
      if (!ms) return ''
      try {
        return new Date(ms).toLocaleString(undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        })
      } catch { return '' }
    }

    /* 与 OFM 同一套视觉令牌与层级约定 */
    const CSS = `
.cb_root{--ease:cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;gap:18px;max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.cb_root *{box-sizing:border-box}
.cb_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px}

/* ── 页头 hero：渐变底 + 两处径向光，标题用渐变文字 ── */
.cb_hero{position:relative;display:flex;flex-direction:column;gap:12px;padding:20px 22px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.cb_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.cb_hero>*{position:relative}
.cb_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.cb_pagetitle{display:flex;flex-direction:column;gap:5px;min-width:0}
.cb_pagetitle h2{margin:0;font-size:22px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.cb_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.cb_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.cb_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.cb_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.cb_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes cb-breathe{0%,100%{opacity:1}50%{opacity:.5}}
.cb_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:cb-breathe 2.6s ease-in-out infinite}
.cb_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.cb_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
.cb_dot.busy{background:var(--dsw-alias-state-business-primary);animation:cb-breathe 1.1s ease-in-out infinite}

/* ── 分节 ── */
.cb_sec{display:flex;flex-direction:column;gap:10px}
.cb_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.cb_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.cb_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.cb_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:10px}

/* ── 卡片：双层 bezel，hover 抬升 2px ── */
.cb_card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);transition:transform .2s var(--ease),box-shadow .24s ease,border-color .18s ease}
.cb_card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.cb_card.dim{opacity:.66}
.cb_card.panel{padding:14px 15px;border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);gap:10px}
.cb_cardhead{display:flex;align-items:center;gap:8px}
.cb_cardname{font-size:13.5px;font-weight:650;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb_badge{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap}
.cb_badge.on{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.cb_badge.off{color:var(--dsw-alias-label-tertiary)}
.cb_badge.new{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.cb_tags{display:flex;gap:5px;flex-wrap:wrap}
.cb_tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.cb_metrics{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.cb_metrics b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.cb_actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:2px}

/* ── 按钮 ── */
.cb_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease),border-color .2s var(--ease),background .2s var(--ease),box-shadow .22s var(--ease),opacity .16s ease}
.cb_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.cb_btn:active:not(:disabled){transform:scale(.985);transition-duration:.1s}
.cb_btn:disabled{opacity:.45;cursor:default;transform:none;box-shadow:none}
.cb_btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),var(--dsw-alias-state-business-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);color:var(--dsw-alias-label-on-accent,#fff);box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.cb_btn.primary:hover:not(:disabled){background:linear-gradient(180deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#000));box-shadow:inset 0 1px 0 rgb(255 255 255 / 20%),0 4px 14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.cb_btn.ghost{background:transparent;box-shadow:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.cb_btn.ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.cb_mini{font:inherit;font-size:11px;font-weight:540;padding:3px 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .12s ease,border-color .16s ease,color .16s ease,background .16s ease,opacity .16s ease}
.cb_mini:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);transform:translateY(-1px)}
.cb_mini:active:not(:disabled){transform:scale(.96)}
.cb_mini:disabled{opacity:.45;cursor:default;transform:none}
.cb_mini.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}

/* ── 提示与等待态 ── */
.cb_note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.cb_msg{font-size:12px;padding:8px 11px;border-radius:10px;border:1px solid transparent}
.cb_msg.err{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.cb_msg.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.cb_wait{display:flex;flex-direction:column;gap:8px}
.cb_waitline{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:560}
.cb_link{font-size:11.5px;color:var(--dsw-alias-state-business-primary);word-break:break-all;text-decoration:none;border-bottom:1px dashed color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);padding-bottom:1px}
.cb_link:hover{color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000)}
.cb_empty{display:flex;flex-direction:column;gap:4px;padding:18px 6px;text-align:center}
.cb_empty b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}

/* ── 积分 ──
   注意选择器写成 .cb_card.panel.cb_credits：.cb_card.panel 里有
   flex-direction:column（权重 0,2,0），单写 .cb_credits（0,1,0）压不住它，
   卡片会被排成纵向 + align-items:flex-end，结果整块内容挤到右半边、左侧全空。 */
.cb_card.panel.cb_credits{display:flex;flex-direction:row;align-items:flex-end;justify-content:space-between;gap:22px;flex-wrap:wrap;padding:16px 18px}
.cb_creditmain{display:flex;flex-direction:column;gap:5px;min-width:0;flex:1 1 240px}
.cb_creditlabel{font-size:10.5px;font-weight:650;letter-spacing:.55px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.cb_creditnum{display:flex;align-items:baseline;gap:7px;min-width:0}
.cb_creditval{font-size:34px;font-weight:770;letter-spacing:-1.4px;line-height:1;font-variant-numeric:tabular-nums;background:linear-gradient(150deg,var(--dsw-alias-label-primary) 30%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,var(--dsw-alias-label-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.cb_creditunit{font-size:12px;font-weight:600;color:var(--dsw-alias-label-tertiary);padding-bottom:3px}
.cb_creditmeta{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.cb_creditmeta b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.cb_creditside{display:flex;flex-direction:column;gap:9px;align-items:flex-end;flex:0 0 auto}
.cb_creditstatus{display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.cb_creditsep{color:var(--dsw-alias-label-tertiary)}
.cb_credit_err{color:var(--dsw-alias-state-error-primary)}
.cb_creditreason{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:right;line-height:1.45;max-width:34ch}
.cb_tag.muted{color:var(--dsw-alias-label-tertiary);border-style:dashed;background:transparent}
.cb_creditactions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.cb_week{display:flex;gap:4px;align-items:center}
.cb_day{width:14px;height:14px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);flex:none}
.cb_day.on{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 70%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent)}
.cb_creditrow{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px}
.cb_creditrow:first-of-type{border-top:none}
.cb_creditrow .cb_cardname{flex:1;font-size:12.5px;font-weight:560}
.cb_creditrow .cb_num{font-variant-numeric:tabular-nums;font-weight:650;color:var(--dsw-alias-label-primary)}
.cb_creditrow .cb_num.zero{color:var(--dsw-alias-label-tertiary);font-weight:560}
.cb_skeleton{height:34px;width:96px;border-radius:9px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent));background-size:200% 100%;animation:cb-shimmer 1.4s ease-in-out infinite}
@keyframes cb-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

/* ── 模型开关 ── */
.cb_modgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:2px 14px}
.cb_modrow{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 70%,transparent);min-width:0}
.cb_modrow.off{opacity:.55}
.cb_modname{flex:1;min-width:0;font-size:12.5px;font-weight:540;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cb_modrow.off .cb_modname{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 70%,transparent)}
.cb_mini.muted{color:var(--dsw-alias-label-tertiary);border-color:color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent)}
`

    function SettingsPage(props) {
      const t = (key) => (props && props.t ? props.t(key) : key)
      const [accounts, setAccounts] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const [ver, setVer] = useState(null)
      const [update, setUpdate] = useState(null)
      const [updating, setUpdating] = useState(false)
      // 积分：credits = 最近一次 /credits 的返回（含各账号明细与汇总）
      const [credits, setCredits] = useState(null)
      const [creditsBusy, setCreditsBusy] = useState(false)
      const [creditsErr, setCreditsErr] = useState('')
      const [claiming, setClaiming] = useState(false)
      const [claimMsg, setClaimMsg] = useState('')
      // 模型开关：models = /models 的返回（models[] + total + enabledCount）
      const [models, setModels] = useState(null)
      const [modelsBusy, setModelsBusy] = useState(false)
      const [modelsErr, setModelsErr] = useState('')
      const pollRef = useRef(null)

      const load = () => api('/accounts').then((data) => {
        if (data && data.ok) { setAccounts(data.accounts || []); setError('') }
        else setError(String((data && data.error) || 'bad-response'))
      }).catch((e) => setError(String(e.message || e)))

      /** 拉积分：余额少、单次两个请求，直接查，不做缓存。 */
      const loadCredits = (quiet) => {
        if (!quiet) setCreditsBusy(true)
        setCreditsErr('')
        return api('/credits', { timeout: 30000 })
          .then((data) => {
            if (data && data.ok) setCredits(data)
            else setCreditsErr(String((data && data.error) || 'bad-response'))
          })
          .catch((e) => setCreditsErr(String(e.message || e)))
          .finally(() => { if (!quiet) setCreditsBusy(false) })
      }

      useEffect(() => {
        load()
        loadCredits()
        loadModels()
        apiMain('/version').then(setVer).catch(() => {})
        return () => { if (pollRef.current) clearInterval(pollRef.current) }
      }, [])

      // 轮询登录：done / failed 即停表；done 时刷新账号列表
      useEffect(() => {
        if (!login || login.status !== 'pending') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          return undefined
        }
        const tick = async () => {
          try {
            const r = await api('/login?accountId=' + encodeURIComponent(login.accountId))
            if (!r || r.ok === false) {
              setLogin((prev) => (prev ? { ...prev, status: 'failed', error: (r && r.error) || '' } : prev))
              return
            }
            if (r.status === 'done') {
              setLogin((prev) => (prev ? { ...prev, status: 'done', nickname: r.nickname } : prev))
              setNotice(t('done') + (r.nickname ? '：' + r.nickname : ''))
              load()
            } else if (r.status === 'failed') {
              setLogin((prev) => (prev ? { ...prev, status: 'failed', error: r.error || '' } : prev))
            }
          } catch { /* 下一拍再试 */ }
        }
        pollRef.current = setInterval(tick, 1500)
        tick()
        return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
      }, [login && login.accountId, login && login.status])

      async function startLogin(provider) {
        setBusy('login'); setError(''); setNotice('')
        try {
          const r = await post('/login?provider=' + encodeURIComponent(provider), {})
          if (!r || !r.ok) throw new Error((r && r.error) || 'login-failed')
          setLogin({ accountId: r.accountId, loginUrl: r.loginUrl, status: 'pending', provider })
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      async function act(accountId, action, extra) {
        setBusy(action + ':' + accountId); setError('')
        try {
          const r = await post('/accounts', { accountId, action, ...extra })
          if (!r || !r.ok) throw new Error((r && r.error) || 'failed')
          load()
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      /** 拉模型清单（含每项启用状态）。 */
      const loadModels = () => {
        setModelsBusy(true)
        setModelsErr('')
        return api('/models', { timeout: 30000 })
          .then((data) => {
            if (data && data.ok) setModels(data)
            else setModelsErr(String((data && data.error) || 'bad-response'))
          })
          .catch((e) => setModelsErr(String(e.message || e)))
          .finally(() => setModelsBusy(false))
      }

      /**
       * 切换单个模型的启用状态。
       *
       * 先本地翻转再请求：18 个开关手点时，等一次往返会让按钮发木。
       * 请求失败就用服务端返回覆盖回来，不会留下错误状态。
       */
      async function toggleModel(model) {
        const next = !model.enabled
        setModels((prev) => {
          if (!prev) return prev
          const list = prev.models.map((m) => (m.id === model.id ? { ...m, enabled: next } : m))
          const enabledCount = list.filter((m) => m.enabled).length
          return { ...prev, models: list, enabledCount, allDisabled: enabledCount === 0 }
        })
        setModelsBusy(true)
        setModelsErr('')
        try {
          const r = await post('/models', { modelId: model.id, enabled: next })
          if (!r || !r.ok) throw new Error((r && r.error) || 'failed')
        } catch (e) {
          setModelsErr(String(e.message || e))
          loadModels()
        } finally { setModelsBusy(false) }
      }

      async function enableAllModels() {
        setModelsBusy(true)
        setModelsErr('')
        try {
          const r = await post('/models', { action: 'enableAll' })
          if (!r || !r.ok) throw new Error((r && r.error) || 'failed')
          loadModels()
        } catch (e) { setModelsErr(String(e.message || e)) }
        finally { setModelsBusy(false) }
      }

      async function claimCredits() {
        setClaiming(true); setClaimMsg('')
        try {
          const r = await api('/credits/claim', { method: 'POST', timeout: 60000 })
          if (!r || !r.ok) throw new Error((r && r.error) || 'claim-failed')
          const results = r.results || []
          const gained = Number(r.gained) || 0
          if (gained > 0) {
            setClaimMsg(t('claimDone').replace('{n}', String(gained)))
          } else if (results.some((x) => x.status === 'already-claimed')) {
            setClaimMsg(t('claimAlready'))
          } else if (results.every((x) => x.status === 'inactive')) {
            setClaimMsg(t('claimInactive'))
          } else {
            const first = results.find((x) => x.status === 'failed')
            throw new Error((first && first.message) || t('claimFailed'))
          }
          // 领取成功后余额与签到状态都变了，必须重查；否则界面仍是旧的「可领取」
          loadCredits()
        } catch (e) {
          setClaimMsg(t('claimFailed') + ': ' + String(e.message || e))
        } finally { setClaiming(false) }
      }

      async function checkUpdate() {
        setBusy('check')
        try { setUpdate(await apiMain('/update?force=1', { timeout: 30000 })) }
        catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      async function applyUpdate() {
        setUpdating(true); setError('')
        try {
          const r = await apiMain('/update', { method: 'POST', timeout: 180000 })
          if (r && r.restartRequired) setNotice(t('restartNeeded'))
          else if (r && r.ok) setNotice(t('updateAvailable') + ' → ' + (r.version || ''))
          else setError(String((r && r.error) || 'update-failed'))
          checkUpdate()
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setUpdating(false) }
      }

      const rows = accounts || []
      const activeCount = rows.filter((a) => a.enabled).length
      const version = ver && ver.version ? ver.version : '—'

      // ── 积分派生值 ──
      const creditRows = (credits && credits.accounts) || []
      const creditTotal = credits && Number.isFinite(credits.total) ? credits.total : 0
      const expiredTotal = creditRows.reduce((sum, r) => (
        sum + (r.balance && Number.isFinite(r.balance.expiredTotal) ? r.balance.expiredTotal : 0)
      ), 0)
      // 只要有一个账号「活动进行中且今天还没领」，就认为可以领取（多账号时一键领全部）
      const claimable = creditRows.some((r) => r.checkin && r.checkin.canClaim)
      // 有签到活动的账号：用来区分「都领完了」和「压根没活动」——
      // 这两种情况都不能点领取，但原因完全不同，含糊过去会让人以为按钮坏了。
      const activeRows = creditRows.filter((r) => r.checkin && r.checkin.active)
      const inactiveCount = creditRows.length - activeRows.length
      const claimHint = (() => {
        if (claimable) return ''
        const base = activeRows.length === 0 ? t('claimHintNoActivity') : t('claimHintAllDone')
        // 混合场景（有的账号在活动期、有的压根没活动）要两个都说，
        // 否则用户看着「无签到活动」那行会以为漏领了。
        if (activeRows.length > 0 && inactiveCount > 0) {
          return `${base} · ${t('claimHintSomeInactive').replace('{n}', String(inactiveCount))}`
        }
        return base
      })()
      const checkedInToday = creditRows.some((r) => r.checkin && r.checkin.checkedInToday)
      const streakDays = creditRows.reduce((max, r) => Math.max(max, (r.checkin && r.checkin.streakDays) || 0), 0)
      const dailyCredit = creditRows.reduce((max, r) => Math.max(max, (r.checkin && r.checkin.dailyCredit) || 0), 0)
      const weekProgress = (creditRows.find((r) => r.checkin && r.checkin.weekProgress && r.checkin.weekProgress.length)
        || {}).checkin?.weekProgress || []
      const fmtCredit = (n) => {
        const v = Number(n)
        if (!Number.isFinite(v)) return '—'
        return Number.isInteger(v) ? String(v) : v.toFixed(2)
      }

      return h('div', { className: 'cb_root' },
        h('style', null, CSS),

        // ── hero ──
        h('div', { className: 'cb_hero' },
          h('div', { className: 'cb_pagehead' },
            h('div', { className: 'cb_pagetitle' },
              h('h2', null, t('title')),
              h('p', { className: 'cb_pagesub' }, t('sub'))),
            h('div', { className: 'cb_pills' },
              h('span', { className: 'cb_pill' + (activeCount ? ' strong' : '') },
                h('span', { className: 'cb_dot' + (activeCount ? ' ok' : '') }),
                activeCount ? `${activeCount} ${t('enabled')}` : t('noAccount')),
              h('span', { className: 'cb_pill strong' }, t('version') + ' ' + version)))),

        error ? h('div', { className: 'cb_msg err' }, error) : null,
        notice ? h('div', { className: 'cb_msg ok' }, notice) : null,

        // ── 登录进行中 ──
        login && login.status === 'pending'
          ? h('div', { className: 'cb_card panel' },
            h('div', { className: 'cb_wait' },
              h('div', { className: 'cb_waitline' },
                h('span', { className: 'cb_dot busy' }),
                t('waiting')),
              h('div', { className: 'cb_note' }, t('waitingHint')),
              h('div', null,
                h('a', { className: 'cb_link', href: login.loginUrl, target: '_blank', rel: 'noreferrer noopener' },
                  t('openManual'))),
              h('div', { className: 'cb_actions' },
                h('button', { className: 'cb_btn ghost', onClick: () => setLogin(null) }, t('cancel')))))
          : null,

        // ── 登录失败 ──
        login && login.status === 'failed'
          ? h('div', { className: 'cb_card panel' },
            h('div', { className: 'cb_cardhead' },
              h('span', { className: 'cb_dot err' }),
              h('span', { className: 'cb_cardname' }, t('failed'))),
            login.error ? h('div', { className: 'cb_msg err' }, login.error) : null,
            h('div', null,
              h('a', { className: 'cb_link', href: login.loginUrl, target: '_blank', rel: 'noreferrer noopener' },
                t('openManual'))),
            h('div', { className: 'cb_actions' },
              h('button', {
                className: 'cb_btn primary',
                onClick: () => { setLogin(null); startLogin(login.provider || 'buddy') },
              }, t('retry')),
              h('button', { className: 'cb_btn ghost', onClick: () => setLogin(null) }, t('cancel'))))
          : null,

        // ── 积分分节 ──
        h('div', { className: 'cb_sec' },
          h('div', { className: 'cb_sechead' },
            h('span', { className: 'cb_sec_title' }, t('secCredits')),
            h('span', { className: 'cb_sec_hint' },
              creditRows.length ? t('creditsPerAccount') : t('secCreditsHint'))),

          h('div', { className: 'cb_card panel cb_credits' },
            // ── 左：余额主体（标签 / 大数字 / 说明）──
            h('div', { className: 'cb_creditmain' },
              h('div', { className: 'cb_creditlabel' }, t('creditsLeft')),
              creditsBusy && !credits
                ? h('div', { className: 'cb_skeleton' })
                : h('div', { className: 'cb_creditnum' },
                  h('span', { className: 'cb_creditval' }, fmtCredit(creditTotal)),
                  h('span', { className: 'cb_creditunit' }, t('creditsUnit'))),
              h('div', { className: 'cb_creditmeta' },
                creditsBusy && !credits
                  ? h('span', null, t('creditsLoading'))
                  : creditsErr
                    ? h('span', { className: 'cb_credit_err' }, t('creditsFailed') + '：' + creditsErr)
                    : h('span', null, t('creditsTotal').replace('{n}', fmtCredit(creditTotal))),
                // 多账号时把「几个账号的合计」说清楚，否则 810.92 会让人以为只有一个号
                !creditsErr && creditRows.length > 1
                  ? h('span', null, t('creditsAccounts').replace('{n}', String(creditRows.length)))
                  : null,
                expiredTotal > 0
                  ? h('span', null, t('creditsExpiredHint').replace('{n}', fmtCredit(expiredTotal)))
                  : null)),

            // ── 右：签到状态 / 本周进度 / 操作 ──
            h('div', { className: 'cb_creditside' },
              creditRows.length
                ? h('div', { className: 'cb_creditstatus' },
                  h('span', { className: 'cb_dot' + (checkedInToday ? ' ok' : '') }),
                  h('span', null, checkedInToday ? t('checkedIn') : t('notCheckedIn')),
                  streakDays > 0 ? h('span', { className: 'cb_creditsep' }, '·') : null,
                  streakDays > 0 ? h('span', null, t('streak').replace('{n}', String(streakDays))) : null,
                  dailyCredit > 0 ? h('span', { className: 'cb_creditsep' }, '·') : null,
                  dailyCredit > 0 ? h('span', null, t('dailyCredit').replace('{n}', fmtCredit(dailyCredit))) : null)
                : null,
              weekProgress.length
                ? h('div', { className: 'cb_week' },
                  weekProgress.map((on, i) => h('span', {
                    key: 'd' + i, className: 'cb_day' + (on ? ' on' : ''), title: on ? '已签到' : '未签到',
                  })))
                : null,
              h('div', { className: 'cb_creditactions' },
                // 领取按钮：只有「活动进行中且今天未领」才可点，避免点了才报「已领」
                h('button', {
                  className: 'cb_btn primary',
                  disabled: claiming || creditsBusy || !claimable,
                  title: claimable ? '' : claimHint,
                  onClick: claimCredits,
                }, claiming ? t('claiming') : t('claim')),
                h('button', {
                  className: 'cb_btn',
                  disabled: claiming || creditsBusy,
                  onClick: () => loadCredits(),
                }, creditsBusy ? t('creditsLoading') : t('creditsRefresh'))),
              // 不能领取时把原因写出来：「都领完了」和「这个账号没有签到活动」
              // 是两件事，只把按钮置灰会让人以为功能坏了。
              claimHint ? h('div', { className: 'cb_creditreason' }, claimHint) : null)),

          claimMsg ? h('div', {
            className: 'cb_msg' + (/失败|failed/i.test(claimMsg) ? ' err' : ' ok'),
          }, claimMsg) : null,

          // 各账号明细
          creditRows.length
            ? h('div', { className: 'cb_card panel' },
              creditRows.map((r) => h('div', { key: r.accountId, className: 'cb_creditrow' },
                h('span', { className: 'cb_cardname' }, r.nickname || r.accountId),
                r.ok
                  ? h('span', { className: 'cb_num' + (r.balance && r.balance.total > 0 ? '' : ' zero') },
                    fmtCredit(r.balance ? r.balance.total : 0))
                  : h('span', { className: 'cb_note' }, r.error || t('creditsFailed')),
                // 三态：活动未开通 ≠ 今天没签。后者可以领，前者没得领。
                r.checkin
                  ? h('span', {
                    className: 'cb_tag' + (r.checkin.active ? '' : ' muted'),
                    title: r.checkin.active ? '' : t('checkinNoActivityHint'),
                  }, !r.checkin.active
                    ? t('checkinNoActivity')
                    : (r.checkin.checkedInToday ? t('checkedIn') : t('checkinAvailable')))
                  : null)))
            : null),

        // ── 账号分节 ──
        h('div', { className: 'cb_sec' },
          h('div', { className: 'cb_sechead' },
            h('span', { className: 'cb_sec_title' }, t('secAccounts')),
            h('span', { className: 'cb_sec_hint' }, t('secAccountsHint'))),
          // 按钮单独一行：cb_sec_hint 有 margin-left:auto，塞进同一行会把按钮挤到左边缘
          h('div', { className: 'cb_actions' },
            h('button', {
              className: 'cb_btn primary', disabled: !!busy, onClick: () => startLogin('buddy'),
            }, busy === 'login' ? t('waiting') : t('add')),
            h('button', {
              className: 'cb_btn', disabled: !!busy, onClick: () => startLogin('workbuddy'),
            }, t('addWork'))),
          rows.length
            ? h('div', { className: 'cb_grid' }, rows.map((a) => h('div', {
              key: a.id, className: 'cb_card' + (a.enabled ? '' : ' dim'),
            },
              h('div', { className: 'cb_cardhead' },
                h('span', { className: 'cb_cardname' }, a.nickname || a.id),
                h('span', { className: 'cb_badge ' + (a.enabled ? 'on' : 'off') },
                  a.enabled ? t('enabled') : t('disabled'))),
              h('div', { className: 'cb_tags' },
                h('span', { className: 'cb_tag' }, a.refreshable ? t('refreshable') : t('noRefresh')),
                a.provider ? h('span', { className: 'cb_tag' }, a.provider) : null),
              h('div', { className: 'cb_metrics' },
                h('span', null, t('expires') + ' ',
                  h('b', null, a.expiresAt ? fmtTime(a.expiresAt) : t('noExpiry')))),
              h('div', { className: 'cb_actions' },
                h('button', {
                  className: 'cb_mini', disabled: !!busy,
                  onClick: () => act(a.id, 'setEnabled', { enabled: !a.enabled }),
                }, a.enabled ? t('disable') : t('enable')),
                h('button', {
                  className: 'cb_mini danger', disabled: !!busy,
                  onClick: () => act(a.id, 'delete'),
                }, t('del'))))))
            : h('div', { className: 'cb_card panel' },
              h('div', { className: 'cb_empty' },
                h('b', null, t('noAccount')),
                h('div', { className: 'cb_note' }, t('noAccountHint'))))),

        // ── 模型分节 ──
        h('div', { className: 'cb_sec' },
          h('div', { className: 'cb_sechead' },
            h('span', { className: 'cb_sec_title' }, t('secModels')),
            h('span', { className: 'cb_sec_hint' },
              models && models.total
                ? t('modelsCount')
                  .replace('{n}', String(models.enabledCount))
                  .replace('{total}', String(models.total))
                : t('secModelsHint'))),
          modelsErr
            ? h('div', { className: 'cb_msg err' }, t('modelsFailed') + '：' + modelsErr)
            : null,
          h('div', { className: 'cb_actions' },
            h('button', {
              className: 'cb_btn', disabled: !!busy || modelsBusy, onClick: () => loadModels(),
            }, modelsBusy ? t('creditsLoading') : t('modelsRefresh')),
            h('button', {
              className: 'cb_btn', disabled: !!busy || modelsBusy || !models || models.enabledCount === models.total,
              onClick: enableAllModels,
            }, t('modelsEnableAll'))),
          models && models.allDisabled
            ? h('div', { className: 'cb_msg err' }, t('modelsAllDisabled'))
            : null,
          !models
            ? h('div', { className: 'cb_card panel' },
              h('div', { className: 'cb_empty' },
                h('b', null, modelsErr ? t('modelsFailed') : t('creditsLoading'))))
            : h('div', { className: 'cb_card panel' },
              h('div', { className: 'cb_modgrid' }, models.models.map((m) => h('div', {
                key: m.id,
                className: 'cb_modrow' + (m.enabled ? '' : ' off'),
              },
                h('span', { className: 'cb_modname', title: m.id }, m.name),
                h('button', {
                  className: 'cb_mini' + (m.enabled ? '' : ' muted'),
                  disabled: modelsBusy,
                  onClick: () => toggleModel(m),
                }, m.enabled ? t('modelDisable') : t('modelEnable'))))),
              h('div', { className: 'cb_note' }, t('modelsNote')))),

        // ── 插件分节 ──
        h('div', { className: 'cb_sec' },
          h('div', { className: 'cb_sechead' },
            h('span', { className: 'cb_sec_title' }, t('secSystem')),
            h('span', { className: 'cb_sec_hint' }, t('version') + ' ' + version)),
          h('div', { className: 'cb_card panel' },
            h('div', { className: 'cb_cardhead' },
              h('span', { className: 'cb_cardname' }, t('version')),
              h('span', { className: 'cb_metrics' }, h('b', null, version)),
              update && update.ok
                ? h('span', { className: 'cb_badge ' + (update.available ? 'new' : 'on') },
                  update.available ? t('updateAvailable') + ' ' + update.remoteVersion : t('upToDate'))
                : null),
            h('div', { className: 'cb_actions' },
              h('button', { className: 'cb_btn', disabled: !!busy || updating, onClick: checkUpdate }, t('checkUpdate')),
              // 只有**能真的装**的时候才给「立即更新」按钮。
              // 本地文件安装（file:/link:）时 updatable=false，这个按钮点了必然失败，
              // 留着只会让人以为坏了——改成下面一行说明，告诉他该怎么装。
              update && update.available && update.updatable
                ? h('button', { className: 'cb_btn primary', disabled: updating, onClick: applyUpdate },
                  updating ? t('updating') : t('update'))
                : null),
            update && update.available && update.updatable === false
              ? h('div', { className: 'cb_note' }, t('updateLocalHint')
                + (update.installSource && update.installSource.spec ? '（' + update.installSource.spec + '）' : ''))
              : null)),

        h('div', { className: 'cb_note' }, t('reloadHint')))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const unregisterLocale = ctx.locale.register(NS, DICT)
        const unregisterSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-codebuddy',
          order: 38,
          label: () => DICT.zh.nav,
          locale: NS,
        }, (props) => h(SettingsPage, props)))
        return () => {
          try { unregisterSection && unregisterSection() } catch { /* ignore */ }
          try { unregisterLocale && unregisterLocale() } catch { /* ignore */ }
        }
      },
    }
  },
})
