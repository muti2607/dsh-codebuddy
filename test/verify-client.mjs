// Client half 静态检查：模块格式、注册点、路由分组、无令牌持久化。
import fs from 'node:fs'
const src = fs.readFileSync('client.js', 'utf8')
const checks = {
  'window.__ModuleLoader__.load': src.includes('window.__ModuleLoader__.load('),
  "模块 id = dsh-codebuddy": /id:\s*'dsh-codebuddy'/.test(src),
  'inject 含 slots 与 locale': /inject:\s*\[[^\]]*'slots'[^\]]*'locale'/.test(src),
  '注册 settings.section': src.includes("ctx.slots.inject('settings.section'"),
  '注册 locale': src.includes('ctx.locale.register(NS, DICT)'),
  '起登录 /login?provider=': src.includes('/login?provider='),
  '轮询 /login?accountId=': src.includes('/login?accountId='),
  '账号接口 /accounts': src.includes("'/accounts'"),
  '更新走 apiMain/update': src.includes("apiMain('/update"),
  '版本走 apiMain/version': src.includes("apiMain('/version'"),
  '拼接错误路径不存在': !src.includes('/api/cb/codebuddy'),
  '不落盘令牌': !/localStorage|sessionStorage/.test(src),
  '提供停用与删除': src.includes("'setEnabled'") && src.includes("'delete'"),
  '有等待授权文案': src.includes('waiting'),
  '清理轮询定时器': src.includes('clearInterval'),
  // ── 积分 ──
  '积分查询走 /credits': src.includes("api('/credits'"),
  '领取走 /credits/claim': src.includes("api('/credits/claim'"),
  '领取后重查余额': /claimCredits[\s\S]{0,900}loadCredits\(\)/.test(src),
  '不落盘积分': !/localStorage/.test(src),
  // ── 自更新 ──
  '只有可更新时才给「立即更新」按钮': /update && update\.available && update\.updatable\s*\?/.test(src),
  '本地安装时给出重装说明': src.includes('updateLocalHint'),
  '重装说明含官方命令': src.includes('dsh plugin --profile desktop add github:'),
}
let bad = 0
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'OK   ' : 'FAIL ') + k)
  if (!v) bad += 1
}
console.log(bad === 0 ? '\nclient.js 静态检查全部通过' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
