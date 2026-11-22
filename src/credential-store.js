/**
 * 插件自带的凭据存储。
 *
 * 为什么需要它：插件原先只把 token 写进 DSH 的 credentials 服务。可是
 * **不是每个 DSH 组合都有这个服务**——对方的机器上就没有，于是登录走完
 * 浏览器授权后，卡在「当前组合没有 credentials 服务，无法保存凭据」，
 * 账号永远进不了列表。
 *
 * 这个模块把凭据落在插件自己的目录里：`$DSH_HOME/dsh-codebuddy/credentials.json`
 * 文件权限 0600。DSH 自己也是文件存储（`.credentials.yaml`），安全等级一致。
 *
 * 读取顺序由 index.js 决定：先本文件，再回落到 DSH 服务（兼容老用户：
 * 他们早先的凭据只在服务里）。写入则两边都写，任何一边缺失都不影响使用。
 *
 * 读失败一律当"没有"，不抛错——凭据坏了应该表现为"请重新登录"，
 * 而不是让整个设置页崩掉。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'credentials.json'

function storeFile(home) {
  return path.join(path.join(home, 'dsh-codebuddy'), FILE_NAME)
}

function readAll(home) {
  if (!home) return {}
  try {
    const doc = JSON.parse(fs.readFileSync(storeFile(home), 'utf8'))
    const map = doc && typeof doc === 'object' && doc.credentials && typeof doc.credentials === 'object'
      ? doc.credentials
      : {}
    // 只认字符串值，其它形状当脏数据丢掉
    const out = {}
    for (const [k, v] of Object.entries(map)) if (typeof v === 'string' && v) out[k] = v
    return out
  } catch {
    return {}
  }
}

function writeAll(home, map) {
  const dir = path.join(home, 'dsh-codebuddy')
  fs.mkdirSync(dir, { recursive: true })
  const file = storeFile(home)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'dsh-codebuddy/credentials/v1', credentials: map }, null, 2), 'utf8')
  // 先收紧权限再落位，避免短暂出现可读窗口
  try { fs.chmodSync(tmp, 0o600) } catch { /* Windows 上无效，忽略 */ }
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* 同上 */ }
}

/** 取一条凭据的原文（JSON 字符串）。没有则 null。 */
export function readLocalCredential(home, ref) {
  if (!home || !ref) return null
  const map = readAll(home)
  return typeof map[ref] === 'string' ? map[ref] : null
}

/** 这条 ref 在本地库里是否存在。 */
export function hasLocalCredential(home, ref) {
  return readLocalCredential(home, ref) !== null
}

/** 写入（同 ref 覆盖）。写失败抛错——保存凭据失败必须让用户知道。 */
export function writeLocalCredential(home, ref, value) {
  if (!home) throw new Error('无法确定 DSH 主目录')
  if (!ref) throw new Error('缺少凭据引用名')
  if (typeof value !== 'string' || !value) throw new Error('凭据内容为空')
  const map = readAll(home)
  map[ref] = value
  writeAll(home, map)
}

/** 删除。不存在时静默成功。 */
export function deleteLocalCredential(home, ref) {
  if (!home || !ref) return
  const map = readAll(home)
  if (!(ref in map)) return
  delete map[ref]
  try { writeAll(home, map) } catch { /* 删除失败不阻塞调用方 */ }
}

/** 列出本地库里有哪些 ref（不含内容，供自检/排查用）。 */
export function listLocalCredentialRefs(home) {
  return Object.keys(readAll(home)).sort()
}
