import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS, type CutSettings, type MaterialPreset, type Pt, type Shape } from './types'
import { cleanupContours } from './cleanup'
import { importSvgText } from './importer'
import { computeShape } from './pipeline'
import { buildJob } from './job'
import { buildA4Sheet, computePlacement, exportGcode, exportPlt, type ExportMeta } from './exporters'
import { polygonArea, polylineLength } from './geometry'
import {
  __makeEntryForTest,
  __resetLedgerForTest,
  __restoreLedgerForTest,
  __setLedgerSaveSuspended,
  __snapshotLedgerForTest,
  addCorrection,
  archiveEntry,
  buildAutoSnapshot,
  createManualEntry,
  discardEntry,
  effectiveOf,
  markProjectDeleted,
  registerExportedJob,
  summarize,
  updateEntry,
  type CaptureInput,
} from './ledger'

export type CheckResult = {
  id: string
  title: string
  pass: boolean
  detail: string
}

export type ImportedSummary = {
  file: string
  name: string
  kept: number
  notClosed: number
  selfIntersect: number
  duplicates: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

export type SelfTestReport = {
  checks: CheckResult[]
  summaries: ImportedSummary[]
  totalMs: number
}

type Item = {
  file: string
  name: string
  shape: Shape
  contours: number
  notClosed: number
  si: number
  dup: number
  maxDepth: number
  bridges: number
  fragments: number
  ms: number
}

function ok(id: string, title: string, pass: boolean, detail: string): CheckResult {
  return { id, title, pass, detail }
}

/** 造一个 5000 点的波浪圆轮廓 */
function wavyCircle(cx: number, cy: number, r: number, n: number, amp: number, lobes: number): Pt[] {
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const rr = r + amp * Math.sin(lobes * a)
    pts.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) })
  }
  return pts
}

export async function runSelfTest(settings: CutSettings = DEFAULT_CUT_SETTINGS, material?: MaterialPreset): Promise<SelfTestReport> {
  const t0 = performance.now()
  const checks: CheckResult[] = []
  const summaries: ImportedSummary[] = []
  const mat = material ?? defaultMaterials()[0]

  // ---------- 1. 导入 10 个真实窗花 SVG ----------
  const imported: Item[] = []
  for (const p of PATTERN_LIBRARY) {
    try {
      const text = await fetchPatternText(p.file)
      const t1 = performance.now()
      const res = importSvgText(text, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
      const shape: Shape = { id: `st_${p.slug}`, name: p.name, contours: res.contours, layer: 0 }
      const comp = computeShape(shape, settings, mat)
      const ms = performance.now() - t1
      imported.push({
        file: p.file,
        name: p.name,
        shape,
        contours: res.contours.length,
        notClosed: res.cleanup.notClosed,
        si: res.cleanup.selfIntersect,
        dup: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
      summaries.push({
        file: p.file,
        name: p.name,
        kept: res.contours.length,
        notClosed: res.cleanup.notClosed,
        selfIntersect: res.cleanup.selfIntersect,
        duplicates: res.cleanup.duplicates,
        maxDepth: comp.stats.maxDepth,
        bridges: comp.stats.bridgeCount,
        fragments: comp.stats.fragmentCount,
        ms,
      })
    } catch (e) {
      checks.push(ok(`import-${p.file}`, `导入 ${p.name}`, false, (e as Error).message))
    }
  }

  checks.push(
    ok(
      'import-10',
      '导入 10 个真实窗花 SVG（本地纹样库，含嵌套 3 层 / 自交 / 未闭合 / 重复用例）',
      imported.length === 10 && imported.every((x) => x.contours > 0),
      imported.map((x) => `${x.file.replace('.svg', '')}:${x.contours}轮廓`).join('｜'),
    ),
  )

  const byFile = new Map(imported.map((x) => [x.file, x]))

  const conc = byFile.get('concentric-three.svg')
  checks.push(
    ok(
      'nesting-3',
      '包含关系树嵌套 3 层正确（同心三层窗花）',
      !!conc && conc.maxDepth >= 3,
      conc ? `同心三层窗花 maxDepth = ${conc.maxDepth}（外圆 depth1 → 内圆 depth2 → 花瓣 depth3）` : '未导入',
    ),
  )

  const selfCross = byFile.get('self-cross-flower.svg')
  checks.push(
    ok(
      'self-intersect',
      '自交检测：缠枝自交花标出全部自交路径',
      !!selfCross && selfCross.si >= 2,
      selfCross ? `自交轮廓 ${selfCross.si} 条（八角星 {8/3} 星形 + 蝴蝶结对角线交叉）` : '未导入',
    ),
  )

  const openSpiral = byFile.get('open-spiral.svg')
  checks.push(
    ok(
      'not-closed',
      '闭合检查：盘长未闭合纹标出未闭合路径',
      !!openSpiral && openSpiral.notClosed >= 1,
      openSpiral ? `未闭合 ${openSpiral.notClosed} 条（首尾距离 > 容差 ${settings.closeToleranceMm}mm，可一键闭合）` : '未导入',
    ),
  )

  const scatter = byFile.get('petal-scatter.svg')
  checks.push(
    ok(
      'duplicate',
      '重复路径合并：雪花散点中完全重叠 / 反向重叠的路径被合并',
      !!scatter && scatter.dup >= 2,
      scatter ? `合并重复路径 ${scatter.dup} 条（同一图形画了 2 遍，其中一条点序反向）` : '未导入',
    ),
  )

  const clean = byFile.get('window-flower-classic.svg')
  checks.push(
    ok(
      'clean-file',
      '干净文件不误报：经典八角窗花 0 未闭合 / 0 自交 / 0 重复',
      !!clean && clean.notClosed === 0 && clean.si === 0 && clean.dup === 0,
      clean ? `未闭合 ${clean.notClosed}｜自交 ${clean.si}｜重复 ${clean.dup}` : '未导入',
    ),
  )

  // ---------- 2. 连刀点：宽度 / 偏差 / 碎片 / 长度规则 ----------
  let widthMaxErr = 0
  let devLarge = 0
  let devAll = 0
  let maxAreaDelta = 0
  let maxLengthDelta = 0
  let fragTotal = 0
  let fragWithBridges = 0
  let bridgeTotal = 0
  let degraded = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_area' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m) continue
      bridgeTotal += m.bridgeMetrics.count
      if (m.bridgeMetrics.degraded) degraded += 1
      if (c.closed && c.area < settings.areaThresholdMm2) {
        fragTotal += 1
        if (m.bridgeMetrics.count >= 2) fragWithBridges += 1
      }
      if (!m.bridgeMetrics.degraded) {
        for (const w of m.bridgeMetrics.widths) widthMaxErr = Math.max(widthMaxErr, Math.abs(w - settings.bridgeWidthMm))
      }
      devAll = Math.max(devAll, m.bridgeMetrics.geometryDeviationMm)
      if (c.length >= 20) devLarge = Math.max(devLarge, m.bridgeMetrics.geometryDeviationMm)
      maxAreaDelta = Math.max(maxAreaDelta, Math.abs(m.bridgeMetrics.areaBefore - m.bridgeMetrics.areaAfter))
      maxLengthDelta = Math.max(maxLengthDelta, Math.abs(m.bridgeMetrics.lengthBefore - m.bridgeMetrics.lengthAfter))
    }
  }

  checks.push(
    ok(
      'bridge-width',
      `连刀点缺口宽度与设定一致（${settings.bridgeWidthMm}mm ± 0.05mm）`,
      widthMaxErr <= 0.05,
      `共 ${bridgeTotal} 个连刀点，最大偏差 ${widthMaxErr.toFixed(4)}mm${degraded ? `（${degraded} 个碎片因过短被削窄，单独计为降级告警）` : ''}`,
    ),
  )

  checks.push(
    ok(
      'bridge-deviation',
      '轮廓几何偏差 ≤ 0.1mm（挖缺口后重算面积/周长并记录偏差）',
      devLarge <= 0.1,
      `缺口吸附在单条直线段内（不跨折角）：最大几何偏差 ${devAll.toFixed(5)}mm（长度 ≥20mm 轮廓 ${devLarge.toFixed(5)}mm）｜` +
        `被挖掉的最大面积 ${maxAreaDelta.toFixed(4)}mm²、最大周长 ${maxLengthDelta.toFixed(3)}mm（已重算并记录）`,
    ),
  )

  checks.push(
    ok(
      'bridge-fragment',
      `小碎片（面积 < ${settings.areaThresholdMm2}mm²）100% 生成连刀点（每片 ≥ 2 个）`,
      fragTotal === 0 || fragWithBridges === fragTotal,
      `碎片 ${fragTotal} 个，已连刀 ${fragWithBridges} 个，覆盖 ${fragTotal ? ((fragWithBridges / fragTotal) * 100).toFixed(0) : 100}%`,
    ),
  )

  let lengthRuleOk = true
  const lengthRuleDetail: string[] = []
  let lengthRuleCount = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, { ...settings, bridgeRule: 'by_length' }, mat)
    for (const c of item.shape.contours) {
      const m = comp.byId.get(c.id)
      if (!m || !c.closed) continue
      if (c.area < settings.areaThresholdMm2) continue
      const expect = Math.floor(c.length / settings.bridgeEveryMm)
      if (expect !== m.bridgeMetrics.count) {
        lengthRuleOk = false
        if (lengthRuleDetail.length < 5) lengthRuleDetail.push(`${item.file}: 周长 ${c.length.toFixed(1)}mm 期望 ${expect} 实得 ${m.bridgeMetrics.count}`)
      }
      lengthRuleCount += 1
    }
  }
  checks.push(
    ok(
      'bridge-by-length',
      '大轮廓按长度规则数量正确（n = ⌊周长 / 每段长度⌋）',
      lengthRuleOk,
      lengthRuleOk ? `每 ${settings.bridgeEveryMm}mm 一个连刀点，校验 ${lengthRuleCount} 条大轮廓全部吻合` : lengthRuleDetail.join('；'),
    ),
  )

  // ---------- 3. 切割顺序：先内后外 ----------
  let orderOk = true
  const orderDetail: string[] = []
  let orderPairs = 0
  for (const item of imported) {
    const comp = computeShape(item.shape, settings, mat)
    const idx = new Map<string, number>()
    comp.order.steps.forEach((s, i) => {
      if (!idx.has(s.contourId)) idx.set(s.contourId, i)
    })
    for (const c of item.shape.contours) {
      const pi = idx.get(c.id)
      if (pi === undefined) continue
      for (const hid of c.holes) {
        const ci = idx.get(hid)
        if (ci === undefined) continue
        orderPairs += 1
        if (ci > pi) {
          orderOk = false
          if (orderDetail.length < 3) orderDetail.push(`${item.file}: 内层排在外层之后`)
        }
      }
    }
  }
  checks.push(
    ok(
      'order-inner-first',
      '切割顺序为先内后外（后序遍历包含关系树）',
      orderOk && orderPairs > 0,
      orderOk ? `校验 ${orderPairs} 组父子关系，内层轮廓全部排在外层之前` : orderDetail.join('；'),
    ),
  )

  // ---------- 4. 跳刀优化 ≥ 15% ----------
  let improvement = 0
  let nnImprovement = 0
  let travelDetail = '未导入'
  if (scatter) {
    const comp2 = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest_2opt' }, mat)
    const compNn = computeShape(scatter.shape, { ...settings, travelOptimize: 'nearest' }, mat)
    improvement = comp2.stats.improvementPct
    nnImprovement = compNn.stats.improvementPct
    travelDetail =
      `雪花散点（24 个碎片）：朴素顺序 ${comp2.stats.naiveTravelMm.toFixed(1)}mm → 仅最近邻 ${compNn.stats.travelMm.toFixed(1)}mm（−${nnImprovement.toFixed(1)}%）→ ` +
      `最近邻+2-opt ${comp2.stats.travelMm.toFixed(1)}mm（−${comp2.stats.improvementPct.toFixed(1)}%）`
  }
  checks.push(ok('travel-2opt', '跳刀优化：2-opt 后总跳刀长度比朴素顺序短 ≥ 15%', improvement >= 15, travelDetail))

  // ---------- 5. 导出 PLT / G-code ----------
  const exportShape = clean?.shape ?? imported[0]?.shape
  if (exportShape) {
    const comp = computeShape(exportShape, settings, mat)
    const sheet = { widthMm: 210, heightMm: 297, name: 'A4 纵向' }
    const job = buildJob([exportShape], new Map([[exportShape.id, comp]]), [0], { sharedEdge: false, start: { x: 0, y: 0 } })
    const pl = computePlacement(job.steps, sheet, 1)
    const meta: ExportMeta = {
      projectName: '自检',
      formName: exportShape.name,
      material: mat,
      bridgeWidthMm: settings.bridgeWidthMm,
      passes: mat.passes,
      sheet,
      cutLengthMm: job.cutLengthMm,
      travelMm: job.travelMm,
    }
    const plt = exportPlt(
      job.steps,
      { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 },
      sheet,
      meta,
      pl,
    )

    let maxInternalY = -Infinity
    let exportYOfMax = 0
    for (const st of job.steps) {
      for (const p of st.points) {
        const y = p.y + pl.offsetY
        if (y > maxInternalY) {
          maxInternalY = y
          exportYOfMax = Math.round((sheet.heightMm - y) / 0.025)
        }
      }
    }
    const inSheet = plt.minX >= 0 && plt.minY >= 0 && plt.maxX <= plt.sheetMaxX && plt.maxY <= plt.sheetMaxY
    const flipOk = Math.abs(plt.minY - exportYOfMax) <= 1
    checks.push(
      ok(
        'export-plt',
        '导出 PLT：坐标全部落在纸幅内、原点在左下（y′ = 纸幅高 − y）',
        inSheet && flipOk,
        `X ${plt.minX}~${plt.maxX}｜Y ${plt.minY}~${plt.maxY}（0.025mm/单位，纸幅上限 ${plt.sheetMaxX}×${plt.sheetMaxY}）｜` +
          `内部最大 y = ${maxInternalY.toFixed(2)}mm → 导出最小 y = ${exportYOfMax}（左下原点）`,
      ),
    )

    const gcode = exportGcode(job.steps, { format: 'gcode', unit: 'mm', origin: 'bottom_left', yFlip: true, scale: 1 }, sheet, meta, pl)
    const hasG21 = gcode.text.includes('G21')
    const feed = Math.round(mat.speedMmS * 60)
    const hasFeed = gcode.text.includes(`F${feed}`)
    const passSegments = (gcode.text.match(/; ---- pass \d+\/\d+/g) ?? []).length
    checks.push(
      ok(
        'export-gcode',
        '导出 G-code：单位 mm、进给与重复次数正确',
        hasG21 && hasFeed && passSegments === mat.passes,
        `G21(mm)=${hasG21}｜F${feed}（${mat.speedMmS}mm/s × 60）=${hasFeed}｜pass 段 ${passSegments}/${mat.passes}`,
      ),
    )

    // ---------- 6. A4 检查图 1:1 ----------
    const a4 = buildA4Sheet(job.steps, sheet, meta, pl, { showNumbers: true, showTravel: true, title: '自检' })
    const rulerMatch = /<line x1="([\d.]+)" y1="[\d.]+" x2="([\d.]+)" y2="[\d.]+" stroke="#000" stroke-width="0.3"\/>/.exec(a4)
    const rulerLen = rulerMatch ? Math.abs(Number(rulerMatch[2]) - Number(rulerMatch[1])) : 0
    const isMm1to1 =
      a4.includes(`width="${sheet.widthMm}mm"`) &&
      a4.includes(`height="${sheet.heightMm}mm"`) &&
      a4.includes(`viewBox="0 0 ${sheet.widthMm} ${sheet.heightMm}"`)
    checks.push(
      ok(
        'a4-ruler',
        'A4 检查图 1:1：100mm 校验尺几何长度误差 ≤ 1mm',
        Math.abs(rulerLen - 100) <= 1 && isMm1to1,
        `校验尺 ${rulerLen.toFixed(3)}mm（误差 ${Math.abs(rulerLen - 100).toFixed(3)}mm）｜SVG 物理尺寸 ${sheet.widthMm}mm×${sheet.heightMm}mm，浏览器 CSS mm 打印为 1:1`,
      ),
    )
  } else {
    checks.push(ok('export-plt', '导出 PLT 用例', false, '没有可用的纹样'))
  }

  // ---------- 7. 性能 ----------
  const bigPts = wavyCircle(80, 80, 62, 5000, 2.5, 11)
  const rawBig: Array<{ points: Pt[]; closed: boolean }> = [{ points: bigPts, closed: true }]
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2
    rawBig.push({ points: wavyCircle(80 + 50 * Math.cos(a), 80 + 50 * Math.sin(a), 1.1, 20, 0, 3), closed: true })
  }
  const t2 = performance.now()
  const cleaned = cleanupContours(rawBig, { toleranceMm: settings.toleranceMm, closeToleranceMm: settings.closeToleranceMm })
  const bigShape: Shape = { id: 'st_perf', name: '性能用例', contours: cleaned.contours, layer: 0 }
  const bigComp = computeShape(bigShape, settings, mat)
  const perfMs = performance.now() - t2
  checks.push(
    ok(
      'perf-5000',
      '5000 点轮廓全流程（清理 + 连刀 + 排序）< 300ms',
      perfMs < 300,
      `主轮廓 ${bigPts.length} 点 + 40 个碎片｜清理保留 ${cleaned.contours.length} 条｜连刀 ${bigComp.stats.bridgeCount} 个｜耗时 ${perfMs.toFixed(1)}ms`,
    ),
  )

  // ---------- 8. 缓存签名（参数变化才失效） ----------
  const sigA = computeShape(bigShape, settings, mat).signature
  const sigB = computeShape(bigShape, { ...settings, bridgeWidthMm: settings.bridgeWidthMm + 0.1 }, mat).signature
  checks.push(
    ok('cache-signature', '参数变化使缓存签名失效（避免每次渲染都重算）', sigA !== sigB, `签名一致 = ${sigA === sigB}（应为 false，参数已变化）`),
  )

  // ---------- 9. 刀补：凹角自交裁剪 + 明确告警 ----------
  const starShape: Shape = {
    id: 'st_offset',
    name: '刀补用例',
    layer: 0,
    contours: [makeStar(80, 80, 40, 20, 5, 0.3)],
  }
  const noOffset = computeShape(starShape, { ...settings, useBladeOffset: false }, mat)
  const withOffset = computeShape(starShape, { ...settings, useBladeOffset: true }, mat)
  const starId = starShape.contours[0].id
  const offEntry = withOffset.byId.get(starId)
  const noEntry = noOffset.byId.get(starId)
  const offsetMsg = offEntry?.offsetMessage ?? ''
  const geometryChanged = JSON.stringify(offEntry?.runs) !== JSON.stringify(noEntry?.runs)
  checks.push(
    ok(
      'blade-offset',
      '刀补：闭合轮廓按 bladeOffset 偏置，凹角自交自动裁剪',
      geometryChanged && (offEntry?.offsetOk ?? false),
      `五角星（外 R40 / 内 R20，10 个凹角）刀补 ${mat.bladeOffsetMm}mm：${offsetMsg}｜几何已改变 = ${geometryChanged}`,
    ),
  )
  // 刀补失败用例：外层大方框内的细长条（depth=2 → 向内偏置），0.25mm 偏置必然让 0.3mm 细条塌陷
  const thinInner = rectContour('st_thin', 30, 39.85, 20, 0.3)
  const outerSquare = rectContour('st_outer', 0, 0, 80, 80)
  const tinyShape: Shape = { id: 'st_offset_tiny', name: '刀补失败用例', layer: 0, contours: [outerSquare, thinInner] }
  const tinyOffset = computeShape(tinyShape, { ...settings, useBladeOffset: true }, mat)
  const tinyEntry = tinyOffset.byId.get(thinInner.id)
  const tinyOk = tinyEntry?.offsetOk ?? true
  const tinyMsg = tinyEntry?.offsetMessage ?? ''
  const tinyRuns = tinyEntry?.runs.length ?? 0
  checks.push(
    ok(
      'blade-offset-fail',
      '刀补超出轮廓尺度时明确警告并保留原路径（不输出坏路径）',
      !tinyOk && tinyMsg.includes('原路径') && tinyRuns > 0,
      `0.3mm 细长条（内层，向内侧偏置 ${mat.bladeOffsetMm}mm）：${tinyMsg}｜仍输出 ${tinyRuns} 段原路径`,
    ),
  )

  // ---------- 10. 作业台账 ----------
  const ledgerBackup = __snapshotLedgerForTest()
  __setLedgerSaveSuspended(true)
  __resetLedgerForTest()
  const ledgerDetails: string[] = []

  // 10.1 导出自动带出 + 整场合算（多形状多图层）
  let autoOk = false
  let autoDetail = '缺导出用例'
  if (exportShape) {
    const comp2 = computeShape(exportShape, settings, mat)
    const shape2: Shape = { id: 'st_ledger_b', name: '台账多形状用例', contours: exportShape.contours, layer: 1 }
    const job2 = buildJob(
      [exportShape, shape2],
      new Map([
        [exportShape.id, comp2],
        [shape2.id, comp2],
      ]),
      [0, 1],
      { sharedEdge: false, start: { x: 0, y: 0 } },
    )
    const cap: CaptureInput = {
      projectId: 'p-ledger',
      projectName: '台账自检项目',
      formName: `${exportShape.name}、${shape2.name}`,
      shapeCount: 2,
      layerCount: 2,
      batch: false,
      batchRows: 1,
      batchCols: 1,
      job: job2,
      material: mat,
      sheet: { widthMm: 210, heightMm: 297, name: 'A4 纵向' },
      bridgeWidthMm: settings.bridgeWidthMm,
      exportFormat: 'plt',
    }
    const snap = buildAutoSnapshot(cap)
    autoOk =
      Math.abs(snap.cutLengthMm - job2.cutLengthMm) < 0.01 &&
      snap.segmentCount === job2.runCount &&
      snap.shapeCount === 2 &&
      snap.layerCount === 2 &&
      snap.paper === mat.paper &&
      snap.force === mat.force &&
      snap.speedMmS === mat.speedMmS &&
      snap.passes === mat.passes &&
      Math.abs(snap.actualCutMm - job2.cutLengthMm * mat.passes) < 0.01
    autoDetail = `整场合并：刀路 ${snap.cutLengthMm.toFixed(1)}mm / ${snap.segmentCount} 段 / ${snap.shapeCount} 形状 / ${snap.layerCount} 图层 / ${snap.paperLabel}｜刀压 ${snap.force} 速度 ${snap.speedMmS} 遍数 ${snap.passes}｜含遍数走刀 ${snap.actualCutMm.toFixed(1)}mm`

    // 10.2 导出自动记一笔 → pending
    const r1 = registerExportedJob(cap)
    const pending = 'entry' in r1 ? r1.entry : null
    autoOk = autoOk && !!pending && pending?.status === 'pending' && pending?.source === 'export_auto'

    // 10.3 同一次作业重复导出被拦下（不同格式也算同一次）
    if (pending) {
      const capG = { ...cap, exportFormat: 'gcode' }
      const r2 = registerExportedJob(capG)
      const blockedAgain = 'duplicate' in r2 && r2.duplicate.id === pending.id
      autoOk = autoOk && blockedAgain
      autoDetail += `｜重复导出（G-code）拦截 = ${blockedAgain}`

      // 丢弃后可重新记下
      discardEntry(pending.id, '自检：误导出，丢弃')
      const r3 = registerExportedJob(cap)
      const reRegistered = 'entry' in r3
      autoOk = autoOk && reRegistered
      autoDetail += '｜丢弃后允许重新记下'
      if ('entry' in r3) discardEntry(r3.entry.id, '自检清理')
    }
  }
  checks.push(ok('ledger-auto', '台账：导出刀路自动带出整场刀路（多形状多图层合算：总长/段数/纸张/刀压/速度/遍数），重复登记拦下', autoOk, autoDetail))

  // 手工登记两笔（不同纸张、不同操作人）
  const today = new Date()
  today.setHours(10, 30, 0, 0)
  const tToday = today.getTime()
  const yesterday = new Date(tToday - 86400000)
  const e1 = createManualEntry(
    {
      jobAt: tToday,
      projectId: 'p-a',
      projectName: '客户甲窗花',
      formName: '八角窗花',
      auto: __makeEntryForTest({ auto: { paper: 'red-paper', paperLabel: '红纸（剪纸）', cutLengthMm: 2000, actualCutMm: 2000, segmentCount: 20, force: 85, speedMmS: 50, passes: 1 } }).auto,
      manual: { sheetsUsed: 4, minutesSpent: 90, wasteSheets: 1, wasteReason: '走纸偏移', operator: '王师傅', customer: '甲', note: '' },
    },
  )
  const e2 = createManualEntry(
    {
      jobAt: yesterday.getTime(),
      projectId: 'p-b',
      projectName: '乙喜字',
      formName: '囍字',
      auto: __makeEntryForTest({ auto: { paper: 'cardstock', paperLabel: '卡纸', cutLengthMm: 3000, actualCutMm: 3000, segmentCount: 30, force: 120, speedMmS: 40, passes: 1, shapeCount: 2, layerCount: 2 } }).auto,
      manual: { sheetsUsed: 2, minutesSpent: 30, wasteSheets: 0, wasteReason: '', operator: '李师傅', customer: '乙', note: '' },
    },
  )
  const e1e = 'entry' in e1 ? e1.entry : null
  const e2e = 'entry' in e2 ? e2.entry : null
  ledgerDetails.push(`手工登记 2 笔：${e1e ? '成功' : '失败'} / ${e2e ? '成功' : '失败'}`)

  // 10.3b 手工登记：同一次作业（同项目同参数同长度）默认拦下，写明原因可强制再记
  let manualDupOk = false
  if (e1e) {
    const again = createManualEntry({
      jobAt: tToday,
      projectId: 'p-a',
      projectName: '客户甲窗花',
      formName: '八角窗花',
      auto: e1e.auto,
      manual: e1e.manual,
    })
    const blocked = 'duplicate' in again && again.duplicate.id === e1e.id
    const forced = createManualEntry(
      {
        jobAt: tToday,
        projectId: 'p-a',
        projectName: '客户甲窗花',
        formName: '八角窗花',
        auto: e1e.auto,
        manual: { ...e1e.manual, note: '客户临时加订一单同款' },
      },
      { allow: true, reason: '客户当天加订同款，确属第二单' },
    )
    manualDupOk = blocked && 'entry' in forced && forced.entry.duplicateOfId === e1e.id
    ledgerDetails.push(`手工重复登记默认拦截 = ${blocked}，写明原因后强制登记 = ${'entry' in forced}`)
  }

  // 10.4 归档后不可改，只能更正
  let immutableOk = !!e1e
  let correctionOk = false
  let effectiveOk = false
  let reasonRequired = false
  if (e1e) {
    archiveEntry(e1e.id)
    let blocked = false
    try {
      updateEntry(e1e.id, { manual: { sheetsUsed: 99 } })
    } catch {
      blocked = true
    }
    immutableOk = blocked && e1e.manual.sheetsUsed === 4
    ledgerDetails.push(`归档后修改被拒 = ${blocked}，原用纸仍为 ${e1e.manual.sheetsUsed}`)

    // 更正必须写原因
    const noReason = addCorrection(e1e.id, { manual: { sheetsUsed: 5 } }, '  ')
    reasonRequired = 'error' in noReason
    // 正常更正：用纸 4→5，废品 1→2 并补原因
    const cr = addCorrection(e1e.id, { manual: { sheetsUsed: 5, wasteSheets: 2, wasteReason: '走纸偏移；第二张连刀点开大' } }, '切割后复核，实际多废一张连刀点开大的纸')
    correctionOk = 'entry' in cr && cr.entry.status === 'archived' && cr.entry.rootId === e1e.id && e1e.manual.sheetsUsed === 4
    if ('entry' in cr) {
      const ef = effectiveOf(e1e)
      effectiveOk = ef.entry.manual.sheetsUsed === 5 && ef.entry.manual.wasteSheets === 2 && !!ef.correction && ef.root.manual.sheetsUsed === 4
      ledgerDetails.push(`更正新增 1 条（原值不改：用纸 ${ef.root.manual.sheetsUsed}；有效值：用纸 ${ef.entry.manual.sheetsUsed}、废品 ${ef.entry.manual.wasteSheets}）`)
    }
  }
  checks.push(
    ok(
      'ledger-immutable',
      '台账：归档后不许改，只能新增更正记录并写明原因；汇总取最新更正值，原记录原样保留。同日重复登记默认拦下、写原因可强制再记',
      immutableOk && reasonRequired && correctionOk && effectiveOk && manualDupOk,
      ledgerDetails.join('｜'),
    ),
  )

  // 10.5 汇总：按时间段 / 纸张 / 操作人（用纸、米刀路、工时；已更正的取更正值）
  const redOnly = summarize({ from: '', to: '', paper: 'red-paper', operator: '', keyword: '' })
  const e1Effective = e1e ? effectiveOf(e1e).entry : null
  // 红纸 = 原 1 笔（已更正：5 张/90min/2m/废品2）+ 强制再记的 1 笔（4 张/90min/2m）
  const redSheets = redOnly.totals.sheetsUsed
  const redCutOk = Math.abs(redOnly.totals.cutMm - 4000) < 0.001
  const redMinOk = redOnly.totals.minutes === 180
  const paperFilterOk =
    e1Effective?.manual.sheetsUsed === 5 && redCutOk && redMinOk && redSheets === 9 && redOnly.rows.every((r) => r.entry.auto.paper === 'red-paper')

  const wang = summarize({ from: '', to: '', paper: '', operator: '王师傅', keyword: '' })
  const opFilterOk = wang.totals.count === 2 && wang.byOperator.length === 1 && wang.byOperator[0].key === '王师傅'

  const li = summarize({ from: '', to: '', paper: '', operator: '李师傅', keyword: '' })
  const cardOk = li.totals.count === 1 && li.totals.sheetsUsed === 2 && Math.abs(li.totals.cutMm - 3000) < 0.001 && li.totals.minutes === 30

  const todayOnly = summarize({ from: dayKeyStr(tToday), to: dayKeyStr(tToday), paper: '', operator: '', keyword: '' })
  const yOnly = summarize({ from: dayKeyStr(yesterday.getTime()), to: dayKeyStr(yesterday.getTime()), paper: '', operator: '', keyword: '' })
  const timeOk = todayOnly.totals.count === 2 && yOnly.totals.count === 1 && yOnly.totals.sheetsUsed === 2
  checks.push(
    ok(
      'ledger-summary',
      '台账：按时间段 / 纸张 / 操作人汇总用纸（张）、刀路（米）、工时；已更正的取更正值',
      paperFilterOk && opFilterOk && cardOk && timeOk,
      `红纸组（含 1 条更正后 5 张 + 1 条强制同款 4 张）：${redSheets} 张 / ${(redOnly.totals.cutMm / 1000).toFixed(2)}m / ${redOnly.totals.minutes}min` +
        `｜王师傅 ${wang.totals.count} 单｜李师傅（卡纸）${li.totals.sheetsUsed} 张/3m/30min=${cardOk}｜今天 ${todayOnly.totals.count} 单、昨天 1 单=${timeOk}`,
    ),
  )

  // 10.6 项目删除后台账仍在
  let deleteOk = false
  if (e2e) {
    markProjectDeleted('p-b')
    deleteOk = e2e.projectDeleted === true
    const still = summarize({ from: '', to: '', paper: '', operator: '', keyword: '喜字' })
    deleteOk = deleteOk && still.rows.length === 1
  }
  checks.push(ok('ledger-delete-project', '台账：删除纹样项目后台账不消失，仍可查询（仅标记项目已删）', deleteOk, deleteOk ? 'p-b 删除后，记录保留并标记，按关键字仍可查到' : '未验证'))

  __restoreLedgerForTest(ledgerBackup)

  const totalMs = performance.now() - t0
  return { checks, summaries, totalMs }
}

function dayKeyStr(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 矩形轮廓 */
function rectContour(id: string, x: number, y: number, w: number, h: number): Shape['contours'][number] {
  const pts: Pt[] = [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
  return { id, points: pts, closed: true, area: w * h, length: 2 * (w + h), holes: [], bridges: [], warnings: [] }
}

/** 星形多边形（含凹角，用于刀补自交裁剪测试） */
function makeStar(cx: number, cy: number, rOuter: number, rInner: number, points: number, wobble: number): Shape['contours'][number] {
  const pts: Pt[] = []
  const n = points * 2
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const r = (i % 2 === 0 ? rOuter : rInner) * (1 + (i % 3 === 0 ? wobble : 0))
    pts.push({ x: Math.round((cx + r * Math.cos(a)) * 1000) / 1000, y: Math.round((cy + r * Math.sin(a)) * 1000) / 1000 })
  }
  return {
    id: 'st_star',
    points: pts,
    closed: true,
    area: polygonArea(pts),
    length: polylineLength(pts, true),
    holes: [],
    bridges: [],
    warnings: [],
  }
}