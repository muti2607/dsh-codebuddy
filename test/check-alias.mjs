// 确认适配器注册了哪些 provider（主渠道 + 别名）
import { apply } from '../index.js'

const regs = []
const fake = {
  logger: { info: () => {}, warn: console.warn },
  llm: {
    registerAdapter(providers, adapter) { regs.push({ providers, adapter }); return { dispose() {} } },
    registerConfigurableProviders() {},
  },
  credentials: { async resolve() { return null }, async set() {} },
  attachments: { async readImageRequest() { throw new Error('no image') } },
  inject(d, cb) { cb(fake); return () => {} },
  get(n) { return fake[n] },
}
apply(fake, { dshHome: 'D:/__none__' })

const all = regs.flatMap((r) => r.providers)
console.log('注册的 provider:', JSON.stringify(all))
const adapter = regs[0] && regs[0].adapter
const models = await adapter.listModels('codebuddy')
console.log('codebuddy 下模型数:', models.length)
console.log('示例:', models.slice(0, 3).map((m) => m.provider + '/' + m.id).join(', '))
console.log('buddy/glm-5.3 可解析:', !!models.find((m) => m.id === 'glm-5.3'))
