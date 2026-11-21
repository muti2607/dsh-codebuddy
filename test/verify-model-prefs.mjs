/**
 * 模型启用/停用偏好（src/model-prefs.js）单元测试。
 *
 * 重点不是「能读写」，而是几条容易写错的不变量：
 *   · 只记「停用」清单 → 新模型默认可用
 *   · 文件缺失/损坏 → 退化成「什么都没停用」，绝不让模型列表整体消失
 *   · 重复 id 要去重、空串要丢掉
 *   · 写入必须是原子的（不能留下半截 JSON）
 *   · 停用清单里「目录中已不存在」的 id 要能识别出来（清理用）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readModelPrefs,
  writeModelPrefs,
  setModelEnabled,
  enableAllModels,
  isModelDisabled,
  applyModelPrefs,
  MODEL_PREFS_SCHEMA,
} from '../src/model-prefs.js'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok })
  console.log((ok ? 'OK   ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''))
}

const homes = []
const makeHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prefs-'))
  homes.push(dir)
  return dir
}
const fileOf = (home) => path.join(home, 'dsh-codebuddy', 'models.json')

// ── 1. 默认：没有任何文件 → 空清单 ──
{
  const home = makeHome()
  const prefs = readModelPrefs(home)
  check('缺文件时 disabled 为空', Array.isArray(prefs.disabled) && prefs.disabled.length === 0)
  check('缺文件时 schema 正确', prefs.schema === MODEL_PREFS_SCHEMA)
}

// ── 2. 写读往返 ──
{
  const home = makeHome()
  writeModelPrefs(home, { disabled: ['a', 'b'] })
  const prefs = readModelPrefs(home)
  check('往返后内容一致', JSON.stringify(prefs.disabled) === JSON.stringify(['a', 'b']), prefs.disabled)
  check('文件是合法 JSON', (() => {
    try { JSON.parse(fs.readFileSync(fileOf(home), 'utf8')); return true } catch { return false }
  })())
  check('写入不带 BOM', (() => {
    const buf = fs.readFileSync(fileOf(home))
    return !(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
  })())
  check('目录被自动创建', fs.existsSync(path.join(home, 'dsh-codebuddy')))
}

// ── 3. 损坏文件 → 退化成空 ──
{
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'dsh-codebuddy'), { recursive: true })
  fs.writeFileSync(fileOf(home), '{ not json', 'utf8')
  const prefs = readModelPrefs(home)
  check('损坏文件退化为空清单', prefs.disabled.length === 0, prefs.disabled)
}

// ── 4. 结构不对（disabled 不是数组）→ 空 ──
{
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'dsh-codebuddy'), { recursive: true })
  fs.writeFileSync(fileOf(home), JSON.stringify({ disabled: 'oops' }), 'utf8')
  check('disabled 非数组时退化为空', readModelPrefs(home).disabled.length === 0)
}

// ── 5. 去重与去空串 ──
{
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'dsh-codebuddy'), { recursive: true })
  fs.writeFileSync(fileOf(home), JSON.stringify({ disabled: ['x', 'x', '', '  ', 'y'] }), 'utf8')
  const prefs = readModelPrefs(home)
  check('重复与空串被清掉', JSON.stringify(prefs.disabled) === JSON.stringify(['x', 'y']), prefs.disabled)
}

// ── 6. 单模型开关 ──
{
  const home = makeHome()
  let r = setModelEnabled(home, 'hy4flash-free', false)
  check('停用后 changed=true', r.changed === true)
  check('停用后清单含该 id', r.disabled.includes('hy4flash-free'), r.disabled)
  check('isModelDisabled 认得', isModelDisabled(readModelPrefs(home), 'hy4flash-free'))

  r = setModelEnabled(home, 'hy4flash-free', false)
  check('重复停用 changed=false（幂等）', r.changed === false)
  check('重复停用不产生重复项', r.disabled.filter((x) => x === 'hy4flash-free').length === 1, r.disabled)

  r = setModelEnabled(home, 'hy4flash-free', true)
  check('启用后从清单移除', !r.disabled.includes('hy4flash-free'), r.disabled)
  check('启用后 changed=true', r.changed === true)

  r = setModelEnabled(home, '', false)
  check('空 id 被忽略', r.changed === false)
}

// ── 7. 全部启用 ──
{
  const home = makeHome()
  setModelEnabled(home, 'a', false)
  setModelEnabled(home, 'b', false)
  check('先确认已停用 2 个', readModelPrefs(home).disabled.length === 2)
  enableAllModels(home)
  check('全部启用后清单清空', readModelPrefs(home).disabled.length === 0)
}

// ── 8. applyModelPrefs：打标记、保序、识别失效 id ──
{
  const catalogue = [
    { id: 'auto', name: 'Auto' },
    { id: 'hy4flash', name: 'Hy4 flash' },
    { id: 'hy4flash-free', name: 'Hy4 flash (free)' },
  ]
  const prefs = { disabled: ['hy4flash-free', 'ghost-model'] }
  const { models, stale } = applyModelPrefs(catalogue, prefs)
  check('顺序不变', models.map((m) => m.id).join(',') === 'auto,hy4flash,hy4flash-free', models.map((m) => m.id).join(','))
  check('未停用的保持 enabled', models[0].enabled === true && models[1].enabled === true)
  check('停用的标记 enabled=false', models[2].enabled === false)
  check('名字原样保留', models[2].name === 'Hy4 flash (free)', models[2].name)
  check('识别出目录里不存在的 id', JSON.stringify(stale) === JSON.stringify(['ghost-model']), stale)
}

// ── 9. 新模型默认可用（这是「只记停用」的核心收益）──
{
  const prefs = { disabled: ['old-model'] }
  const { models } = applyModelPrefs([{ id: 'brand-new', name: 'Brand New' }], prefs)
  check('新出现的模型默认启用', models[0].enabled === true)
}

// ── 10. 原子写：不留下临时文件 ──
{
  const home = makeHome()
  writeModelPrefs(home, { disabled: ['a'] })
  writeModelPrefs(home, { disabled: ['b'] })
  const leftovers = fs.readdirSync(path.join(home, 'dsh-codebuddy')).filter((f) => f.includes('.tmp-'))
  check('没有遗留 .tmp 文件', leftovers.length === 0, leftovers.join(','))
}

for (const dir of homes) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const bad = results.filter((r) => !r.ok).length
console.log(bad === 0 ? `\n模型偏好 ${results.length} 项全部通过` : `\n${bad}/${results.length} 项未通过`)
process.exit(bad ? 1 : 0)
