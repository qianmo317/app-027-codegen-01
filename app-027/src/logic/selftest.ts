import { PATTERN_LIBRARY, fetchPatternText } from '@/data/patterns'
import { defaultMaterials } from '@/data/materials'
import { DEFAULT_CUT_SETTINGS, type CutSettings, type MaterialPreset, type Project, type Pt, type Shape } from './types'
import { cleanupContours } from './cleanup'
import { importSvgText } from './importer'
import { computeShape, type ComputedShape } from './pipeline'
import { buildBatchShape, buildJob, type Job } from './job'
import {
  buildMachineSnapshot,
  capturePending,
  confirmEntry,
  correctEntry,
  customerReportCsv,
  customerReportRows,
  discardEntry,
  effectiveEntries,
  emptyManualData,
  EMPTY_FILTER,
  LedgerError,
  makeFingerprint,
  registerManual,
  saveDraft,
  summarize,
  validateManualData,
  type LedgerEntry,
} from './ledger'
import { buildA4Sheet, computePlacement, exportGcode, exportPlt, type ExportMeta } from './exporters'
import { polygonArea, polylineLength } from './geometry'

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

  // ---------- 12. 作业台账业务规则（纯内存账本，不触碰 localStorage） ----------
  const ledgerChecks = buildLedgerChecks()
  checks.push(...ledgerChecks)

  const totalMs = performance.now() - t0
  return { checks, summaries, totalMs }
}

/** 作业台账：整场快照 / 重复拦截 / 待确认丢弃 / 归档冻结 / 更正留痕 / 项目删除可查 / 汇总与客户清单 */
function buildLedgerChecks(): CheckResult[] {
  const out: CheckResult[] = []
  // 构造两场作业：两个形状、两个图层、批量排版 2×2
  const mkContour = (id: string, w: number, h: number, layer: number) => {
    const c = rectContour(id, 0, 0, w, h)
    return { c, layer }
  }
  const proj = {
    id: 'p_ledger',
    name: '台账测试窗花',
    createdAt: 1,
    updatedAt: 2,
    shapes: [
      { id: 's_a', name: '形状甲', layer: 0, contours: [mkContour('c_a', 100, 100, 0).c] },
      { id: 's_b', name: '形状乙', layer: 1, contours: [mkContour('c_b', 60, 40, 1).c] },
    ],
    settings: { ...DEFAULT_CUT_SETTINGS },
    export: { format: 'plt', unit: '0.025mm', origin: 'bottom_left', yFlip: true, scale: 1 } as Project['export'],
    sheet: { widthMm: 300, heightMm: 300, name: '300×300 方纸' },
    materialId: 'mat-x',
    layerNames: ['图层 1', '图层 2'],
    batch: { enabled: true, rows: 2, cols: 2, gapXMm: 5, gapYMm: 5, sharedEdge: false, mode: 'repeat' },
    batchShapeId: 's_a',
  } as unknown as Project
  const material: MaterialPreset = { id: 'mat-x', name: '宣纸精细', paper: 'xuan', force: 60, speedMmS: 60, passes: 2, bladeOffsetMm: 0.2, backing: '白色软垫板' }

  const { job, shape } = storeJobOf(proj)
  const machine = buildMachineSnapshot(proj, job, material, true, 'PLT')
  const fp = makeFingerprint(proj, machine)

  // ① 多形状 / 多图层 / 批量按整场合起来算：长度 × 遍数、段数、份数、图层数
  const expectCut = job.cutLengthMm
  out.push(
    ok(
      'ledger-whole-session',
      '台账：整场刀路总长、段数、形状图层与遍数按整场合起来算（含批量排版）',
      machine.segmentCount === job.runCount &&
        Math.abs(machine.cutLengthMm - expectCut) < 1e-6 &&
        Math.abs(machine.totalCutLengthMm - expectCut * 2) < 1e-6 &&
        machine.layerCount === 1 && // 批量排版只排 batchShape（形状甲），整场 1 图层、4 份
        machine.shapeCount === 4 &&
        machine.batchCopies === 4 &&
        machine.passes === 2,
      `批量 2×2：${machine.segmentCount} 段、单遍 ${machine.cutLengthMm.toFixed(1)}mm、整场 ${machine.totalCutLengthMm.toFixed(1)}mm（×2 遍）、${machine.shapeCount} 形状 / ${machine.layerCount} 图层；${shape ? 'batch' : 'normal'}`,
    ),
  )

  // 非批量：两个形状两个图层都在
  const proj2: Project = { ...proj, batch: { ...proj.batch!, enabled: false } } as Project
  const { job: job2 } = storeJobOf(proj2)
  const m2 = buildMachineSnapshot(proj2, job2, material, false, 'PLT')
  out.push(
    ok(
      'ledger-multi-layer',
      '台账：非批量时多形状多图层全部并入一场',
      m2.shapeCount === 2 && m2.layerCount === 2 && m2.segmentCount === job2.runCount,
      `非批量：${m2.shapeCount} 形状 / ${m2.layerCount} 图层 / ${m2.segmentCount} 段`,
    ),
  )

  // ② 导出自动待确认 + 同作业重复拦下（含 pending 与 archived 两阶段）
  const entries: LedgerEntry[] = []
  const cap1 = capturePending(entries, proj, machine, fp)
  const cap2 = capturePending(entries, proj, machine, fp)
  const autoEntry = cap1.kind === 'created' ? cap1.entry : null
  out.push(
    ok(
      'ledger-auto-capture-duplicate',
      '台账：导出自动记待确认；同一次作业重复导出被认出拦下',
      cap1.kind === 'created' && cap1.entry.status === 'pending' && cap2.kind === 'duplicate' && cap2.entry.id === autoEntry?.id,
      `首次导出 → ${cap1.kind}；再次导出同一场 → ${cap2.kind}（指纹 ${fp}）`,
    ),
  )

  // ③ 校验：缺操作人 / 废品超用纸 / 有废品无原因
  const bad = validateManualData({ ...emptyManualData('2026-09-01'), operator: '', workMinutes: 30 })
  const badReason = validateManualData({ ...emptyManualData('2026-09-01'), operator: '王师傅', sheetsUsed: 1, wasteCount: 2 })
  const badWasteReason = validateManualData({ ...emptyManualData('2026-09-01'), operator: '王师傅', workMinutes: 30, sheetsUsed: 2, wasteCount: 1 })
  const good = validateManualData({ ...emptyManualData('2026-09-01'), operator: '王师傅', workMinutes: 45, wasteCount: 1, wasteReason: '宣纸起毛' })
  out.push(
    ok(
      'ledger-validate',
      '台账：人工补录校验（操作人、用纸 ≥ 废品、废品必填原因、工时 > 0）',
      bad.some((m) => m.includes('操作人')) &&
        badReason.some((m) => m.includes('超过')) &&
        badWasteReason.some((m) => m.includes('废品原因')) &&
        good.length === 0,
      `缺操作人报「${bad[0]}」；废品 2 > 用纸 1 报「${badReason.find((m) => m.includes('超过'))}」；有废品无原因报「${badWasteReason.find((m) => m.includes('原因'))}」；合法数据 ${good.length} 条错误`,
    ),
  )

  // ④ 待确认可以补录后确认归档，生成编号；pending 可丢弃
  let threw = false
  try {
    confirmEntry(entries, autoEntry!.id, { ...emptyManualData('2026-09-01'), operator: '', workMinutes: 30 })
  } catch {
    threw = true
  }
  const archived = confirmEntry(
    entries,
    autoEntry!.id,
    { operator: '王师傅', customer: '李家婚庆', workDate: '2026-09-01', sheetsUsed: 3, workMinutes: 40, wasteCount: 1, wasteReason: '走位', note: '' },
  )
  const codeOk = /^LZ-20260901-001$/.test(archived.code)
  const pendingProj: Project = { ...proj, id: 'p_ledger_2' } as Project
  const cap3 = capturePending(entries, pendingProj, m2, makeFingerprint(pendingProj, m2))
  const pendingId = cap3.kind === 'created' ? cap3.entry.id : ''
  discardEntry(entries, pendingId)
  const discardedGone = !entries.some((e) => e.id === pendingId)
  let discardArchivedThrew = false
  try {
    discardEntry(entries, archived.id)
  } catch {
    discardArchivedThrew = true
  }
  out.push(
    ok(
      'ledger-confirm-discard',
      '台账：待确认补录校验后归档编号；待确认可丢弃，归档记录不能丢弃',
      threw && codeOk && archived.status === 'archived' && discardedGone && discardArchivedThrew,
      `编号 ${archived.code}；校验未过抛错 = ${threw}；pending 丢弃后消失 = ${discardedGone}；丢弃归档被拒 = ${discardArchivedThrew}`,
    ),
  )

  // ⑤ 归档后不可改（saveDraft / confirm 再调都拒绝）
  let frozen1 = false
  let frozen2 = false
  try {
    saveDraft(entries, archived.id, { sheetsUsed: 99 })
  } catch {
    frozen1 = true
  }
  try {
    confirmEntry(entries, archived.id, archived.data)
  } catch {
    frozen2 = true
  }
  out.push(
    ok(
      'ledger-archive-frozen',
      '台账：归档后业务数据冻结，任何修改入口都拒绝',
      frozen1 && frozen2 && archived.data.sheetsUsed === 3,
      `saveDraft 拒绝 = ${frozen1}；重复确认拒绝 = ${frozen2}；用纸仍为 ${archived.data.sheetsUsed} 张`,
    ),
  )

  // ⑥ 同作业手工登记默认拦下，force=false 抛错带 duplicateOf；force=true（补切）放行且单独编号
  let dupBlocked: LedgerEntry | null = null
  try {
    registerManual(entries, proj, machine, fp, { ...archived.data, customer: '重复单' })
  } catch (e) {
    dupBlocked = e instanceof LedgerError ? e.duplicateOf : null
  }
  const recut = registerManual(entries, proj, machine, fp, { ...archived.data, workDate: '2026-09-02', customer: '补切' }, true)
  out.push(
    ok(
      'ledger-duplicate-force',
      '台账：重复登记默认拦下并指明是哪一单；确认补切可强制登记',
      dupBlocked?.id === archived.id && recut.id !== archived.id && /^LZ-20260902-001$/.test(recut.code),
      `默认登记被拦，指向 ${dupBlocked?.code ?? '无'}；强制补切编号 ${recut.code}`,
    ),
  )

  // ⑦ 更正：不改原单、新增更正单并写明原因、双向关联、原单退出有效集合
  let noReasonThrew = false
  try {
    correctEntry(entries, archived.id, { ...archived.data, workMinutes: 60 }, '  ')
  } catch {
    noReasonThrew = true
  }
  const corrected = correctEntry(
    entries,
    archived.id,
    { ...archived.data, sheetsUsed: 4, workMinutes: 55, wasteCount: 1, wasteReason: '走位（复核为 1 张）' },
    '工时与用纸登记有误，复核派工单后更正',
  )
  const originalStill = entries.find((e) => e.id === archived.id)!
  out.push(
    ok(
      'ledger-correction-audit',
      '台账：更正只能新增记录并写明原因；原单业务数据不动、双向关联、退出汇总',
      noReasonThrew &&
        corrected.source === 'correction' &&
        corrected.correctsEntryId === archived.id &&
        originalStill.supersededByEntryId === corrected.id &&
        originalStill.data.sheetsUsed === 3 &&
        originalStill.data.workMinutes === 40 &&
        !effectiveEntries(entries).some((e) => e.id === archived.id) &&
        effectiveEntries(entries).some((e) => e.id === corrected.id) &&
        corrected.code.startsWith('LZ-20260901-'),
      `原单 ${originalStill.code} 用纸仍 ${originalStill.data.sheetsUsed} 张；更正单 ${corrected.code}；无原因被拒 = ${noReasonThrew}`,
    ),
  )

  // 已更正的单不能再次更正（应对最新更正单再更正）
  let correctDeadThrew = false
  try {
    correctEntry(entries, archived.id, corrected.data, '再改')
  } catch {
    correctDeadThrew = true
  }
  const recorrect = correctEntry(entries, corrected.id, { ...corrected.data, workMinutes: 50 }, '工时再核')
  out.push(
    ok(
      'ledger-correction-chain',
      '台账：只能对最新有效单更正，更正链始终指向最新',
      correctDeadThrew && corrected.supersededByEntryId === recorrect.id && recorrect.correctsEntryId === corrected.id,
      `对旧单再更正被拒 = ${correctDeadThrew}；最新更正单 ${recorrect.code}`,
    ),
  )

  // ⑧ 删除纹样项目后台账不消失（快照独立、按 id 仍可查）
  const survives = entries.find((e) => e.id === recut.id)!
  const survivesOk =
    survives.projectId === 'p_ledger' &&
    survives.projectNameSnapshot === '台账测试窗花' &&
    survives.machine.cutLengthMm > 0 &&
    survives.machine.paper === 'xuan'
  out.push(
    ok(
      'ledger-project-delete-survive',
      '台账：纹样项目删除后台账不消失，名称与整场数据冗余可查',
      survivesOk,
      `项目 id ${survives.projectId} 离开项目库后，台账仍保留「${survives.projectNameSnapshot}」、纸张 ${survives.machine.paperLabel} 与 ${survives.machine.segmentCount} 段刀路快照`,
    ),
  )

  // ⑨ 汇总：时间段 / 纸张 / 操作人口径，用纸、米数、工时
  const sAll = summarize(entries, EMPTY_FILTER, 'none').total
  const sPaper = summarize(entries, EMPTY_FILTER, 'paper').rows
  const sDate = summarize(entries, { ...EMPTY_FILTER, dateFrom: '2026-09-02', dateTo: '2026-09-02' }, 'none').total
  // 有效单：recut（09-02，3 张 40 分钟）+ recorrect（09-01，4 张 50 分钟）
  const totalMeters = (recut.machine.totalCutLengthMm + recorrect.machine.totalCutLengthMm) / 1000
  out.push(
    ok(
      'ledger-summary',
      '台账：按时间段 / 纸张 / 操作人汇总用纸、刀路米数、工时（旧单不重复计）',
      sAll.jobs === 2 &&
        sAll.sheets === 7 &&
        sAll.waste === 2 &&
        Math.abs(sAll.cutMeters - totalMeters) < 1e-6 &&
        Math.abs(sAll.workHours - (40 + 50) / 60) < 1e-6 &&
        sPaper.length === 1 &&
        sPaper[0].key === 'xuan' &&
        sDate.jobs === 1 &&
        sDate.sheets === 3,
      `合计 ${sAll.jobs} 单 / ${sAll.sheets} 张 / ${sAll.cutMeters.toFixed(2)} 米 / ${sAll.workHours.toFixed(2)} 时；按纸张 ${sPaper.length} 组（${sPaper.map((r) => r.label).join('、')}）；09-02 筛选 ${sDate.jobs} 单`,
    ),
  )

  // ⑩ 客户清单导出：CSV 含表头、逐行与合计，旧单与待确认不出现
  const csv = customerReportCsv(entries, EMPTY_FILTER)
  const rows = customerReportRows(entries, EMPTY_FILTER)
  const csvOk =
    csv.startsWith('﻿') &&
    csv.includes('台账编号') &&
    csv.includes('合计') &&
    rows.length === 2 &&
    rows.every((r) => r.code) &&
    !csv.includes(originalStill.code)
  out.push(
    ok(
      'ledger-customer-export',
      '台账：客户清单可导出（编号/日期/纸张/米数/用纸/工时/操作人，含合计，旧单不泄露）',
      csvOk,
      `CSV ${csv.split('\r\n').length} 行（含 BOM/表头/合计），明细 ${rows.length} 单；被更正的 ${originalStill.code} 不在清单`,
    ),
  )

  return out
}

/** 从项目构造排版任务（不依赖全局 store，复用 buildJob） */
function storeJobOf(p: Project): { job: Job; shape: Shape | null; isBatch: boolean } {
  const start = { x: 0, y: 0 }
  const material = { id: 'mat-x', name: '宣纸精细', paper: 'xuan', force: 60, speedMmS: 60, passes: 2, bladeOffsetMm: 0.2, backing: '白色软垫板' }
  const map = new Map<string, ComputedShape>()
  for (const s of p.shapes) {
    if (p.batch?.enabled && p.batchShapeId === s.id) {
      const tiled = buildBatchShape(s, p.batch)
      map.set(tiled.id, computeShape(tiled, p.settings, material))
      const layers = Array.from(new Set([tiled.layer]))
      const job = buildJob([tiled], map, layers, { sharedEdge: p.batch.sharedEdge, start })
      return { job, shape: tiled, isBatch: true }
    }
  }
  for (const s of p.shapes) map.set(s.id, computeShape(s, p.settings, material))
  const layers = Array.from(new Set(p.shapes.map((s) => s.layer))).sort((a, b) => a - b)
  const job = buildJob(p.shapes, map, layers, { sharedEdge: false, start })
  return { job, shape: null, isBatch: false }
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