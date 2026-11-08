// 确认 codebuddy 适配器以 codebuddy + buddy 两个名字注册
import { apply } from '../index.js'
let reg = null
const fake = {
  logger: { info: () => {}, warn: () => {} },
  llm: {
    registerAdapter(providers, adapter) { reg = { providers, adapter }; return { dispose() {} } },
    registerConfigurableProviders() {},
  },
  credentials: { async resolve() { return null }, async set() {} },
  attachments: { async readImageRequest() { throw new Error('no image') } },
  inject(d, cb) { cb(fake); return () => {} },
  get(n) { return fake[n] },
}
apply(fake, { dshHome: 'D:/__none__' })
console.log('注册的 provider:', JSON.stringify(reg && reg.providers))
const models = await reg.adapter.listModels('buddy')
console.log('buddy 下模型数:', models.length, '示例:', models.slice(0, 3).map((m) => m.provider + '/' + m.id).join(', '))
const one = models.find((m) => m.id === 'glm-5.3')
console.log('buddy/glm-5.3 是否存在:', !!one)
