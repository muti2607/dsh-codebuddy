/**
 * 自更新链路测试：applyUpdate 撞 already-installed 必须「移除后重装」，
 * 而不是空转返回失败（这正是自动更新在别人电脑上不生效的根因）。
 * 全程离线：假 ctx + 假 pluginManager + 临时 profile 目录，不联网。
 * Run: node test/verify-update.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1 }

/** 造一个 profile 目录，依赖里写 github:（这样 inspectInstallSource=git、updatable） */
function makeProfile(spec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prof-'))
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-codebuddy': spec } }))
  return dir
}

/** 假 pluginManager：可编排 installBundle 的返回序列，记录调用 */
function fakeManager(script) {
  const calls = []
  let step = 0
  return {
    calls,
    async installBundle(spec, opts) {
      calls.push({ op: 'install', spec, opts })
      const r = script[Math.min(step, script.length - 1)]
      step++
      // 脚本项可以是函数（模拟 throw）、Promise 或普通返回对象
      if (typeof r === 'function') return await r()
      if (r && typeof r.then === 'function') return await r
      return r
    },
    async removeBundle(name) {
      calls.push({ op: 'remove', name })
      return { changed: true, application: 'applied' }
    },
  }
}

/** 用给定 profile spec 与 manager 脚本跑一次 POST /api/codebuddy/update，返回 { result, calls } */
async function runUpdate(spec, script) {
  const prev = process.env.DSH_PROFILE_DIR
  if (spec === null) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = spec
  let dir = spec
  if (spec === null) dir = makeProfile('github:muti2607/dsh-codebuddy')
  try {
    const manager = fakeManager(script)
    let route = null
    const fake = {
      logger: { info: () => {}, warn: () => {} },
      pluginManager: manager,
      get(name) { return name === 'pluginManager' ? manager : fake[name] },
      llm: { registerAdapter() { return { dispose() {} } }, registerConfigurableProviders() {} },
      credentials: { async resolve() { return null }, async set() {} },
      attachments: { async readImageRequest() { throw new Error('no image') } },
      webServer: { register(r) { route = r; return () => {} } },
      inject(deps, cb) { cb(fake); return () => {} },
    }
    apply(fake, {})
    const call = async (method, url) => {
      let status = 0, out = ''
      await route.handler({ method, url }, { writeHead(c) { status = c }, end(t) { out = String(t) } })
      return { status, body: JSON.parse(out) }
    }
    const res = await call('POST', '/api/codebuddy/update')
    return { result: res.body, calls: manager.calls, status: res.status }
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

// ---- 1. already-installed：必须移除后重装，最终成功 ----
{
  const d2 = makeProfile('github:muti2607/dsh-codebuddy')
  const r = await runUpdate(d2, [
    { application: 'failed', error: { code: 'already-installed' } }, // 第一次：已装，冲突
    { application: 'applied', version: '1.2.8' },                    // 移除后第二次：成功
  ])
  fs.rmSync(d2, { recursive: true, force: true })
  if (r.result.ok !== true) fail('already-installed 应通过移除重装成功，实际: ' + JSON.stringify(r.result))
  if (r.result.removed !== true) fail('应标记 removed=true，实际: ' + JSON.stringify(r.result))
  const ops = r.calls.map((c) => c.op)
  if (JSON.stringify(ops) !== JSON.stringify(['install', 'remove', 'install'])) {
    fail('调用顺序应为 install→remove→install，实际: ' + JSON.stringify(ops))
  }
  if (r.calls[1].name !== 'dsh-codebuddy') fail('removeBundle 应传包名 dsh-codebuddy，实际: ' + r.calls[1].name)
}

// ---- 2. 直接成功（未冲突）：不应触发移除 ----
{
  const dir = makeProfile('github:muti2607/dsh-codebuddy')
  const r = await runUpdate(dir, [
    { application: 'applied', version: '1.2.8' },
  ])
  fs.rmSync(dir, { recursive: true, force: true })
  if (r.result.ok !== true) fail('未冲突应直接成功，实际: ' + JSON.stringify(r.result))
  if (r.result.removed !== false) fail('未冲突不该移除，removed 应为 false')
  if (r.calls.map((c) => c.op).join(',') !== 'install') fail('应只 install 一次，实际: ' + JSON.stringify(r.calls.map((c) => c.op)))
}

// ---- 3. 移除后重装仍失败：报可执行信息，且明确已移除 ----
{
  const dir = makeProfile('github:muti2607/dsh-codebuddy')
  const r = await runUpdate(dir, [
    { application: 'failed', error: { code: 'already-installed' } },
    async () => { throw new Error('network down') }, // 重装抛错
  ])
  fs.rmSync(dir, { recursive: true, force: true })
  if (r.result.ok === true) fail('重装失败不应报成功')
  if (r.result.removed !== true) fail('应明确 removed=true，让用户知道旧版已移除')
  if (!/重装失败|network down/.test(r.result.error || '')) fail('应说明重装失败并保留网络原因，实际: ' + JSON.stringify(r.result))
}

// ---- 4. 本地 link: 安装：拒绝更新，不动 manager ----
{
  const dir = makeProfile('link:D:/somewhere')
  const r = await runUpdate(dir, [{ application: 'applied' }])
  fs.rmSync(dir, { recursive: true, force: true })
  if (r.result.ok === true) fail('link: 安装不该允许自更新')
  if (r.calls.length !== 0) fail('link: 不该调用 manager，实际: ' + JSON.stringify(r.calls.map((c) => c.op)))
  if (!/本地|link|github:/.test(r.result.error || '')) fail('应说明本地安装需改用 github: 安装，实际: ' + JSON.stringify(r.result))
}

// ---- 5. 无 pluginManager：报可执行提示 ----
{
  const dir = makeProfile('github:muti2607/dsh-codebuddy')
  let route = null
  const fake = {
    logger: { info: () => {}, warn: () => {} },
    get() { return undefined },
    llm: { registerAdapter() { return { dispose() {} } }, registerConfigurableProviders() {} },
    credentials: { async resolve() { return null } },
    attachments: { async readImageRequest() { throw new Error('x') } },
    webServer: { register(r) { route = r; return () => {} } },
    inject(d, cb) { cb(fake); return () => {} },
  }
  process.env.DSH_PROFILE_DIR = dir
  try {
    apply(fake, {})
    let out = ''
    await route.handler({ method: 'POST', url: '/api/codebuddy/update' }, { writeHead() {}, end(t) { out = String(t) } })
    const body = JSON.parse(out)
    if (body.ok !== false) fail('无 pluginManager 应报失败')
    if (!/pluginManager|手动|dsh plugin/.test(body.error || '')) fail('应给手动命令提示，实际: ' + JSON.stringify(body))
  } finally {
    delete process.env.DSH_PROFILE_DIR
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
