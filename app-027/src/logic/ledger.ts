/**
 * 作业台账：每接一单剪纸、每次上机切割记一笔。
 *
 * 规则（规格硬性要求）：
 * - 上机基本情况（整场刀路长度 / 段数 / 纸张材料 / 刀压 / 速度 / 重复遍数，
 *   多形状多图层按整场合起来算）由导出刀路时自动带出，人工补录用纸、工时、废品。
 * - 自动记录先进「待确认」，人工确认后归档，或直接丢弃。
 * - 归档后业务数据一律不可改；要改只能新增一条「更正记录」并写明原因。
 * - 同一次作业（几何 + 材料 + 纸幅 + 排版一致）重复登记会被拦下，确认是补切才可强制登记。
 * - 台账按 projectId 引用纹样项目并冗余项目名；项目删除后台账不消失、仍可查。
 */
import { reactive, watch } from 'vue'
import type { ExportCfg, MaterialPreset, Project } from './types'
import type { Job } from './job'
import { uid } from './geometry'
import { paperLabel } from '@/data/materials'
import { store } from './store'

// ---------------- 数据模型 ----------------

/** 上机自动带出的作业基本情况（整场，多形状 / 多图层已合并） */
export type MachineSnapshot = {
  /** 整场刀路单遍切割总长 mm */
  cutLengthMm: number
  /** 实际走刀总长 = 单遍长度 × 重复遍数 mm */
  totalCutLengthMm: number
  /** 整场刀路段数（合并后） */
  segmentCount: number
  /** 跳刀（抬刀空移）总长 mm */
  travelMm: number
  /** 整场形状数（批量排版按份数计） */
  shapeCount: number
  /** 涉及图层数 */
  layerCount: number
  paper: string
  paperLabel: string
  materialName: string
  backing: string
  /** 刀压 */
  force: number
  /** 切割速度 mm/s */
  speedMmS: number
  /** 重复遍数 */
  passes: number
  bladeOffsetMm: number
  sheetName: string
  sheetWidthMm: number
  sheetHeightMm: number
  scale: number
  format: string
  /** 是否批量排版 */
  batch: boolean
  /** 批量排版份数 */
  batchCopies: number
}

export type LedgerSource = 'auto' | 'manual' | 'correction'

/** 归档前为 pending（待确认 / 可编辑 / 可丢弃）；归档后 archived（业务数据冻结） */
export type LedgerStatus = 'pending' | 'archived'

/** 人工补录的实际作业数据 */
export type LedgerManualData = {
  /** 操作人 */
  operator: string
  /** 客户 / 单号 */
  customer: string
  /** 作业日期 YYYY-MM-DD */
  workDate: string
  /** 实际用纸张数（含废品） */
  sheetsUsed: number
  /** 实际耗时（分钟） */
  workMinutes: number
  /** 废纸张数 */
  wasteCount: number
  /** 废品原因 */
  wasteReason: string
  /** 备注 */
  note: string
}

export type LedgerEntry = {
  id: string
  /** 台账编号 LZ-YYYYMMDD-NNN，归档时按作业日期生成 */
  code: string
  status: LedgerStatus
  source: LedgerSource
  machine: MachineSnapshot
  data: LedgerManualData
  projectId: string
  /** 冗余项目名，项目删除后仍可查 */
  projectNameSnapshot: string
  /** 作业指纹：同一次作业重复登记据此识别 */
  fingerprint: string
  createdAt: number
  archivedAt: number | null
  /** 更正记录指向的原台账 id */
  correctsEntryId: string | null
  /** 更正原因（source = correction 必填） */
  reason: string
  /** 本单已被哪条更正记录取代 */
  supersededByEntryId: string | null
}

export class LedgerError extends Error {
  duplicateOf: LedgerEntry | null
  constructor(message: string, duplicateOf: LedgerEntry | null = null) {
    super(message)
    this.name = 'LedgerError'
    this.duplicateOf = duplicateOf
  }
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000
const round2 = (v: number): number => Math.round(v * 100) / 100

// ---------------- 整场快照 ----------------

/**
 * 从排版任务构造整场作业快照。
 * job 已由 buildJob 把多形状、多图层合并成一场（见 jobOf / buildJob）。
 */
export function buildMachineSnapshot(
  p: Project,
  job: Job,
  material: MaterialPreset,
  isBatch: boolean,
  format: string,
): MachineSnapshot {
  const passes = Math.max(1, Math.round(material.passes))
  const batchCopies = isBatch && p.batch ? Math.max(1, p.batch.rows * p.batch.cols) : 1
  const layers = new Set(job.steps.map((s) => s.shapeLayer))
  return {
    cutLengthMm: round3(job.cutLengthMm),
    totalCutLengthMm: round3(job.cutLengthMm * passes),
    segmentCount: job.runCount,
    travelMm: round2(job.travelMm),
    shapeCount: isBatch ? batchCopies : Object.keys(job.perShape).length,
    layerCount: layers.size,
    paper: material.paper,
    paperLabel: paperLabel(material.paper),
    materialName: material.name,
    backing: material.backing,
    force: material.force,
    speedMmS: material.speedMmS,
    passes,
    bladeOffsetMm: material.bladeOffsetMm,
    sheetName: p.sheet.name,
    sheetWidthMm: p.sheet.widthMm,
    sheetHeightMm: p.sheet.heightMm,
    scale: p.export.scale,
    format,
    batch: isBatch,
    batchCopies,
  }
}

/** djb2 指纹（仅做重复识别，非加密用途） */
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

/**
 * 作业指纹：同一次作业 = 同一项目、几何总长与段数一致、材料参数一致、纸幅缩放排版一致。
 * 不纳入 updatedAt / 项目名，改个名字或重新导出同一份刀路仍算同一次作业。
 */
export function makeFingerprint(p: Project, m: MachineSnapshot): string {
  const b = p.batch
  const batchPart = m.batch && b ? `${b.rows}x${b.cols}:${b.gapXMm},${b.gapYMm}:${b.mode}:${b.sharedEdge ? 1 : 0}` : 'none'
  const parts = [
    p.id,
    Math.round(m.cutLengthMm * 10),
    m.segmentCount,
    m.paper,
    m.force,
    m.speedMmS,
    m.passes,
    m.sheetWidthMm,
    m.sheetHeightMm,
    Math.round(m.scale * 100),
    batchPart,
  ]
  return hash(parts.join('|'))
}

// ---------------- 人工数据校验 ----------------

export function emptyManualData(today = todayStr()): LedgerManualData {
  return { operator: '', customer: '', workDate: today, sheetsUsed: 1, workMinutes: 0, wasteCount: 0, wasteReason: '', note: '' }
}

export function validateManualData(d: LedgerManualData): string[] {
  const errs: string[] = []
  if (!d.operator.trim()) errs.push('操作人不能为空')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.workDate) || Number.isNaN(new Date(d.workDate + 'T00:00:00').getTime()))
    errs.push('作业日期格式应为 YYYY-MM-DD')
  if (!Number.isFinite(d.sheetsUsed) || d.sheetsUsed < 1 || !Number.isInteger(d.sheetsUsed)) errs.push('用纸张数必须是 ≥ 1 的整数')
  if (!Number.isFinite(d.workMinutes) || d.workMinutes <= 0) errs.push('工时必须大于 0 分钟')
  if (!Number.isFinite(d.wasteCount) || d.wasteCount < 0 || !Number.isInteger(d.wasteCount)) errs.push('废纸张数必须是 ≥ 0 的整数')
  if (Number.isInteger(d.sheetsUsed) && Number.isInteger(d.wasteCount) && d.wasteCount > d.sheetsUsed)
    errs.push('废纸张数不能超过用纸总数')
  if (d.wasteCount > 0 && !d.wasteReason.trim()) errs.push('有废品时必须填写废品原因')
  return errs
}

// ---------------- 纯函数：台账操作（数组即账本，便于自检） ----------------

/** 重复识别：pending 或已归档的同指纹作业都算重复；更正记录不参与（它与原单同指纹） */
export function findDuplicate(entries: LedgerEntry[], fingerprint: string): LedgerEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.source !== 'correction' && e.fingerprint === fingerprint) return e
  }
  return null
}

function baseEntry(
  projectId: string,
  projectName: string,
  machine: MachineSnapshot,
  fingerprint: string,
): Omit<LedgerEntry, 'id' | 'code' | 'status' | 'source' | 'data' | 'createdAt' | 'archivedAt'> {
  return { projectId, projectNameSnapshot: projectName, machine, fingerprint, correctsEntryId: null, reason: '', supersededByEntryId: null }
}

/** 导出刀路自动记一条「待确认」；同一次作业已存在则拦下 */
export function capturePending(
  entries: LedgerEntry[],
  p: Project,
  machine: MachineSnapshot,
  fingerprint: string,
): { kind: 'created'; entry: LedgerEntry } | { kind: 'duplicate'; entry: LedgerEntry } {
  const dup = findDuplicate(entries, fingerprint)
  if (dup) return { kind: 'duplicate', entry: dup }
  const entry: LedgerEntry = {
    ...baseEntry(p.id, p.name, machine, fingerprint),
    id: uid('l'),
    code: '',
    status: 'pending',
    source: 'auto',
    data: emptyManualData(),
    createdAt: Date.now(),
    archivedAt: null,
  }
  entries.push(entry)
  return { kind: 'created', entry }
}

/** 待确认记录暂存人工补录（归档前可改） */
export function saveDraft(entries: LedgerEntry[], id: string, patch: Partial<LedgerManualData>): LedgerEntry {
  const e = mustFind(entries, id)
  if (e.status !== 'pending') throw new LedgerError('该记录已归档，不能修改；如需更正请新增更正记录')
  Object.assign(e.data, patch)
  return e
}

/** 确认归档：校验人工数据、生成台账编号，之后冻结 */
export function confirmEntry(entries: LedgerEntry[], id: string, data: LedgerManualData): LedgerEntry {
  const e = mustFind(entries, id)
  if (e.status !== 'pending') throw new LedgerError('该记录已归档，不能重复确认')
  const errs = validateManualData(data)
  if (errs.length) throw new LedgerError(errs[0])
  e.data = normalizeData(data)
  e.status = 'archived'
  e.archivedAt = Date.now()
  e.code = nextCode(entries, e.data.workDate)
  return e
}

/** 丢弃待确认记录（只有 pending 能丢弃，归档记录无法删除） */
export function discardEntry(entries: LedgerEntry[], id: string): void {
  const e = mustFind(entries, id)
  if (e.status !== 'pending') throw new LedgerError('已归档记录不能丢弃')
  const i = entries.findIndex((x) => x.id === id)
  entries.splice(i, 1)
}

/** 手工登记：从当前项目带出机台数据后直接归档；指纹重复默认拦下，force 用于确认是补切等情形 */
export function registerManual(
  entries: LedgerEntry[],
  p: Project,
  machine: MachineSnapshot,
  fingerprint: string,
  data: LedgerManualData,
  force = false,
): LedgerEntry {
  const errs = validateManualData(data)
  if (errs.length) throw new LedgerError(errs[0])
  const dup = findDuplicate(entries, fingerprint)
  if (dup && !force) {
    throw new LedgerError(`与台账${dup.code ? `编号 ${dup.code}` : '待确认记录'}是同一次作业（刀路总长、段数、材料与纸幅一致），重复登记已拦下；若确属补切，请勾选强制登记`, dup)
  }
  const entry: LedgerEntry = {
    ...baseEntry(p.id, p.name, machine, fingerprint),
    id: uid('l'),
    code: '',
    status: 'archived',
    source: 'manual',
    data: normalizeData(data),
    createdAt: Date.now(),
    archivedAt: Date.now(),
  }
  entry.code = nextCode(entries, entry.data.workDate)
  entries.push(entry)
  return entry
}

/**
 * 更正：不动原单业务数据，只新增一条 archived 的更正记录并写明原因；
 * 原单标记 supersededByEntryId，汇总 / 客户清单只认更正后的新单。
 */
export function correctEntry(
  entries: LedgerEntry[],
  id: string,
  data: LedgerManualData,
  reason: string,
): LedgerEntry {
  const src = mustFind(entries, id)
  if (src.status !== 'archived') throw new LedgerError('只能更正已归档记录')
  if (src.supersededByEntryId) throw new LedgerError('该单已被更正，请对最新的更正单再做更正')
  if (!reason.trim()) throw new LedgerError('更正必须写明原因')
  const errs = validateManualData(data)
  if (errs.length) throw new LedgerError(errs[0])
  const entry: LedgerEntry = {
    id: uid('l'),
    code: '',
    status: 'archived',
    source: 'correction',
    machine: structuredClone(src.machine),
    data: normalizeData(data),
    projectId: src.projectId,
    projectNameSnapshot: src.projectNameSnapshot,
    fingerprint: src.fingerprint,
    createdAt: Date.now(),
    archivedAt: Date.now(),
    correctsEntryId: src.id,
    reason: reason.trim(),
    supersededByEntryId: null,
  }
  entry.code = nextCode(entries, entry.data.workDate)
  entries.push(entry)
  src.supersededByEntryId = entry.id
  return entry
}

function mustFind(entries: LedgerEntry[], id: string): LedgerEntry {
  const e = entries.find((x) => x.id === id)
  if (!e) throw new LedgerError('台账记录不存在')
  return e
}

function normalizeData(d: LedgerManualData): LedgerManualData {
  return {
    operator: d.operator.trim(),
    customer: d.customer.trim(),
    workDate: d.workDate,
    sheetsUsed: Math.round(d.sheetsUsed),
    workMinutes: Math.round(d.workMinutes * 10) / 10,
    wasteCount: Math.round(d.wasteCount),
    wasteReason: d.wasteReason.trim(),
    note: d.note.trim(),
  }
}

/** 台账编号：LZ-作业日期-当日序号 */
export function nextCode(entries: LedgerEntry[], date: string): string {
  const ymd = date.replace(/-/g, '')
  const prefix = `LZ-${ymd}-`
  const n = entries.reduce((a, e) => a + (e.code.startsWith(prefix) ? 1 : 0), 0) + 1
  return `${prefix}${String(n).padStart(3, '0')}`
}

export function todayStr(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------------- 查询 / 汇总 ----------------

export type LedgerFilter = {
  dateFrom: string
  dateTo: string
  paper: string // '' = 全部
  operator: string // '' = 全部
  keyword: string
}

export const EMPTY_FILTER: LedgerFilter = { dateFrom: '', dateTo: '', paper: '', operator: '', keyword: '' }

/** 参与汇总 / 客户清单的有效记录：已归档且未被更正取代 */
export function effectiveEntries(entries: LedgerEntry[], f: LedgerFilter = EMPTY_FILTER): LedgerEntry[] {
  const kw = f.keyword.trim().toLowerCase()
  return entries
    .filter((e) => e.status === 'archived' && !e.supersededByEntryId)
    .filter((e) => (f.dateFrom ? e.data.workDate >= f.dateFrom : true))
    .filter((e) => (f.dateTo ? e.data.workDate <= f.dateTo : true))
    .filter((e) => (f.paper ? e.machine.paper === f.paper : true))
    .filter((e) => (f.operator ? e.data.operator === f.operator : true))
    .filter((e) => {
      if (!kw) return true
      return [e.code, e.data.customer, e.projectNameSnapshot, e.data.operator].some((s) => s.toLowerCase().includes(kw))
    })
    .sort((a, b) => (a.data.workDate === b.data.workDate ? a.code.localeCompare(b.code) : a.data.workDate.localeCompare(b.data.workDate)))
}

export type LedgerSummaryRow = {
  key: string
  label: string
  jobs: number
  sheets: number
  goodSheets: number
  waste: number
  cutMeters: number
  workHours: number
}

export type LedgerGroupBy = 'none' | 'paper' | 'operator' | 'customer' | 'date'

function emptyRow(key: string, label: string): LedgerSummaryRow {
  return { key, label, jobs: 0, sheets: 0, goodSheets: 0, waste: 0, cutMeters: 0, workHours: 0 }
}

function addInto(row: LedgerSummaryRow, e: LedgerEntry): void {
  row.jobs += 1
  row.sheets += e.data.sheetsUsed
  row.goodSheets += e.data.sheetsUsed - e.data.wasteCount
  row.waste += e.data.wasteCount
  row.cutMeters += e.machine.totalCutLengthMm / 1000
  row.workHours += e.data.workMinutes / 60
}

function finalize(rows: LedgerSummaryRow[]): LedgerSummaryRow[] {
  for (const r of rows) {
    r.cutMeters = Math.round(r.cutMeters * 1000) / 1000
    r.workHours = Math.round(r.workHours * 100) / 100
  }
  return rows
}

export function summarize(entries: LedgerEntry[], f: LedgerFilter, groupBy: LedgerGroupBy): { rows: LedgerSummaryRow[]; total: LedgerSummaryRow } {
  const list = effectiveEntries(entries, f)
  const map = new Map<string, LedgerSummaryRow>()
  const total = emptyRow('__total__', '合计')
  for (const e of list) {
    addInto(total, e)
    let key: string
    let label: string
    if (groupBy === 'paper') {
      key = e.machine.paper
      label = e.machine.paperLabel
    } else if (groupBy === 'operator') {
      key = label = e.data.operator
    } else if (groupBy === 'customer') {
      key = label = e.data.customer || '（散客 / 未填）'
    } else if (groupBy === 'date') {
      key = label = e.data.workDate
    } else {
      key = label = '全部作业'
    }
    let row = map.get(key)
    if (!row) {
      row = emptyRow(key, label)
      map.set(key, row)
    }
    addInto(row, e)
  }
  finalize([total, ...map.values()])
  const rows = Array.from(map.values()).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  return { rows, total }
}

/** 客户清单逐行数据（有效记录） */
export type CustomerReportRow = {
  code: string
  date: string
  project: string
  customer: string
  paper: string
  cutMeters: number
  segments: number
  force: number
  speed: number
  passes: number
  sheets: number
  goodSheets: number
  waste: number
  wasteReason: string
  workHours: number
  operator: string
  note: string
}

export function customerReportRows(entries: LedgerEntry[], f: LedgerFilter): CustomerReportRow[] {
  return effectiveEntries(entries, f).map((e) => ({
    code: e.code,
    date: e.data.workDate,
    project: e.projectNameSnapshot,
    customer: e.data.customer,
    paper: e.machine.paperLabel,
    cutMeters: Math.round((e.machine.totalCutLengthMm / 1000) * 1000) / 1000,
    segments: e.machine.segmentCount,
    force: e.machine.force,
    speed: e.machine.speedMmS,
    passes: e.machine.passes,
    sheets: e.data.sheetsUsed,
    goodSheets: e.data.sheetsUsed - e.data.wasteCount,
    waste: e.data.wasteCount,
    wasteReason: e.data.wasteReason,
    workHours: Math.round((e.data.workMinutes / 60) * 100) / 100,
    operator: e.data.operator,
    note: e.data.note,
  }))
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 导出客户清单 CSV（带 BOM，Excel 直接打开不乱码） */
export function customerReportCsv(entries: LedgerEntry[], f: LedgerFilter): string {
  const rows = customerReportRows(entries, f)
  const head = ['台账编号', '作业日期', '纹样项目', '客户/单号', '纸张', '刀路(米)', '段数', '刀压', '速度(mm/s)', '遍数', '用纸(张)', '成品(张)', '废品(张)', '废品原因', '工时(小时)', '操作人', '备注']
  const lines = [head.map(csvCell).join(',')]
  for (const r of rows) {
    lines.push(
      [r.code, r.date, r.project, r.customer, r.paper, r.cutMeters, r.segments, r.force, r.speed, r.passes, r.sheets, r.goodSheets, r.waste, r.wasteReason, r.workHours, r.operator, r.note]
        .map(csvCell)
        .join(','),
    )
  }
  const t = summarize(entries, f, 'none').total
  lines.push(['合计', '', '', '', '', t.cutMeters, '', '', '', '', t.sheets, t.goodSheets, t.waste, '', t.workHours, '', ''].map(csvCell).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

// ---------------- 持久化状态 ----------------

const LS_KEY = 'papercut-plotter-studio/ledger/v1'

type Persisted = { version: number; entries: LedgerEntry[] }

export const ledgerState = reactive<{ entries: LedgerEntry[]; ready: boolean; lastError: string | null }>({
  entries: [],
  ready: false,
  lastError: null,
})

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

function normalizeEntry(e: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: e.id ?? uid('l'),
    code: e.code ?? '',
    status: e.status === 'archived' ? 'archived' : 'pending',
    source: e.source === 'manual' || e.source === 'correction' ? e.source : 'auto',
    machine: { ...(e.machine as MachineSnapshot) },
    data: { ...emptyManualData(), ...(e.data ?? {}) },
    projectId: e.projectId ?? '',
    projectNameSnapshot: e.projectNameSnapshot ?? '（已删除纹样）',
    fingerprint: e.fingerprint ?? '',
    createdAt: e.createdAt ?? Date.now(),
    archivedAt: e.archivedAt ?? null,
    correctsEntryId: e.correctsEntryId ?? null,
    reason: e.reason ?? '',
    supersededByEntryId: e.supersededByEntryId ?? null,
  }
}

export function loadLedger(): void {
  if (ledgerState.ready) return
  if (canUseStorage()) {
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Persisted
        if (parsed && Array.isArray(parsed.entries)) ledgerState.entries = parsed.entries.map(normalizeEntry)
      }
    } catch (e) {
      ledgerState.lastError = `台账本地数据读取失败：${(e as Error).message}`
    }
  }
  ledgerState.ready = true
}

let saveTimer: number | null = null
function persist(): void {
  if (!canUseStorage()) return
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      const data: Persisted = { version: 1, entries: ledgerState.entries }
      localStorage.setItem(LS_KEY, JSON.stringify(data))
    } catch (e) {
      ledgerState.lastError = `台账保存失败：${(e as Error).message}`
    }
  }, 250)
}

watch(
  () => ledgerState.entries,
  () => {
    if (ledgerState.ready) persist()
  },
  { deep: true },
)

// ---------------- 对外业务 API（接项目库 store，自动带整场快照） ----------------

function snapshotOf(projectId: string, format: string): { p: Project; machine: MachineSnapshot; fingerprint: string } | null {
  const p = store.getProject(projectId)
  if (!p) return null
  const { job, isBatch } = store.jobOf(p)
  if (job.runCount === 0) return null
  const material = store.materialOf(p)
  if (!material) return null
  const machine = buildMachineSnapshot(p, job, material, isBatch, format)
  return { p, machine, fingerprint: makeFingerprint(p, machine) }
}

/** 导出刀路时调用：自动记一条待确认；同一次作业重复导出则拦下 */
export function captureFromExport(
  projectId: string,
  format: ExportCfg['format'],
): { kind: 'created'; entry: LedgerEntry } | { kind: 'duplicate'; entry: LedgerEntry } | null {
  loadLedger()
  const snap = snapshotOf(projectId, format.toUpperCase())
  if (!snap) return null
  const res = capturePending(ledgerState.entries, snap.p, snap.machine, snap.fingerprint)
  return res
}

export function confirmLedgerEntry(id: string, data: LedgerManualData): LedgerEntry {
  loadLedger()
  const e = confirmEntry(ledgerState.entries, id, data)
  persist()
  return e
}

export function discardLedgerEntry(id: string): void {
  loadLedger()
  discardEntry(ledgerState.entries, id)
  persist()
}

export function saveLedgerDraft(id: string, patch: Partial<LedgerManualData>): void {
  loadLedger()
  saveDraft(ledgerState.entries, id, patch)
}

export function registerManualEntry(projectId: string, data: LedgerManualData, force = false): LedgerEntry {
  loadLedger()
  const snap = snapshotOf(projectId, '手工登记')
  if (!snap) throw new LedgerError('纹样项目不存在或没有可切割的刀路，无法带出作业数据')
  return registerManual(ledgerState.entries, snap.p, snap.machine, snap.fingerprint, data, force)
}

export function correctLedgerEntry(id: string, data: LedgerManualData, reason: string): LedgerEntry {
  loadLedger()
  const e = correctEntry(ledgerState.entries, id, data, reason)
  persist()
  return e
}

export function projectExists(projectId: string): boolean {
  return !!store.getProject(projectId)
}

export const ledger = {
  state: ledgerState,
  load: loadLedger,
  captureFromExport,
  confirm: confirmLedgerEntry,
  discard: discardLedgerEntry,
  saveDraft: saveLedgerDraft,
  registerManual: registerManualEntry,
  correct: correctLedgerEntry,
}
