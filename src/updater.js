/**
 * 自更新支持。
 *
 * ## 为什么不是「插件自己复制文件」
 *
 * OFM 那种做法（manifest + SHA-256 + 逐文件替换）在这里是不必要的，而且会
 * 引出一个它自己都没绕开的问题：插件绕过 pnpm 直接改磁盘，`pnpm-lock.yaml`
 * 就与实际情况不一致。下次任何安装动作触发 pnpm 按 lockfile 重建时，包会被
 * 「恢复」成 lockfile 里那个版本 —— OFM 就是这么坏的（2.8.0 → 2.5.6，中间
 * 还丢过 vendor/magpie/bin，整包加载失败）。
 *
 * 本插件改为复用 DSH 官方能力：`pluginManager.installBundle(github:...)`。
 * 它走 pnpm，因此 lockfile 与实际安装始终一致，更新后由 Loader 重新激活，
 * 不需要手写重载逻辑，也不会留下半损坏状态。
 *
 * ## 版本检查
 *
 * 用 GitHub 公开 API 读仓库里 `package.json` 的 `version`，与当前运行版本的
 * `package.json` 比较。不下载整包、不执行远端代码；真正安装只在用户确认后
 * 才发生，并由 pnpm 完成。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 本插件的仓库标识（owner/repo），用于版本检查与更新。 */
export const REPO = 'muti2607/dsh-codebuddy'

/** installBundle 用的规范 spec。 */
export const INSTALL_SPEC = `github:${REPO}`

const API_BASE = 'https://api.github.com'
const CHECK_TIMEOUT_MS = 15_000

/** 解析 `1.2.3` / `1.2.3-rc.4`；非法返回 null。 */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? null : match[4].split('.'),
  }
}

/** semver 优先级比较：返回 -1 / 0 / 1。预发布版本低于同号正式版。 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) {
    return a === b ? 0 : String(a) > String(b) ? 1 : -1
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const len = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1
    if (nx) return -1
    if (ny) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** 读当前安装目录里的版本号；读不到返回 null。 */
export function readLocalVersion(moduleDir) {
  try {
    const raw = fs.readFileSync(path.join(moduleDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 查询远端最新版本。
 *
 * 用 contents API 取 package.json（公开仓库无需令牌）。返回
 * `{ version, publishedAt?, checkedAt }`；网络失败抛出，由调用方转成可见状态，
 * 绝不静默当作「已是最新」。
 */
export async function fetchLatestVersion(fetchImpl = fetch, signal) {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS)
  const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const response = await fetchImpl(`${API_BASE}/repos/${REPO}/contents/package.json`, {
    headers: {
      Accept: 'application/vnd.github.raw+json',
      'User-Agent': 'dsh-codebuddy-updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: merged,
  })
  if (!response.ok) {
    throw new Error(`GitHub API HTTP ${response.status}`)
  }
  const text = await response.text()
  let pkg = null
  try {
    pkg = JSON.parse(text)
  } catch {
    throw new Error('远端 package.json 不是合法 JSON')
  }
  const version = typeof pkg?.version === 'string' ? pkg.version : null
  if (version === null) throw new Error('远端 package.json 缺少 version 字段')
  return { version, checkedAt: Date.now() }
}

/**
 * 计算一次更新检查的结论。
 *
 * @param localVersion 当前版本，未知时传 null
 * @param remoteVersion 远端版本
 * @returns { available, localVersion, remoteVersion, relation: 'newer'|'same'|'older' }
 */
export function evaluateUpdate(localVersion, remoteVersion) {
  if (localVersion === null || localVersion === undefined) {
    // 版本未知（例如 link: 安装没读出版本）时不能断言「可更新」，
    // 但把远端版本报出来让用户自己决定。
    return { available: false, localVersion: null, remoteVersion, relation: 'unknown' }
  }
  const cmp = compareVersions(remoteVersion, localVersion)
  return {
    available: cmp > 0,
    localVersion,
    remoteVersion,
    relation: cmp > 0 ? 'newer' : cmp === 0 ? 'same' : 'older',
  }
}

/**
 * 判断当前安装形态能否自更新。
 *
 * `link:` 本地目录安装的插件没有版本来源，更新应通过重新安装指向的目录完成，
 * 而不是由插件去改写自己所在的源码树 —— 那样会让作者的开发目录与 Git 状态
 * 脱节。这里如实告知，交给调用方提示用户。
 */
export function inspectInstallSource(profileDir) {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw)
    const spec = pkg?.dependencies?.['dsh-codebuddy']
    if (typeof spec !== 'string') return { spec: null, kind: 'absent' }
    if (spec.startsWith('link:') || spec.startsWith('file:')) return { spec, kind: 'local' }
    if (spec.startsWith('github:') || spec.includes('github.com')) return { spec, kind: 'git' }
    return { spec, kind: 'other' }
  } catch {
    return { spec: null, kind: 'unknown' }
  }
}
