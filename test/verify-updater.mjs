/**
 * src/updater.js 的离线测试：
 *   · semver 比较（含预发布、跨位）
 *   · 版本判定（可更新 / 已最新 / 远端落后 / 版本未知）
 *   · 安装形态识别（link: 不可自更新）
 *   · 远端查询的失败必须抛出，不能被当成「已最新」
 * Run: node test/verify-updater.mjs
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  REPO,
  INSTALL_SPEC,
  compareVersions,
  evaluateUpdate,
  fetchLatestVersion,
  inspectInstallSource,
  parseVersion,
  readLocalVersion,
} from "../src/updater.js"

const fail = (m) => { console.error("FAIL: " + m); process.exitCode = 1 }

// ---- 1. 版本解析 ----
{
  const p = parseVersion("1.2.3")
  if (!p || p.major !== 1 || p.minor !== 2 || p.patch !== 3 || p.pre !== null) fail("parseVersion 1.2.3 不对: " + JSON.stringify(p))
  if (parseVersion("1.2") !== null) fail("1.2 应被判非法")
  if (parseVersion("abc") !== null) fail("abc 应被判非法")
  const pre = parseVersion("1.2.3-rc.4")
  if (!pre || !Array.isArray(pre.pre) || pre.pre.join(".") !== "rc.4") fail("预发布解析不对")
}

// ---- 2. 版本比较 ----
{
  const cases = [
    ["1.0.1", "1.0.0", 1],
    ["1.0.0", "1.0.1", -1],
    ["1.0.0", "1.0.0", 0],
    ["2.0.0", "1.9.9", 1],
    ["1.10.0", "1.9.0", 1],   // 数值比较，不是字典序
    ["1.0.0", "1.0.0-rc.1", 1], // 正式版高于预发布
    ["1.0.0-rc.1", "1.0.0-rc.2", -1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1], // 预发布数字也按数值比
    ["1.0.0-alpha", "1.0.0-beta", -1],
  ]
  for (const [a, b, want] of cases) {
    const got = compareVersions(a, b)
    if (got !== want) fail(`compareVersions(${a}, ${b}) 期望 ${want} 实际 ${got}`)
  }
}

// ---- 3. 更新判定 ----
{
  const up = evaluateUpdate("1.0.0", "1.1.0")
  if (!up.available || up.relation !== "newer") fail("1.0.0 → 1.1.0 应可更新: " + JSON.stringify(up))

  const same = evaluateUpdate("1.1.0", "1.1.0")
  if (same.available || same.relation !== "same") fail("同版本不应提示更新")

  const older = evaluateUpdate("1.2.0", "1.1.0")
  if (older.available || older.relation !== "older") fail("远端更旧不应提示更新")

  // 版本未知时不能谎称可更新
  const unknown = evaluateUpdate(null, "9.9.9")
  if (unknown.available || unknown.relation !== "unknown") fail("版本未知时不应判为可更新")
}

// ---- 4. 读本地版本 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-ver-"))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "2.3.4" }))
  if (readLocalVersion(dir) !== "2.3.4") fail("readLocalVersion 读错")
  fs.rmSync(dir, { recursive: true, force: true })
  if (readLocalVersion("/definitely/not/here") !== null) fail("目录不存在应返回 null")
}

// ---- 5. 安装形态 ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-prof-"))
  const write = (spec) => fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "dsh-codebuddy": spec } }))

  write("link:D:/some/dir")
  let s = inspectInstallSource(dir)
  if (s.kind !== "local") fail("link: 应识别为 local，实际 " + s.kind)

  write(`github:${REPO}`)
  s = inspectInstallSource(dir)
  if (s.kind !== "git") fail("github: 应识别为 git，实际 " + s.kind)

  write("https://github.com/muti2607/dsh-codebuddy.git")
  if (inspectInstallSource(dir).kind !== "git") fail("https URL 应识别为 git")

  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: {} }))
  if (inspectInstallSource(dir).kind !== "absent") fail("无依赖应识别为 absent")

  fs.rmSync(dir, { recursive: true, force: true })
  if (inspectInstallSource("/definitely/not/here").kind !== "unknown") fail("目录不存在应识别为 unknown")
}

// ---- 6. 远端查询：失败必须抛出 ----
{
  // 非 200
  let threw = ""
  try { await fetchLatestVersion(async () => ({ ok: false, status: 404, text: async () => "" })) }
  catch (e) { threw = String(e.message) }
  if (!/404/.test(threw)) fail("HTTP 404 应抛出，实际: " + threw)

  // 非 JSON
  threw = ""
  try { await fetchLatestVersion(async () => ({ ok: true, status: 200, text: async () => "not json" })) }
  catch (e) { threw = String(e.message) }
  if (!/JSON/.test(threw)) fail("非 JSON 应抛出，实际: " + threw)

  // 缺 version
  threw = ""
  try { await fetchLatestVersion(async () => ({ ok: true, status: 200, text: async () => '{"name":"x"}' })) }
  catch (e) { threw = String(e.message) }
  if (!/version/.test(threw)) fail("缺 version 应抛出，实际: " + threw)

  // 正常
  const ok = await fetchLatestVersion(async () => ({ ok: true, status: 200, text: async () => '{"version":"9.9.9"}' }))
  if (ok.version !== "9.9.9") fail("正常查询版本不对: " + JSON.stringify(ok))
  if (typeof ok.checkedAt !== "number") fail("checkedAt 缺失")
}

// ---- 7. 常量 ----
{
  if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) fail("REPO 形态不对: " + REPO)
  if (INSTALL_SPEC !== `github:${REPO}`) fail("INSTALL_SPEC 不对: " + INSTALL_SPEC)
}

console.log(JSON.stringify({ ok: !process.exitCode }, null, 2))
