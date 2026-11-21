// 真实连通性验证：只调 auth/state（无需用户交互），确认协议端点/头部/字段解析都对得上真服务器。
// 绝不打印令牌；只报状态与字段是否存在。
import { PRODUCTS, beginBuddyLogin } from '../src/buddy-login.js'

for (const key of ['buddy', 'workbuddy']) {
  const p = PRODUCTS[key]
  try {
    const begun = await beginBuddyLogin({ product: p })
    console.log(`[${key}] auth/state OK`)
    console.log(`   state 长度: ${begun.state.length}`)
    const u = new URL(begun.loginUrl)
    console.log(`   登录页主机: ${u.host}`)
    console.log(`   查询参数键: ${[...u.searchParams.keys()].sort().join(', ')}`)
    console.log(`   带 version=${u.searchParams.get('version') || '(无)'}  带 loginSessionId=${u.searchParams.has('loginSessionId')}`)
  } catch (e) {
    console.log(`[${key}] 失败: ${String(e && e.message || e).slice(0, 160)}`)
  }
}
