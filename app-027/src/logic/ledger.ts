import { reactive, watch } from 'vue'
import { uid } from './geometry'
import { paperLabel } from '@/data/materials'
import type { Job } from './job'
import type { MaterialPreset, Sheet } from './types'

/**
 * 作业台账（每接一单剪纸记一笔）。
 *
 * 记录分两部分：
 * - auto：上机切割时自动带出（整场刀路总长、段数、纸张/材料、刀压/速度/重复遍数…），多形状多图层按整场合算；
 * - manual：人工补录（实际用纸、工时、废品与废品原因、操作人、客户…）。
 *
 * 生命周期：pending（导出刀路自动记下、待人工确认）→ recorded（已登记）→ archived（归档，不可改，只能更正）
 * 更正：新增 kind='correction' 的记录并写明原因，原记录原样保留；汇总/导出取针对同一笔的最新更正值。
 * 丢弃：仅自动记下的 pending 记录可丢弃（不计入任何汇总，也不参与去重）。
 */

const LS_KEY = 'papercut-plotter-studio/ledger/v1'

export type LedgerStatus = 'pending' | 'recorded' | 'archived' | 'discarded'
export type LedgerKind = 'job' | 'correction'
export type LedgerSource = 'export_auto' | 'manual'

/** 上机切割自动带出的基本情况 */
export type LedgerAuto = {
  /** 整场刀路切割总长（mm，几何长度；多形状 / 多图层 / 批量排版合并计算） */
  cutLengthMm: number
  /** 实际走刀长度（mm，含重复遍数 = cutLengthMm × passes） */
  actualCutMm: number
  /** 整场分成多少段（刀路 run 数） */
  segmentCount: number
  /** 形状数 */
  shapeCount: number
  /** 图层数 */
  layerCount: number
  /** 跳刀总长 mm（辅助参考） */
  travelMm: number
  /** 纸张 key（cardstock / xuan …） */
  paper: string
  /** 纸张中文名 */
  paperLabel: string
  /** 材料（预设名） */
  materialName: string
  /** 垫板 */
  backing: string
  /** 刀压 */
  force: number
  /** 切割速度 mm/s */
  speedMmS: number
  /** 重复遍数 */
  passes: number
  /** 刀补 mm */
  bladeOffsetMm: number
  /** 连刀点宽 mm */
  bridgeWidthMm: number
  /** 纸幅 */
  sheetName: string
  sheetWidthMm: number
  sheetHeightMm: number
  /** 是否批量排版（同一纹样排满） */
  batch: boolean
  batchRows: number
  batchCols: number
  /** 导出刀路格式 */
  exportFormat: string
}

/** 人工补录部分 */
export type LedgerManual = {
  /** 实际用了几张纸 */
  sheetsUsed: number
  /** 花了多少时间（分钟） */
  minutesSpent: number
  /** 废了几张 */
  wasteSheets: number
  /** 为什么废 */
  wasteReason: string
  /** 操作人 */
  operator: string
  /** 客户（客户清单用） */
  customer: string
  note: string
}

export type LedgerEntry = {
  id: string
  kind: LedgerKind
  status: LedgerStatus
  source: LedgerSource
  /** 作业时间（ms，可人工修改） */
  jobAt: number
  recordedAt: number
  archivedAt: number | null
  /** 项目快照：项目删除后台账仍在 */
  projectId: string | null
  projectName: string
  formName: string
  projectDeleted: boolean
  auto: LedgerAuto
  manual: LedgerManual
  /** 去重指纹 */
  fingerprint: string
  /** correction：被更正的原始记录 id */
  rootId: string | null
  /** 更正原因 */
  correctReason: string
  /** 同一次作业重复登记时，强制登记所指向的原记录 + 原因 */
  duplicateOfId: string | null
  duplicateReason: string
  discardReason: string
}

export type LedgerState = {
  entries: LedgerEntry[]
  ready: boolean
  lastError: string | null
}

export const ledgerState = reactive<LedgerState>({
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

export function emptyManual(): LedgerManual {
  return { sheetsUsed: 0, minutesSpent: 0, wasteSheets: 0, wasteReason: '', operator: '', customer: '', note: '' }
}

function defaultAuto(): LedgerAuto {
  return {
    cutLengthMm: 0,
    actualCutMm: 0,
    segmentCount: 0,
    shapeCount: 0,
    layerCount: 0,
    travelMm: 0,
    paper: '',
    paperLabel: '',
    materialName: '',
    backing: '',
    force: 0,
    speedMmS: 0,
    passes: 1,
    bladeOffsetMm: 0,
    bridgeWidthMm: 0,
    sheetName: '',
    sheetWidthMm: 0,
    sheetHeightMm: 0,
    batch: false,
    batchRows: 1,
    batchCols: 1,
    exportFormat: '',
  }
}

function normalizeEntry(e: LedgerEntry): LedgerEntry {
  return {
    id: e.id,
    kind: e.kind ?? 'job',
    status: e.status ?? 'recorded',
    source: e.source ?? 'manual',
    jobAt: e.jobAt ?? e.recordedAt ?? Date.now(),
    recordedAt: e.recordedAt ?? Date.now(),
    archivedAt: e.archivedAt ?? null,
    projectId: e.projectId ?? null,
    projectName: e.projectName ?? '',
    formName: e.formName ?? '',
    projectDeleted: e.projectDeleted ?? false,
    auto: { ...defaultAuto(), ...(e.auto ?? {}) },
    manual: { ...emptyManual(), ...(e.manual ?? {}) },
    fingerprint: e.fingerprint ?? '',
    rootId: e.rootId ?? null,
    correctReason: e.correctReason ?? '',
    duplicateOfId: e.duplicateOfId ?? null,
    duplicateReason: e.duplicateReason ?? '',
    discardReason: e.discardReason ?? '',
  }
}

export function loadLedger(): void {
  if (ledgerState.ready) return
  if (!canUseStorage()) {
    ledgerState.ready = true
    return
  }
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { entries?: LedgerEntry[] }
      if (parsed && Array.isArray(parsed.entries)) ledgerState.entries = parsed.entries.map(normalizeEntry)
    }
  } catch (e) {
    ledgerState.lastError = `台账本地数据读取失败：${(e as Error).message}`
  }
  ledgerState.ready = true
}

export function saveLedgerNow(): void {
  if (!canUseStorage()) return
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, entries: ledgerState.entries }))
  } catch (e) {
    ledgerState.lastError = `台账保存失败：${(e as Error).message}`
  }
}

let saveTimer: number | null = null
let testSuspendSave = false
function scheduleSave(): void {
  if (testSuspendSave) return
  if (saveTimer !== null) return
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    saveLedgerNow()
  }, 250)
}

watch(
  () => ledgerState.entries,
  () => {
    if (ledgerState.ready) scheduleSave()
  },
  { deep: true },
)

// ---------------- 自动带出：从整场切割任务生成快照 ----------------

export type CaptureInput = {
  projectId: string
  projectName: string
  formName: string
  shapeCount: number
  layerCount: number
  batch: boolean
  batchRows: number
  batchCols: number
  job: Job
  material: MaterialPreset
  sheet: Sheet
  bridgeWidthMm: number
  exportFormat: string
}

export function buildAutoSnapshot(input: CaptureInput): LedgerAuto {
  const { job, material } = input
  const cutLengthMm = round3(job.cutLengthMm)
  const passes = Math.max(1, Math.round(material.passes))
  return {
    cutLengthMm,
    actualCutMm: round3(cutLengthMm * passes),
    segmentCount: job.runCount,
    shapeCount: input.shapeCount,
    layerCount: input.layerCount,
    travelMm: round3(job.travelMm),
    paper: material.paper,
    paperLabel: paperLabel(material.paper),
    materialName: material.name,
    backing: material.backing,
    force: material.force,
    speedMmS: material.speedMmS,
    passes,
    bladeOffsetMm: material.bladeOffsetMm,
    bridgeWidthMm: input.bridgeWidthMm,
    sheetName: input.sheet.name,
    sheetWidthMm: input.sheet.widthMm,
    sheetHeightMm: input.sheet.heightMm,
    batch: input.batch,
    batchRows: input.batchRows,
    batchCols: input.batchCols,
    exportFormat: input.exportFormat,
  }
}

/** 去重指纹：同项目（或同名手工单）+ 同纸张/刀压/速度/遍数 + 同总长/段数/形状/图层数 = 同一次作业。不含导出格式（PLT/G-code 互导不算两单）。 */
export function fingerprintOf(
  a: Pick<LedgerEntry, 'projectId' | 'formName'> & { auto: Pick<LedgerAuto, 'cutLengthMm' | 'segmentCount' | 'paper' | 'force' | 'speedMmS' | 'passes' | 'shapeCount' | 'layerCount' | 'batchRows' | 'batchCols'> },
): string {
  return [
    a.projectId ? `p:${a.projectId}` : `free:${a.formName.trim()}`,
    a.auto.paper,
    a.auto.force,
    a.auto.speedMmS,
    a.auto.passes,
    Math.round(a.auto.cutLengthMm * 10) / 10,
    a.auto.segmentCount,
    a.auto.shapeCount,
    a.auto.layerCount,
    a.auto.batchRows,
    a.auto.batchCols,
  ].join('|')
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 同一天内是否已登记过同一次作业（丢弃的不算） */
export function findDuplicate(fp: string, jobAt: number, excludeId?: string): LedgerEntry | null {
  const key = dayKey(jobAt)
  return (
    ledgerState.entries.find(
      (e) =>
        e.kind === 'job' &&
        e.status !== 'discarded' &&
        e.id !== excludeId &&
        e.fingerprint === fp &&
        dayKey(e.jobAt) === key,
    ) ?? null
  )
}

function makeEntry(parts: {
  kind: LedgerKind
  status: LedgerStatus
  source: LedgerSource
  jobAt: number
  projectId: string | null
  projectName: string
  formName: string
  auto: LedgerAuto
  manual: LedgerManual
  rootId?: string | null
  correctReason?: string
  duplicateOfId?: string | null
  duplicateReason?: string
}): LedgerEntry {
  const now = Date.now()
  const e: LedgerEntry = {
    id: uid(parts.kind === 'correction' ? 'lc' : 'j'),
    kind: parts.kind,
    status: parts.status,
    source: parts.source,
    jobAt: parts.jobAt,
    recordedAt: now,
    archivedAt: parts.status === 'archived' ? now : null,
    projectId: parts.projectId,
    projectName: parts.projectName,
    formName: parts.formName,
    projectDeleted: false,
    auto: parts.auto,
    manual: parts.manual,
    fingerprint: '',
    rootId: parts.rootId ?? null,
    correctReason: parts.correctReason ?? '',
    duplicateOfId: parts.duplicateOfId ?? null,
    duplicateReason: parts.duplicateReason ?? '',
    discardReason: '',
  }
  e.fingerprint = fingerprintOf(e)
  return e
}

export type DuplicateResult = { duplicate: LedgerEntry }

/**
 * 导出刀路时自动记一笔（pending，待人工确认或丢弃）。
 * 同一天已登记过同一次作业则拦下（不同格式互导、重复下载都不会再记）。
 */
export function registerExportedJob(input: CaptureInput): { entry: LedgerEntry } | DuplicateResult {
  loadLedger()
  const auto = buildAutoSnapshot(input)
  const jobAt = Date.now()
  const draft = {
    projectId: input.projectId,
    formName: input.formName,
    auto,
  }
  const fp = fingerprintOf(draft)
  const dup = findDuplicate(fp, jobAt)
  if (dup) return { duplicate: dup }
  const entry = makeEntry({
    kind: 'job',
    status: 'pending',
    source: 'export_auto',
    jobAt,
    projectId: input.projectId,
    projectName: input.projectName,
    formName: input.formName,
    auto,
    manual: emptyManual(),
  })
  ledgerState.entries.unshift(entry)
  return { entry }
}

export type NewManualInput = {
  jobAt: number
  projectId: string | null
  projectName: string
  formName: string
  auto: LedgerAuto
  manual: LedgerManual
}

/** 手工登记一笔（直接进入 recorded）；同日重复默认拦下，显式允许并写明原因才可再记。 */
export function createManualEntry(
  input: NewManualInput,
  override?: { allow: boolean; reason: string },
): { entry: LedgerEntry } | DuplicateResult {
  loadLedger()
  const fp = fingerprintOf({ projectId: input.projectId, formName: input.formName, auto: input.auto })
  const dup = findDuplicate(fp, input.jobAt)
  if (dup && !(override?.allow && override.reason.trim())) return { duplicate: dup }
  const entry = makeEntry({
    kind: 'job',
    status: 'recorded',
    source: 'manual',
    jobAt: input.jobAt,
    projectId: input.projectId,
    projectName: input.projectName,
    formName: input.formName,
    auto: input.auto,
    manual: input.manual,
    duplicateOfId: dup ? dup.id : null,
    duplicateReason: dup ? (override?.reason.trim() ?? '') : '',
  })
  ledgerState.entries.unshift(entry)
  return { entry }
}

export class LedgerRuleError extends Error {}

function requireEntry(id: string): LedgerEntry {
  const e = ledgerState.entries.find((x) => x.id === id)
  if (!e) throw new LedgerRuleError('台账记录不存在')
  return e
}

/** 确认自动记下的一笔（补录人工信息后转为已登记） */
export function confirmEntry(id: string, manual: Partial<LedgerManual>): LedgerEntry {
  const e = requireEntry(id)
  if (e.status !== 'pending') throw new LedgerRuleError('只有待确认的记录可以确认')
  Object.assign(e.manual, { ...emptyManual(), ...manual })
  e.status = 'recorded'
  return e
}

/** 丢弃自动记下的一笔（仅 pending；丢弃后不参与汇总与去重） */
export function discardEntry(id: string, reason: string): LedgerEntry {
  const e = requireEntry(id)
  if (e.status !== 'pending') throw new LedgerRuleError('只有待确认的记录可以丢弃')
  e.status = 'discarded'
  e.discardReason = reason.trim()
  return e
}

/** 归档：归档后不可再改 */
export function archiveEntry(id: string): LedgerEntry {
  const e = requireEntry(id)
  if (e.status !== 'recorded') throw new LedgerRuleError('只有已登记的记录可以归档')
  e.status = 'archived'
  e.archivedAt = Date.now()
  return e
}

export type EntryPatch = {
  jobAt?: number
  manual?: Partial<LedgerManual>
  auto?: Partial<LedgerAuto>
}

/** 修改待确认 / 已登记的记录；归档后一律拒绝（只能走更正） */
export function updateEntry(id: string, patch: EntryPatch): LedgerEntry {
  const e = requireEntry(id)
  if (e.status !== 'pending' && e.status !== 'recorded') {
    throw new LedgerRuleError('记录已归档，不允许修改；请新增一条更正记录并写明原因')
  }
  if (patch.jobAt !== undefined) e.jobAt = patch.jobAt
  if (patch.manual) Object.assign(e.manual, patch.manual)
  if (patch.auto) {
    if (e.source !== 'manual') throw new LedgerRuleError('上机自动带出的参数不允许手工修改')
    Object.assign(e.auto, patch.auto)
    e.auto.actualCutMm = round3(e.auto.cutLengthMm * Math.max(1, e.auto.passes))
    e.fingerprint = fingerprintOf(e)
  }
  if (patch.jobAt !== undefined || patch.auto) e.fingerprint = fingerprintOf(e)
  return e
}

export type CorrectionPatch = {
  auto?: Partial<LedgerAuto>
  manual?: Partial<LedgerManual>
}

/** 更正已归档记录：不改原记录，新增一条更正记录并写明原因（更正记录本身归档、不可再改） */
export function addCorrection(rootId: string, patch: CorrectionPatch, reason: string): { entry: LedgerEntry } | { error: string } {
  const root = ledgerState.entries.find((x) => x.id === rootId)
  if (!root) return { error: '被更正的记录不存在' }
  if (root.kind !== 'job') return { error: '只能更正作业记录' }
  if (root.status !== 'archived') return { error: '只有归档后的记录才需要走更正（未归档可直接修改）' }
  if (!reason.trim()) return { error: '更正必须写明原因' }

  const auto: LedgerAuto = { ...root.auto, ...(patch.auto ?? {}) }
  auto.actualCutMm = round3(auto.cutLengthMm * Math.max(1, auto.passes))
  const manual: LedgerManual = { ...emptyManual(), ...root.manual, ...(patch.manual ?? {}) }

  const entry = makeEntry({
    kind: 'correction',
    status: 'archived',
    source: root.source,
    jobAt: root.jobAt,
    projectId: root.projectId,
    projectName: root.projectName,
    formName: root.formName,
    auto,
    manual,
    rootId: root.id,
    correctReason: reason.trim(),
  })
  ledgerState.entries.unshift(entry)
  return { entry }
}

/** 项目（纹样）删除：台账记录保留，仅打标记，仍可查询 */
export function markProjectDeleted(projectId: string): void {
  loadLedger()
  for (const e of ledgerState.entries) {
    if (e.projectId === projectId && !e.projectDeleted) e.projectDeleted = true
  }
}

// ---------------- 查询与汇总 ----------------

export function getEntry(id: string): LedgerEntry | undefined {
  return ledgerState.entries.find((e) => e.id === id)
}

export type EffectiveEntry = {
  /** 当前有效值（有更正则为最新更正的值，否则为原记录） */
  entry: LedgerEntry
  root: LedgerEntry
  correction: LedgerEntry | null
}

/** 针对某条作业记录，取最新一条更正（无则返回 null） */
export function latestCorrectionOf(rootId: string): LedgerEntry | null {
  let latest: LedgerEntry | null = null
  for (const e of ledgerState.entries) {
    if (e.kind !== 'correction' || e.rootId !== rootId) continue
    if (!latest || (e.archivedAt ?? e.recordedAt) > (latest.archivedAt ?? latest.recordedAt)) latest = e
  }
  return latest
}

export function effectiveOf(root: LedgerEntry): EffectiveEntry {
  const correction = latestCorrectionOf(root.id)
  return { entry: correction ?? root, root, correction }
}

/** 作业原记录（不含更正、不含丢弃），pending/recorded/archived */
export function jobRoots(includeDiscarded = false): LedgerEntry[] {
  return ledgerState.entries.filter((e) => e.kind === 'job' && (includeDiscarded || e.status !== 'discarded'))
}

export function correctionsOf(rootId: string): LedgerEntry[] {
  return ledgerState.entries
    .filter((e) => e.kind === 'correction' && e.rootId === rootId)
    .sort((a, b) => (a.archivedAt ?? a.recordedAt) - (b.archivedAt ?? b.recordedAt))
}

export type LedgerFilter = {
  /** YYYY-MM-DD，含 */
  from: string
  to: string
  paper: string
  operator: string
  keyword: string
}

export type LedgerTotals = {
  count: number
  sheetsUsed: number
  wasteSheets: number
  cutMm: number
  actualCutMm: number
  minutes: number
}

export type LedgerGroup = { key: string; label: string; totals: LedgerTotals }

export type LedgerSummary = {
  totals: LedgerTotals
  byPaper: LedgerGroup[]
  byOperator: LedgerGroup[]
  byDay: LedgerGroup[]
  rows: EffectiveEntry[]
}

function emptyTotals(): LedgerTotals {
  return { count: 0, sheetsUsed: 0, wasteSheets: 0, cutMm: 0, actualCutMm: 0, minutes: 0 }
}

function addTotals(t: LedgerTotals, e: LedgerEntry): void {
  t.count += 1
  t.sheetsUsed += num(e.manual.sheetsUsed)
  t.wasteSheets += num(e.manual.wasteSheets)
  t.cutMm += e.auto.cutLengthMm
  t.actualCutMm += e.auto.actualCutMm
  t.minutes += num(e.manual.minutesSpent)
}

function matchesFilter(ef: EffectiveEntry, f: LedgerFilter): boolean {
  const e = ef.entry
  const day = dayKey(e.jobAt)
  if (f.from && day < f.from) return false
  if (f.to && day > f.to) return false
  if (f.paper && e.auto.paper !== f.paper) return false
  if (f.operator && e.manual.operator !== f.operator) return false
  if (f.keyword.trim()) {
    const kw = f.keyword.trim().toLowerCase()
    const hay = `${e.projectName} ${e.formName} ${e.manual.customer} ${e.manual.note} ${e.manual.wasteReason}`.toLowerCase()
    if (!hay.includes(kw)) return false
  }
  return true
}

/** 汇总（按时间段 / 纸张 / 操作人）；只统计已登记与已归档，待确认/丢弃不计 */
export function summarize(filter: LedgerFilter): LedgerSummary {
  loadLedger()
  const rows = jobRoots()
    .map(effectiveOf)
    .filter((ef) => ef.root.status === 'recorded' || ef.root.status === 'archived')
    .filter((ef) => matchesFilter(ef, filter))
    .sort((a, b) => a.entry.jobAt - b.entry.jobAt)

  const totals = emptyTotals()
  const paperMap = new Map<string, LedgerGroup>()
  const opMap = new Map<string, LedgerGroup>()
  const dayMap = new Map<string, LedgerGroup>()

  const bump = (map: Map<string, LedgerGroup>, key: string, label: string, e: LedgerEntry) => {
    let g = map.get(key)
    if (!g) {
      g = { key, label, totals: emptyTotals() }
      map.set(key, g)
    }
    addTotals(g.totals, e)
  }

  for (const ef of rows) {
    const e = ef.entry
    addTotals(totals, e)
    bump(paperMap, e.auto.paper || 'unknown', e.auto.paperLabel || e.auto.paper || '未填', e)
    bump(opMap, e.manual.operator || '', e.manual.operator || '未填操作人', e)
    bump(dayMap, dayKey(e.jobAt), dayKey(e.jobAt), e)
  }

  const byPaper = Array.from(paperMap.values()).sort((a, b) => b.totals.cutMm - a.totals.cutMm)
  const byOperator = Array.from(opMap.values()).sort((a, b) => b.totals.minutes - a.totals.minutes)
  const byDay = Array.from(dayMap.values()).sort((a, b) => (a.key < b.key ? -1 : 1))
  return { totals, byPaper, byOperator, byDay, rows }
}

/** 操作人下拉（历史出现过的） */
export function knownOperators(): string[] {
  const set = new Set<string>()
  for (const e of ledgerState.entries) {
    if (e.manual.operator.trim()) set.add(e.manual.operator.trim())
  }
  return Array.from(set).sort()
}

export function pendingEntries(): LedgerEntry[] {
  return ledgerState.entries.filter((e) => e.kind === 'job' && e.status === 'pending')
}

// ---------------- 工具 ----------------

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** mm → m（保留 3 位小数） */
export function toMeters(mm: number): number {
  return Math.round((mm / 1000) * 1000) / 1000
}

/** 分钟 → 小时（保留 2 位小数） */
export function toHours(min: number): number {
  return Math.round((min / 60) * 100) / 100
}

/** datetime-local 输入框值（本地时区） */
export function toLocalInput(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export function fromLocalInput(s: string): number {
  const t = new Date(s).getTime()
  return Number.isFinite(t) ? t : Date.now()
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export const ledger = {
  state: ledgerState,
  load: loadLedger,
  saveNow: saveLedgerNow,
  buildAutoSnapshot,
  registerExportedJob,
  createManualEntry,
  confirmEntry,
  discardEntry,
  archiveEntry,
  updateEntry,
  addCorrection,
  markProjectDeleted,
  getEntry,
  effectiveOf,
  latestCorrectionOf,
  correctionsOf,
  jobRoots,
  pendingEntries,
  knownOperators,
  summarize,
  findDuplicate,
  fingerprintOf,
}

/** 仅供自检：重置内存台账 */
export function __resetLedgerForTest(entries: LedgerEntry[] = []): void {
  ledgerState.entries = entries
}

/** 仅供自检：快照 / 恢复，避免自检读写用户真实台账（测试期间临时挂起持久化） */
export function __snapshotLedgerForTest(): LedgerEntry[] {
  return ledgerState.entries.slice()
}

export function __restoreLedgerForTest(entries: LedgerEntry[]): void {
  testSuspendSave = true
  ledgerState.entries = entries
  // 恢复后再允许保存
  testSuspendSave = false
}

export function __setLedgerSaveSuspended(v: boolean): void {
  testSuspendSave = v
}

/** 仅供自检：造一笔已归档记录 */
export function __makeEntryForTest(parts: {
  status?: LedgerStatus
  source?: LedgerSource
  jobAt?: number
  projectId?: string | null
  projectName?: string
  formName?: string
  auto?: Partial<LedgerAuto>
  manual?: Partial<LedgerManual>
  fingerprintOverride?: string
}): LedgerEntry {
  const auto: LedgerAuto = {
    ...{
      cutLengthMm: 1000,
      actualCutMm: 1000,
      segmentCount: 10,
      shapeCount: 1,
      layerCount: 1,
      travelMm: 200,
      paper: 'red-paper',
      paperLabel: '红纸（剪纸）',
      materialName: '测试材料',
      backing: '白色软垫板',
      force: 85,
      speedMmS: 50,
      passes: 1,
      bladeOffsetMm: 0.25,
      bridgeWidthMm: 0.5,
      sheetName: 'A4 纵向',
      sheetWidthMm: 210,
      sheetHeightMm: 297,
      batch: false,
      batchRows: 1,
      batchCols: 1,
      exportFormat: 'plt',
    },
    ...(parts.auto ?? {}),
  }
  const entry = makeEntry({
    kind: 'job',
    status: parts.status ?? 'recorded',
    source: parts.source ?? 'manual',
    jobAt: parts.jobAt ?? Date.now(),
    projectId: parts.projectId ?? 'p-test',
    projectName: parts.projectName ?? '测试项目',
    formName: parts.formName ?? '测试纹样',
    auto,
    manual: { ...emptyManual(), ...(parts.manual ?? {}) },
  })
  if (parts.fingerprintOverride) entry.fingerprint = parts.fingerprintOverride
  return entry
}
