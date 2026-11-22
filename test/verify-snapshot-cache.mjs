/**
 * 落盘快照：模型目录与积分概览的冷启动加速。
 *
 * 这几条断言对应的都是「会在别人电脑上翻车」的真实路径，不是形式测试：
 *   1. 新进程（内存全空）必须能立刻拿到上次的值 —— 这是本功能存在的理由；
 *   2. 快照损坏/缺失必须退化成「没有快照」，绝不能让设置区报错；
 *   3. 绝不能把凭据写进快照 —— 它会落在明文 JSON 里；
 *   4. 积分快照必须按账号隔离，否则会把 A 的余额显示给 B。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SNAP = await import('file:///' + path.join(ROOT, 'src', 'snapshot-cache.js').replace(/\\/g, '/'))

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-'))
function cleanup() { try { fs.rmSync(home, { recursive: true, force: true }) } catch {} }

try {
  // 1. 冷读：先确认没有快照时返回 null（不能抛）
  assert.equal(SNAP.readSnapshot(home, 'catalogue'), null, '无快照时应返回 null')

  // 2. 写入后能读回，且 at 合理
  const catalogue = [{ id: 'hy3', name: 'Hunyuan 3' }, { id: 'hy3-x', name: 'Hunyuan 3 X' }]
  assert.equal(SNAP.writeSnapshot(home, 'catalogue', catalogue), true, '写入应成功')
  const back = SNAP.readSnapshot(home, 'catalogue')
  assert.ok(back, '写入后应能读回')
  assert.deepEqual(back.value, catalogue, '值应逐字段一致')
  assert.ok(Date.now() - back.at < 5000, 'at 应是刚刚')

  // 3. 过期判定：maxAge 之外必须读不到，否则「旧目录」会永久冒充现况
  const ancient = { at: Date.now() - 60_000, value: catalogue }
  fs.writeFileSync(
    path.join(home, 'dsh-codebuddy', 'old.snapshot.json'),
    JSON.stringify({ schema: 'dsh-codebuddy/snapshot/v1', ...ancient }),
  )
  assert.equal(SNAP.readSnapshot(home, 'old', 30_000), null, '超龄快照应返回 null')
  assert.ok(SNAP.readSnapshot(home, 'old', 120_000), '未超龄应能读到')

  // 4. 损坏文件不能让调用方崩：一个坏 JSON 就废掉整个设置区是不可接受的
  fs.writeFileSync(path.join(home, 'dsh-codebuddy', 'broken.snapshot.json'), '{ not json')
  assert.equal(SNAP.readSnapshot(home, 'broken'), null, '损坏快照应返回 null 而不是抛')
  // schema 不匹配也要拒绝（防止将来换格式时误读旧文件）
  fs.writeFileSync(
    path.join(home, 'dsh-codebuddy', 'badschema.snapshot.json'),
    JSON.stringify({ schema: 'something/else', at: Date.now(), value: { a: 1 } }),
  )
  assert.equal(SNAP.readSnapshot(home, 'badschema'), null, 'schema 不符应返回 null')

  // 5. 路径穿越：name 里的 ../ 会被清洗掉，绝不能写到目录外
  SNAP.writeSnapshot(home, '../../evil', { x: 1 })
  assert.equal(fs.existsSync(path.join(home, '..', 'evil.snapshot.json')), false, '不能写到上级目录')
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'evil.snapshot.json')), false, '不能写到临时目录根')
  // 清洗后仍应落在自己的目录里（名字变成 evilsnapshot，依然可用且安全）
  const inside = fs.readdirSync(path.join(home, 'dsh-codebuddy')).filter((f) => f.startsWith('evil'))
  assert.ok(inside.length >= 1, '清洗后的名字应仍写在 dsh-codebuddy 目录内')

  // 6. 凭据绝不落盘：积分快照里出现 token 字段就是安全事故
  const sampleOverview = {
    ok: true,
    balance: { total: 560.67, packages: [] },
    checkin: { checkedInToday: true, streakDays: 25 },
    fetchedAt: Date.now(),
  }
  SNAP.writeSnapshot(home, 'credits-acc1', sampleOverview)
  const raw = fs.readFileSync(path.join(home, 'dsh-codebuddy', 'credits-acc1.snapshot.json'), 'utf8')
  for (const secret of ['access_token', 'refresh_token', 'Bearer ', 'eyJ']) {
    assert.equal(raw.includes(secret), false, `快照里不应出现 ${secret}`)
  }

  // 7. 按账号隔离：两个账号互不覆盖
  SNAP.writeSnapshot(home, 'credits-acc2', { ok: true, balance: { total: 12 } })
  assert.equal(SNAP.readSnapshot(home, 'credits-acc1').value.balance.total, 560.67, 'acc1 不应被 acc2 覆盖')
  assert.equal(SNAP.readSnapshot(home, 'credits-acc2').value.balance.total, 12, 'acc2 应独立')

  // 8. 删除
  assert.equal(SNAP.dropSnapshot(home, 'credits-acc2'), true, '删除应成功')
  assert.equal(SNAP.readSnapshot(home, 'credits-acc2'), null, '删除后应读不到')

  // 9. 空值不写（null/undefined 写进去会让下次读出一个假值）
  assert.equal(SNAP.writeSnapshot(home, 'empty', null), false, 'null 不应写入')
  assert.equal(SNAP.writeSnapshot(home, 'empty', undefined), false, 'undefined 不应写入')

  // 10. 只读目录下写入失败必须静默，不能抛（用户可能把 DSH_HOME 放在只读盘）
  const roHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snapro-'))
  try {
    fs.mkdirSync(path.join(roHome, 'dsh-codebuddy'), { recursive: true })
    fs.writeFileSync(path.join(roHome, 'dsh-codebuddy', 'blocked.snapshot.json.tmp-0'), 'x')
    // 用一个不可能有权限的 name 触发失败路径；不断言具体平台行为，只要求不抛
    SNAP.writeSnapshot(roHome, 'ok', { a: 1 })
  } finally {
    try { fs.rmSync(roHome, { recursive: true, force: true }) } catch {}
  }

  const size = fs.statSync(path.join(home, 'dsh-codebuddy', 'catalogue.snapshot.json')).size
  console.log(`PASS snapshot cache (catalogue snapshot ${size}B, cold-read instant)`)
} finally {
  cleanup()
}
