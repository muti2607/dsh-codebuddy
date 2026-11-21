// Client 视觉与结构检查：令牌合规、无写死颜色、关键交互存在。
import fs from 'node:fs'
const src = fs.readFileSync('client.js', 'utf8')
const css = (src.match(/const CSS = `([\s\S]*?)`\n/) || [])[1] || ''
const checks = {
  'CSS 已定义': css.length > 2000,
  '使用主题令牌': (css.match(/var\(--dsw-alias-/g) || []).length > 30,
  // 允许的写死色仅限「令牌兜底」与「渐变明暗混合」：#f0a441 是 warning 令牌的
  // fallback（与 OFM 一致），#fff/#000 只用于 color-mix 的提亮/压暗。
  '无写死配色（仅允许兜底/明暗混合）': (() => {
    const stripped = css
      .replace(/#fff|#000/gi, '')
      .replace(/var\(--dsw-alias-state-warning-primary,#f0a441\)/g, '')
    return !/#[0-9a-fA-F]{3,6}\b/.test(stripped)
  })(),
  '有 hero 页头': css.includes('.cb_hero'),
  '有渐变标题': css.includes('-webkit-background-clip:text'),
  '卡片双层 bezel': css.includes('inset 0 1px 0 rgb(255 255 255'),
  'hover 抬升': css.includes('transform:translateY(-2px)'),
  '按钮 primary 变体': css.includes('.cb_btn.primary'),
  '按钮 ghost 变体': css.includes('.cb_btn.ghost'),
  'mini 按钮含 danger': css.includes('.cb_mini.danger'),
  '状态点 ok/warn/err/busy': ['.cb_dot.ok', '.cb_dot.warn', '.cb_dot.err', '.cb_dot.busy'].every((s) => css.includes(s)),
  '聚焦可见环': css.includes(':focus-visible'),
  '动效时长克制': /transition:[^;]*\.(1[0-9]|2[0-9]|3[0-9])s/.test(css),
  '消息条 err/ok': css.includes('.cb_msg.err') && css.includes('.cb_msg.ok'),
  '空态样式': css.includes('.cb_empty'),
  'JS 结构：hero/账号/插件三节': src.includes("cb_hero") && src.includes("secAccounts") && src.includes("secSystem"),
  '登录等待用 busy 点': src.includes("cb_dot busy"),
  '失败态有重试': src.includes("t('retry')"),
  '账号卡含停用与删除': src.includes("'setEnabled'") && src.includes("'delete'"),
  // ── 积分 ──
  '积分大数字样式': css.includes('.cb_creditval'),
  '积分数字用渐变文字': /\.cb_creditval\{[^}]*background-clip:text/.test(css),
  '积分行样式': css.includes('.cb_creditrow'),
  '签到周格样式': css.includes('.cb_day') && css.includes('.cb_day.on'),
  '加载骨架': css.includes('.cb_skeleton') && css.includes('@keyframes cb-shimmer'),
  'JS 有积分分节': src.includes("secCredits"),
  'JS 有剩余积分标签': src.includes("creditsLeft"),
  'JS 有领取按钮': src.includes("t('claim')"),
  '不可领取时按钮禁用': /disabled:[^,}]*!claimable/.test(src),
  '签到状态用状态点': /checkedInToday \? ' ok' : ''/.test(src),
  // 优先级坑：.cb_card.panel 的 flex-direction:column 会压过单类选择器，
  // 卡片被排成纵向、内容全挤到右半边（左侧全空）。必须三段选择器 + 显式 row。
  '积分卡是横向两栏（权重压过 .cb_card.panel）': /\.cb_card\.panel\.cb_credits\{[^}]*flex-direction:row/.test(css),
  '积分卡左右分开': /\.cb_card\.panel\.cb_credits\{[^}]*justify-content:space-between/.test(css),
  '左侧主体块有样式': css.includes('.cb_creditmain') && css.includes('.cb_creditlabel'),
  '右侧状态块有样式': css.includes('.cb_creditside') && css.includes('.cb_creditstatus'),
  '操作区不再用 margin-left:auto 硬推': !/\.cb_creditactions\{[^}]*margin-left:auto/.test(css),
  'JS 有左侧主体与右侧状态两块': src.includes('cb_creditmain') && src.includes('cb_creditside'),
  // 三态：活动未开通 ≠ 今天没签。混为一谈会让人以为按钮坏了。
  '有「无签到活动」文案': src.includes('checkinNoActivity'),
  '有「可领取」文案': src.includes('checkinAvailable'),
  '账号行按 active 分三态': /!r\.checkin\.active[\s\S]{0,220}checkinNoActivity/.test(src),
  '不可领取时说明原因': src.includes('claimHint') && css.includes('.cb_creditreason'),
  '区分「没活动」与「已领完」': src.includes('claimHintNoActivity') && src.includes('claimHintAllDone'),
}
let bad = 0
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'OK   ' : 'FAIL ') + k)
  if (!v) bad += 1
}
console.log(bad === 0 ? '\n视觉与结构检查全部通过' : `\n${bad} 项未通过`)
process.exit(bad ? 1 : 0)
