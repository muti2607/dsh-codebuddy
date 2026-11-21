/**
 * 模型启用/停用偏好。
 *
 * 存在 `$DSH_HOME/dsh-codebuddy/models.json`，只记「被停用的模型 id」：
 *
 *   { "schema": "dsh-codebuddy/models/v1", "disabled": ["hy4flash-free", "space-bunny"] }
 *
 * 为什么记「停用」而不是「启用」：新模型会随时出现在腾讯的目录里，
 * 记启用清单的话每来一个新模型都得手工打开；记停用清单则是「默认全开、
 * 你手动关掉的才关」，新增模型自动可用——这才是用户预期的行为。
 *
 * 文件读失败（不存在/损坏）一律当作「什么都没停用」，绝不因为一个偏好文件
 * 让整个模型列表消失。
 */
import fs from 'node:fs'
import path from 'node:path'

export const MODEL_PREFS_SCHEMA = 'dsh-codebuddy/models/v1'

function prefsPath(home) {
  return path.join(String(home || ''), 'dsh-codebuddy', 'models.json')
}

/** 读偏好；任何异常都退化成空清单。 */
export function readModelPrefs(home) {
  const fallback = { schema: MODEL_PREFS_SCHEMA, disabled: [] }
  try {
    const raw = fs.readFileSync(prefsPath(home), 'utf8')
    const doc = JSON.parse(raw)
    const list = Array.isArray(doc && doc.disabled) ? doc.disabled : []
    // 去重、丢空串，保证后续 Set 行为可预测
    const seen = new Set()
    const disabled = []
    for (const id of list) {
      const v = String(id == null ? '' : id).trim()
      if (!v || seen.has(v)) continue
      seen.add(v)
      disabled.push(v)
    }
    return { schema: MODEL_PREFS_SCHEMA, disabled }
  } catch {
    return fallback
  }
}

/** 原子写：先写临时文件再 rename，避免半截 JSON。 */
export function writeModelPrefs(home, prefs) {
  const file = prefsPath(home)
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const doc = {
    schema: MODEL_PREFS_SCHEMA,
    disabled: Array.isArray(prefs && prefs.disabled) ? prefs.disabled : [],
  }
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return doc
}

export function isModelDisabled(prefs, modelId) {
  const id = String(modelId == null ? '' : modelId)
  return Array.isArray(prefs && prefs.disabled) && prefs.disabled.includes(id)
}

/**
 * 改单个模型的开关。
 *
 * @returns {{ disabled: string[], changed: boolean }}
 */
export function setModelEnabled(home, modelId, enabled) {
  const id = String(modelId == null ? '' : modelId).trim()
  if (!id) return { disabled: readModelPrefs(home).disabled, changed: false }
  const prefs = readModelPrefs(home)
  const set = new Set(prefs.disabled)
  const had = set.has(id)
  if (enabled) set.delete(id)
  else set.add(id)
  const changed = had === enabled
  if (!changed) return { disabled: prefs.disabled, changed: false }
  const written = writeModelPrefs(home, { disabled: [...set] })
  return { disabled: written.disabled, changed: true }
}

/** 全部启用：直接清空停用清单。 */
export function enableAllModels(home) {
  const written = writeModelPrefs(home, { disabled: [] })
  return { disabled: written.disabled, changed: true }
}

/**
 * 按偏好过滤模型列表，并给每项补 `enabled` 标记。
 *
 * 停用清单里那些「目录里已经不存在」的 id 会被顺手丢掉（保留它们没有意义，
 * 还会让「停用 N 个」的计数虚高）。
 */
export function applyModelPrefs(models, prefs) {
  const disabled = new Set((prefs && prefs.disabled) || [])
  const list = Array.isArray(models) ? models : []
  const present = new Set(list.map((m) => String(m && m.id)))
  const stale = [...disabled].filter((id) => !present.has(id))
  return {
    models: list.map((m) => ({ ...m, enabled: !disabled.has(String(m.id)) })),
    stale,
  }
}
