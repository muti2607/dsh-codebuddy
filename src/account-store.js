/**
 * 插件自己的账号池，不依赖任何外部插件（OFM / channel-pack）。
 *
 * 存放位置：`$DSH_HOME/dsh-codebuddy/accounts.json`
 * 凭据本体走 DSH 自己的 credentials 服务（`.credentials.yaml`），
 * 这里只存索引：ref 名、昵称、过期时间、是否可续期。
 *
 * 写入用 tmp + rename，避免半写状态；读失败当作空池，不抛。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const FILE_NAME = 'accounts.json'

function storeDir(home) {
  return path.join(home, 'dsh-codebuddy')
}

/** 新账号的 ref 名：`<PROV>_ACCOUNT_<6+位 HEX 大写>`，与 DSH 生态惯例一致。 */
export function newCredentialRef(provider) {
  const prefix = String(provider || 'buddy').toUpperCase()
  return `${prefix}_ACCOUNT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`
}

export function newAccountId(provider) {
  return `${String(provider || 'buddy')}-${crypto.randomBytes(3).toString('hex')}`
}

export function readAccounts(home) {
  if (!home) return []
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(storeDir(home), FILE_NAME), 'utf8'))
    const list = Array.isArray(doc?.accounts) ? doc.accounts : []
    return list.filter((a) => a && typeof a.credentialRef === 'string' && a.credentialRef)
  } catch {
    return []
  }
}

function writeAccounts(home, accounts) {
  const dir = storeDir(home)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, FILE_NAME)
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify({ schema: 'dsh-codebuddy/accounts/v1', accounts }, null, 2), 'utf8')
  fs.renameSync(tmp, file)
}

/** 加一个账号（同 ref 覆盖），返回完整条目。 */
export function addAccount(home, entry) {
  const accounts = readAccounts(home)
  const now = Date.now()
  const record = {
    id: entry.id || newAccountId(entry.provider),
    provider: entry.provider || 'buddy',
    nickname: String(entry.nickname || ''),
    credentialRef: entry.credentialRef,
    enabled: entry.enabled !== false,
    refreshable: entry.refreshable !== false,
    createdAt: entry.createdAt || now,
    updatedAt: now,
    ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
  }
  const i = accounts.findIndex((a) => a.credentialRef === record.credentialRef || a.id === record.id)
  if (i >= 0) accounts[i] = { ...accounts[i], ...record }
  else accounts.push(record)
  writeAccounts(home, accounts)
  return record
}

/** 局部更新（昵称/过期/enabled/refreshable），不覆盖未传字段。 */
export function updateAccount(home, id, patch) {
  const accounts = readAccounts(home)
  const i = accounts.findIndex((a) => a.id === id)
  if (i < 0) return null
  accounts[i] = { ...accounts[i], ...patch, id: accounts[i].id, updatedAt: Date.now() }
  writeAccounts(home, accounts)
  return accounts[i]
}

export function removeAccount(home, id) {
  const accounts = readAccounts(home)
  const kept = accounts.filter((a) => a.id !== id)
  if (kept.length === accounts.length) return null
  writeAccounts(home, kept)
  return accounts.find((a) => a.id === id) || null
}

/** 启用且未过期的账号，按数组顺序（顺序即优先级）。 */
export function availableAccounts(home, provider) {
  const now = Date.now()
  return readAccounts(home)
    .filter((a) => a.enabled !== false)
    .filter((a) => !provider || a.provider === provider)
    .filter((a) => !a.expiresAt || a.expiresAt > now)
}
