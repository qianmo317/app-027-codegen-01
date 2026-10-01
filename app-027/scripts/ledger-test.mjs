// 台账导出与边界规则集成测试（Node + esbuild）
import { build } from 'esbuild'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const bundle = async (entry) => {
  const r = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@': join(root, 'src') },
    define: { 'import.meta.env.BASE_URL': '"/"' },
  })
  return 'data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64')
}

const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.performance = { now: () => Date.now() }

const ledger = await import(await bundle('src/logic/ledger.ts'))
const exp = await import(await bundle('src/logic/ledgerExport.ts'))

let passed = 0
const t = (name, fn) => {
  fn()
  passed++
  console.log('PASS', name)
}

ledger.__setLedgerSaveSuspended(true)
ledger.__resetLedgerForTest()

const today = new Date()
today.setHours(9, 0, 0, 0)
const tomorrow = new Date(today.getTime() + 86400000)

const auto = (over = {}) =>
  ledger.__makeEntryForTest({ auto: { cutLengthMm: 1500, actualCutMm: 3000, passes: 2, segmentCount: 12, paper: 'xuan', paperLabel: '宣纸', force: 60, speedMmS: 60 }, manual: {}, ...over }).auto

// 1) pending / discarded 不进汇总
const r1 = ledger.createManualEntry({
  jobAt: today.getTime(),
  projectId: 'p1',
  projectName: '甲',
  formName: '花',
  auto: auto(),
  manual: { sheetsUsed: 3, minutesSpent: 40, wasteSheets: 1, wasteReason: '偏移', operator: '王', customer: 'C1' },
})
assert.ok('entry' in r1)
// 手工登记默认 recorded；再手工造一条 pending
const cap = makeCap('p2', '乙', '鸟')
const rp = ledger.registerExportedJob(cap)
assert.ok('entry' in rp)
assert.equal(rp.entry.status, 'pending')

let s = ledger.summarize({ from: '', to: '', paper: '', operator: '', keyword: '' })
assert.equal(s.totals.count, 1, 'pending 不计入汇总')
assert.equal(s.totals.sheetsUsed, 3)

ledger.discardEntry(rp.entry.id, '误操作')
const rp2 = ledger.registerExportedJob(cap)
assert.ok('entry' in rp2, '丢弃后不参与去重，可重新记下')
assert.equal(rp2.entry.status, 'pending')
ledger.discardEntry(rp2.entry.id, '误操作 2')

s = ledger.summarize({ from: '', to: '', paper: '', operator: '', keyword: '' })
assert.equal(s.totals.count, 1, '丢弃不计入汇总')
t('pending/丢弃 不参与汇总；丢弃后允许重新记下', () => {})

// 2) 次日同款不算重复
const nextDay = ledger.createManualEntry({
  jobAt: tomorrow.getTime(),
  projectId: 'p1',
  projectName: '甲',
  formName: '花',
  auto: auto(),
  manual: { ...r1.entry.manual },
})
assert.ok('entry' in nextDay, '次日同款放行')
t('同一次作业跨天不视为重复', () => {})

// 3) 更正链：两次更正取最新
ledger.archiveEntry(r1.entry.id)
const c1 = ledger.addCorrection(r1.entry.id, { manual: { sheetsUsed: 4 } }, '第一次更：补一张')
assert.ok('entry' in c1)
const c2 = ledger.addCorrection(r1.entry.id, { manual: { sheetsUsed: 6, wasteSheets: 0, wasteReason: '' } }, '第二次更：废品那张其实没废')
assert.ok('entry' in c2)
const ef = ledger.effectiveOf(r1.entry)
assert.equal(ef.entry.manual.sheetsUsed, 6)
assert.equal(ef.entry.manual.wasteSheets, 0)
assert.equal(ef.root.manual.sheetsUsed, 3, '原记录不动')
assert.equal(ledger.correctionsOf(r1.entry.id).length, 2)
// 更正记录自身不可再改
assert.throws(() => ledger.updateEntry(c1.entry.id, { manual: { sheetsUsed: 9 } }), /归档/)
// 不能更正一条更正
assert.ok('error' in ledger.addCorrection(c1.entry.id, { manual: {} }, 'x'))
t('更正链取最新、原记录不动、更正不可再改且不能更正更正', () => {})

// 4) 客户清单不含废品/操作人等内部字段，含三合计
s = ledger.summarize({ from: '', to: '', paper: '', operator: '', keyword: '' })
const html = exp.buildCustomerReportHtml({ studioName: '测试剪纸工作室', filter: { from: '', to: '', paper: '', operator: '', keyword: '' }, summary: s })
assert.ok(html.includes('测试剪纸工作室'))
assert.ok(html.includes('作业清单'))
assert.ok(html.includes('合计刀路'))
assert.ok(!html.includes('废品原因'), '客户清单不得出现废品原因')
assert.ok(!html.includes('操作人'), '客户清单不得出现操作人')
assert.ok(html.includes('客户签字'))
t('客户清单 HTML 含合计与签字栏，不含内部字段（废品/操作人）', () => {})

// 5) 内部 CSV 含废品/操作人/更正标记
const csv = exp.buildInternalCsv(s)
assert.ok(csv.includes('废品(张)'))
assert.ok(csv.includes('操作人'))
assert.ok(csv.includes('已更正（取值为最新更正）'))
assert.ok(csv.startsWith('﻿'), 'CSV 带 UTF-8 BOM')
t('内部 CSV 含全部字段（废品/操作人/更正标记、BOM）', () => {})

// 6) 项目删除后仍可查
ledger.markProjectDeleted('p1')
const found = ledger.summarize({ from: '', to: '', paper: '', operator: '', keyword: '' })
const deletedRows = found.rows.filter((r) => r.root.projectDeleted)
assert.equal(deletedRows.length, 2, '两笔 p1 记录都保留')
assert.ok(deletedRows.every((r) => r.root.projectName === '甲'))
t('项目删除后台账仍在且标记可查（多笔同项目记录都保留）', () => {})

// 7) 指纹：导出格式不同但同一次作业
const cap2 = { ...cap, exportFormat: 'gcode' }
// 当前 p2 已丢弃，重新导出 PLT 记一条 pending，再 G-code 应被拦
const a = ledger.registerExportedJob(cap)
assert.ok('entry' in a)
const b = ledger.registerExportedJob(cap2)
assert.ok('duplicate' in b, '不同格式互导不算第二单')
t('PLT/G-code 互导识别为同一次作业并拦下', () => {})

// 8) 归档 recorded 后编辑拒绝
ledger.archiveEntry(nextDay.entry.id)
assert.throws(() => ledger.updateEntry(nextDay.entry.id, { manual: { sheetsUsed: 1 } }), /归档/)
t('归档记录 updateEntry 直接拒绝', () => {})

console.log(`\n${passed} 个台账集成测试全部通过`)
process.exit(0)

function makeCap(pid, projectName, formName) {
  // 直接用 registerExportedJob 需要完整 CaptureInput，这里手工构造
  const j = { steps: [], travelMm: 0, naiveTravelMm: 0, improvementPct: 0, cutLengthMm: 800, runCount: 8, perShape: {}, shapeOrder: [] }
  return {
    projectId: pid,
    projectName,
    formName,
    shapeCount: 1,
    layerCount: 1,
    batch: false,
    batchRows: 1,
    batchCols: 1,
    job: j,
    material: { id: 'm1', name: '宣纸精细', paper: 'xuan', force: 60, speedMmS: 60, passes: 2, bladeOffsetMm: 0.2, backing: '白色软垫板' },
    sheet: { widthMm: 210, heightMm: 297, name: 'A4 纵向' },
    bridgeWidthMm: 0.5,
    exportFormat: 'plt',
  }
}
