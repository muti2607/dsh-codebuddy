/**
 * 小块结果的落盘快照（模型目录 / 积分概览）。
 *
 * 为什么需要它：进程内的 Map 缓存只能救「同一次运行里的第二次打开」。
 * DSH 一重启、或者换一台电脑全新装，内存全空，第一次打开设置区仍然要
 * 干等远端——模型目录 2.5s，积分 4s（上游被墙时是干等满超时）。用户说的
 * 「加载太慢」几乎都是这一种，因为人一天只重启一次，每次都正好撞上冷启动。
 *
 * 因此把上一次成功的值写进 `$DSH_HOME/dsh-codebuddy/*.snapshot.json`：
 * 新进程启动后第一次打开立刻有旧值可渲染，同时后台刷新。
 *
 * 三条硬约束：
 *   1. **只存展示用的只读数据**，绝不存凭据、token、refresh_token。
 *   2. 读失败/损坏一律当作「没有快照」，绝不因为一个缓存文件让功能不可用。
 *   3. 写失败静默忽略（只读盘、权限问题都不该影响主流程）。
 *
 * 积分快照还必须**按账号隔离**：把 A 账号的余额显示给 B 账号，
 * 比转圈更糟。所以 key 由调用方强制带上 accountId。
 */
import fs from 'node:fs'
import path from 'node:path'

const SCHEMA = 'dsh-codebuddy/snapshot/v1'

function snapshotDir(home) {
  return path.join(String(home || ''), 'dsh-codebuddy')
}

function snapshotPath(home, name) {
  // name 只允许字母/数字/连字符，避免路径穿越
  const safe = String(name || '').replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) return null
  return path.join(snapshotDir(home), `${safe}.snapshot.json`)
}

/**
 * 读快照。
 *
 * @returns {{ at: number, value: unknown } | null} 没有/损坏/超龄都返回 null
 */
export function readSnapshot(home, name, maxAgeMs = Number.POSITIVE_INFINITY) {
  const file = snapshotPath(home, name)
  if (!file) return null
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!doc || doc.schema !== SCHEMA) return null
    const at = Number(doc.at)
    if (!Number.isFinite(at) || at <= 0) return null
    if (maxAgeMs !== Number.POSITIVE_INFINITY && Date.now() - at > maxAgeMs) return null
    if (doc.value === undefined || doc.value === null) return null
    return { at, value: doc.value }
  } catch {
    return null
  }
}

/** 原子写快照；任何失败都吞掉（缓存不该影响主流程）。 */
export function writeSnapshot(home, name, value) {
  const file = snapshotPath(home, name)
  if (!file || value === undefined || value === null) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, at: Date.now(), value }), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** 删快照（例如账号被移除、主动要求重查）。 */
export function dropSnapshot(home, name) {
  const file = snapshotPath(home, name)
  if (!file) return false
  try { fs.unlinkSync(file); return true } catch { return false }
}
