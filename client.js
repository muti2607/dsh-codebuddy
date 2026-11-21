/**
 * dsh-codebuddy — Client half (Web).
 *
 * 在设置里加一页「CodeBuddy 账号」：
 *   · 「添加账号」→ 调 Host 的 /api/cb/login 拿到登录页 URL，并自动打开浏览器；
 *     面板显示「等待浏览器授权…」，轮询到 done / failed 后即刻刷新账号列表
 *   · 账号行显示昵称、过期时间、是否可续期；可停用 / 删除
 *   · 版本与自更新状态也在这里，一键更新
 *   · 凭据只发往本机同源 API；所有响应都不含令牌本体
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
        'meta.description': '腾讯 CodeBuddy / WorkBuddy 免模型接入，内置浏览器登录。',
        title: 'CodeBuddy 账号',
        sub: '点「添加账号」后浏览器会打开登录页，确认后自动完成，无需复制任何东西。',
        add: '添加账号',
        addWork: '添加 WorkBuddy',
        waiting: '等待浏览器授权…',
        waitingHint: '若浏览器没有自动打开，点下面的链接手动前往',
        openManual: '打开登录页',
        cancel: '取消',
        done: '登录完成',
        failed: '登录未完成',
        retry: '重试',
        accounts: '账号',
        noAccount: '还没有账号，点上面的按钮登录一次即可',
        enabled: '已启用',
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
        version: '版本',
        checkUpdate: '检查更新',
        update: '立即更新',
        updating: '更新中…',
        upToDate: '已是最新',
        updateAvailable: '有新版本',
        restartNeeded: '更新已应用，重启 DSH 后生效',
        reloadHint: '登录成功后模型选择器立即可用；如界面未刷新，切换一次模型即可。',
      },
      en: {
        nav: 'CodeBuddy accounts',
        'meta.title': 'CodeBuddy free models',
        'meta.description': 'Tencent CodeBuddy / WorkBuddy free models with built-in browser login.',
        title: 'CodeBuddy accounts',
        sub: 'Click "Add account" and sign in via the browser that opens. Nothing to copy.',
        add: 'Add account',
        addWork: 'Add WorkBuddy',
        waiting: 'Waiting for browser sign-in…',
        waitingHint: 'If the browser did not open, use this link',
        openManual: 'Open sign-in page',
        cancel: 'Cancel',
        done: 'Signed in',
        failed: 'Sign-in did not complete',
        retry: 'Retry',
        accounts: 'Accounts',
        noAccount: 'No account yet — sign in once with the button above',
        enabled: 'Enabled',
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
        version: 'Version',
        checkUpdate: 'Check update',
        update: 'Update now',
        updating: 'Updating…',
        upToDate: 'Up to date',
        updateAvailable: 'Update available',
        restartNeeded: 'Update applied — restart DSH to take effect',
        reloadHint: 'Models are available right after sign-in. If the picker looks stale, switch models once.',
      },
    }

    // 两组路由分开：登录/账号在 /api/cb，版本与自更新在 /api/codebuddy。
    // 直接写死两条前缀，避免用正则从一条推导另一条（推导错会静默 404）。
    const CB = (() => {
      try { return new URL('api/cb', document.baseURI).pathname } catch { return '/api/cb' }
    })()
    const MAIN = (() => {
      try { return new URL('api/codebuddy', document.baseURI).pathname } catch { return '/api/codebuddy' }
    })()

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
        return new Date(ms).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      } catch { return '' }
    }

    function SettingsPage(props) {
      const t = (key) => (props && props.t ? props.t(key) : key)
      const [accounts, setAccounts] = useState(null)
      const [pending, setPending] = useState([])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)   // { accountId, loginUrl, status }
      const [ver, setVer] = useState(null)
      const [update, setUpdate] = useState(null)
      const [updating, setUpdating] = useState(false)
      const pollRef = useRef(null)

      const load = () => api('/accounts').then((data) => {
        if (data && data.ok) { setAccounts(data.accounts || []); setPending(data.pending || []); setError('') }
        else setError(String((data && data.error) || 'bad-response'))
      }).catch((e) => setError(String(e.message || e)))

      useEffect(() => {
        load()
        apiMain('/version').then(setVer).catch(() => {})
        return () => { if (pollRef.current) clearInterval(pollRef.current) }
      }, [])

      // 轮询登录结果：done/failed 时停表并刷新账号
      useEffect(() => {
        if (!login || login.status !== 'pending') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          return undefined
        }
        const tick = async () => {
          try {
            const r = await api('/login?accountId=' + encodeURIComponent(login.accountId))
            if (!r || r.ok === false) {
              setLogin((prev) => prev ? { ...prev, status: 'failed', error: (r && r.error) || '' } : prev)
              return
            }
            if (r.status === 'done') {
              setLogin((prev) => prev ? { ...prev, status: 'done', nickname: r.nickname } : prev)
              setNotice(t('done') + (r.nickname ? '：' + r.nickname : ''))
              load()
            } else if (r.status === 'failed') {
              setLogin((prev) => prev ? { ...prev, status: 'failed', error: r.error || '' } : prev)
            }
          } catch { /* 下一拍再试 */ }
        }
        pollRef.current = setInterval(tick, 1500)
        tick()
        return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null } }
      }, [login && login.accountId, login && login.status])

      async function startLogin(provider) {
        setBusy('login')
        setError('')
        setNotice('')
        try {
          const r = await post('/login?provider=' + encodeURIComponent(provider), {})
          if (!r || !r.ok) throw new Error((r && r.error) || 'login-failed')
          setLogin({ accountId: r.accountId, loginUrl: r.loginUrl, status: 'pending', provider })
        } catch (e) {
          setError(t('error') + ': ' + String(e.message || e))
        } finally { setBusy('') }
      }

      async function act(accountId, action, extra) {
        setBusy(action + ':' + accountId)
        setError('')
        try {
          const r = await post('/accounts', { accountId, action, ...extra })
          if (!r || !r.ok) throw new Error((r && r.error) || 'failed')
          load()
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      async function checkUpdate() {
        setBusy('check')
        try {
          const r = await apiMain('/update?force=1', { timeout: 30000 })
          setUpdate(r)
        } catch (e) { setError(t('error') + ': ' + String(e.message || e)) }
        finally { setBusy('') }
      }

      async function applyUpdate() {
        setUpdating(true)
        setError('')
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
      return h('div', { className: 'cb-root' },
        h('style', null, `
.cb-root{font:inherit;color:var(--dsw-alias-label-primary,inherit)}
.cb-head{margin-bottom:14px}
.cb-title{margin:0;font-size:17px;font-weight:600}
.cb-sub{margin:5px 0 0;font-size:12px;opacity:.72;line-height:1.6}
.cb-card{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
.cb-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.cb-name{font-weight:600;font-size:13px}
.cb-badge{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));opacity:.85}
.cb-badge-on{color:#1a9c6a;border-color:#1a9c6a;opacity:1}
.cb-meta{font-size:11px;opacity:.65}
.cb-actions{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.cb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.4));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.cb-btn:hover:not(:disabled){border-color:#4C8DFF;color:#4C8DFF}
.cb-btn:disabled{opacity:.55;cursor:default}
.cb-btn-primary{border-color:#4C8DFF;color:#4C8DFF}
.cb-link{font-size:12px;word-break:break-all;margin-top:8px}
.cb-note{font-size:12px;margin-top:10px;opacity:.75}
.cb-error{color:#e05555;font-size:12px;margin:8px 0}
.cb-ok{color:#1a9c6a;font-size:12px;margin:8px 0}
.cb-wait{display:flex;align-items:center;gap:8px;font-size:12px;margin-top:8px}
.cb-dot{width:8px;height:8px;border-radius:50%;background:#4C8DFF;animation:cbb 1s infinite}
@keyframes cbb{0%,100%{opacity:.25}50%{opacity:1}}
`),
        h('div', { className: 'cb-head' },
          h('h1', { className: 'cb-title' }, t('title')),
          h('p', { className: 'cb-sub' }, t('sub'))),
        error ? h('div', { className: 'cb-error' }, error) : null,
        notice ? h('div', { className: 'cb-ok' }, notice) : null,

        // 登录进行中 / 完成 / 失败
        login ? h('div', { className: 'cb-card' },
          login.status === 'pending'
            ? h('div', null,
              h('div', { className: 'cb-wait' }, h('span', { className: 'cb-dot' }), t('waiting')),
              h('div', { className: 'cb-meta', style: { marginTop: 6 } }, t('waitingHint')),
              h('div', { className: 'cb-link' },
                h('a', { href: login.loginUrl, target: '_blank', rel: 'noreferrer noopener' }, login.loginUrl)),
              h('div', { className: 'cb-actions' },
                h('button', { className: 'cb-btn', onClick: () => setLogin(null) }, t('cancel'))))
            : login.status === 'done'
              ? h('div', { className: 'cb-ok' }, t('done') + (login.nickname ? '：' + login.nickname : ''))
              : h('div', null,
                h('div', { className: 'cb-error' }, t('failed') + (login.error ? '：' + login.error : '')),
                h('div', { className: 'cb-link' },
                  h('a', { href: login.loginUrl, target: '_blank', rel: 'noreferrer noopener' }, t('openManual'))),
                h('div', { className: 'cb-actions' },
                  h('button', { className: 'cb-btn cb-btn-primary', onClick: () => { setLogin(null); startLogin(login.provider || 'buddy') } }, t('retry')),
                  h('button', { className: 'cb-btn', onClick: () => setLogin(null) }, t('cancel'))))) : null,

        // 账号列表
        h('div', { className: 'cb-card' },
          h('div', { className: 'cb-row' },
            h('span', { className: 'cb-name' }, t('accounts')),
            h('span', { className: 'cb-badge' + (rows.length ? ' cb-badge-on' : '') }, rows.length ? rows.length : t('noAccount'))),
          rows.length ? h('div', { style: { marginTop: 8 } }, rows.map((a) => h('div', {
            key: a.id, className: 'cb-row', style: { marginTop: 6 },
          },
            h('span', { className: 'cb-meta', style: { fontSize: 12, opacity: 1 } }, a.nickname || a.id),
            h('span', { className: 'cb-badge' + (a.enabled ? ' cb-badge-on' : '') }, a.enabled ? t('enabled') : t('disabled')),
            h('span', { className: 'cb-meta' }, a.refreshable ? t('refreshable') : t('noRefresh')),
            h('span', { className: 'cb-meta' }, a.expiresAt ? t('expires') + ' ' + fmtTime(a.expiresAt) : t('noExpiry')),
            h('button', {
              className: 'cb-btn', disabled: !!busy,
              onClick: () => act(a.id, 'setEnabled', { enabled: !a.enabled }),
            }, a.enabled ? t('disable') : t('enable')),
            h('button', {
              className: 'cb-btn', disabled: !!busy,
              onClick: () => act(a.id, 'delete'),
            }, t('del'))))) : h('div', { className: 'cb-note' }, t('noAccount')),
          h('div', { className: 'cb-actions' },
            h('button', {
              className: 'cb-btn cb-btn-primary', disabled: !!busy, onClick: () => startLogin('buddy'),
            }, busy === 'login' ? t('waiting') : t('add')),
            h('button', {
              className: 'cb-btn', disabled: !!busy, onClick: () => startLogin('workbuddy'),
            }, t('addWork')))),

        // 版本与更新
        h('div', { className: 'cb-card' },
          h('div', { className: 'cb-row' },
            h('span', { className: 'cb-name' }, t('version')),
            h('span', { className: 'cb-meta' }, ver && ver.version ? ver.version : '—'),
            update && update.ok
              ? h('span', { className: 'cb-badge' + (update.available ? '' : ' cb-badge-on') },
                update.available ? t('updateAvailable') + ' ' + update.remoteVersion : t('upToDate'))
              : null),
          h('div', { className: 'cb-actions' },
            h('button', { className: 'cb-btn', disabled: !!busy || updating, onClick: checkUpdate }, t('checkUpdate')),
            update && update.available
              ? h('button', { className: 'cb-btn cb-btn-primary', disabled: updating, onClick: applyUpdate },
                updating ? t('updating') : t('update'))
              : null)),
        h('div', { className: 'cb-note' }, t('reloadHint')))
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
