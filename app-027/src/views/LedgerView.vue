<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { store } from '@/logic/store'
import {
  ledger,
  confirmEntry,
  discardEntry,
  archiveEntry,
  effectiveOf,
  updateEntry,
  correctionsOf,
  jobRoots,
  pendingEntries,
  knownOperators,
  toMeters,
  toHours,
  fmtDateTime,
  dayKey,
  type EffectiveEntry,
  type LedgerEntry,
  type LedgerFilter,
} from '@/logic/ledger'
import { buildCustomerReportHtml, buildInternalCsv, customerReportFilename, internalCsvFilename } from '@/logic/ledgerExport'
import { downloadText } from '@/logic/download'
import { PAPER_KINDS } from '@/logic/types'
import LedgerEntryEditor, { type EditorInitial } from '@/components/LedgerEntryEditor.vue'

const route = useRoute()
const router = useRouter()

onMounted(() => {
  store.loadState()
  ledger.load()
  handleRoute()
})

watch(
  () => route.query,
  () => handleRoute(),
)

// ---------------- 编辑器弹层 ----------------
const editorOpen = ref(false)
const editorMode = ref<'create' | 'edit' | 'correct'>('create')
const editingEntry = ref<LedgerEntry | null>(null)
const createInitial = ref<EditorInitial | null>(null)

function buildInitialForProject(projectId: string): EditorInitial | null {
  const p = store.getProject(projectId)
  if (!p) return null
  const d = store.jobOf(p)
  const m = store.materialOf(p)
  if (!m) return null
  return {
    projectId: p.id,
    projectName: p.name,
    formName: (d.isBatch && d.shape ? [d.shape] : p.shapes).map((s) => s.name).join('、'),
    auto: ledger.buildAutoSnapshot({
      projectId: p.id,
      projectName: p.name,
      formName: (d.isBatch && d.shape ? [d.shape] : p.shapes).map((s) => s.name).join('、'),
      shapeCount: d.isBatch && d.shape ? 1 : p.shapes.length,
      layerCount: store.layerOrderOf(p).length,
      batch: d.isBatch && !!p.batch?.enabled,
      batchRows: p.batch?.rows ?? 1,
      batchCols: p.batch?.cols ?? 1,
      job: d.job,
      material: m,
      sheet: p.sheet,
      bridgeWidthMm: p.settings.bridgeWidthMm,
      exportFormat: '',
    }),
  }
}

function handleRoute(): void {
  if (editorOpen.value) return
  const q = route.query
  if (q.new === '1') {
    const pid = typeof q.project === 'string' ? q.project : ''
    openCreate(pid || null)
  } else if (typeof q.edit === 'string') {
    const e = ledger.getEntry(q.edit)
    if (e) openEdit(e)
  } else if (typeof q.confirm === 'string') {
    const e = ledger.getEntry(q.confirm)
    if (e && e.status === 'pending') openEdit(e)
  }
}

function clearQuery(): void {
  if (Object.keys(route.query).length > 0) void router.replace({ path: '/ledger' })
}

function openCreate(projectId: string | null): void {
  editorMode.value = 'create'
  editingEntry.value = null
  createInitial.value = projectId ? buildInitialForProject(projectId) : null
  editorOpen.value = true
}

function openEdit(e: LedgerEntry): void {
  editorMode.value = 'edit'
  editingEntry.value = e
  createInitial.value = null
  editorOpen.value = true
}

function openCorrect(e: LedgerEntry): void {
  editorMode.value = 'correct'
  editingEntry.value = e
  createInitial.value = null
  editorOpen.value = true
}

function onSubmitted(): void {
  editorOpen.value = false
  editingEntry.value = null
  createInitial.value = null
  clearQuery()
}

// ---------------- 待确认（导出刀路自动记下的） ----------------
const pending = computed(() => pendingEntries())
const operators = computed(() => knownOperators())

function doArchive(e: LedgerEntry): void {
  try {
    archiveEntry(e.id)
  } catch (err) {
    banner.value = { kind: 'err', text: (err as Error).message }
  }
}

function doDiscard(e: LedgerEntry): void {
  const reason = prompt('丢弃这条自动记下的作业？请说明原因（仅自动待确认记录可丢弃）：', '导出有误，未实际切割')
  if (reason === null) return
  try {
    discardEntry(e.id, reason)
  } catch (err) {
    banner.value = { kind: 'err', text: (err as Error).message }
  }
}

// ---------------- 筛选与汇总 ----------------
function defaultFrom(): string {
  const d = new Date()
  d.setDate(1)
  return dayKey(d.getTime())
}

const filter = reactive<LedgerFilter>({
  from: defaultFrom(),
  to: '',
  paper: '',
  operator: '',
  keyword: '',
})

const summary = computed(() => ledger.summarize(filter))
const pendingCount = computed(() => pending.value.length)

function setQuickRange(days: number): void {
  const now = new Date()
  filter.to = dayKey(now.getTime())
  if (days === 0) {
    filter.from = dayKey(now.getTime())
    return
  }
  const d = new Date()
  d.setDate(d.getDate() - (days - 1))
  filter.from = dayKey(d.getTime())
}

function clearRange(): void {
  filter.from = ''
  filter.to = ''
}

// ---------------- 列表（含已归档 / 更正 / 已删除项目） ----------------
type Row = EffectiveEntry & { corrections: LedgerEntry[] }

const rows = computed<Row[]>(() => {
  const roots = jobRoots().filter((e) => e.status !== 'discarded' && e.status !== 'pending')
  const list = roots
    .map((e) => ({ ...effectiveOf(e), corrections: correctionsOf(e.id) }))
    .filter((r) => {
      const e = r.entry
      const day = dayKey(e.jobAt)
      if (filter.from && day < filter.from) return false
      if (filter.to && day > filter.to) return false
      if (filter.paper && e.auto.paper !== filter.paper) return false
      if (filter.operator && e.manual.operator !== filter.operator) return false
      if (filter.keyword.trim()) {
        const kw = filter.keyword.trim().toLowerCase()
        const hay = `${e.projectName} ${e.formName} ${e.manual.customer} ${e.manual.note} ${e.manual.wasteReason}`.toLowerCase()
        if (!hay.includes(kw)) return false
      }
      // 包含被更正/更正标记的行始终显示
      return true
    })
  return list.sort((a, b) => b.entry.jobAt - a.entry.jobAt)
})

const expanded = ref<Set<string>>(new Set())
function toggle(id: string): void {
  if (expanded.value.has(id)) expanded.value.delete(id)
  else expanded.value.add(id)
}

const banner = ref<{ kind: 'ok' | 'err'; text: string } | null>(null)

function onEditorSubmitted(e: LedgerEntry): void {
  // 待确认记录在编辑器里保存时确认转已登记（人工补录 + 可改作业时间）
  if (e.status === 'pending') {
    try {
      updateEntry(e.id, { jobAt: e.jobAt })
      const updated = confirmEntry(e.id, {
        sheetsUsed: e.manual.sheetsUsed,
        minutesSpent: e.manual.minutesSpent,
        wasteSheets: e.manual.wasteSheets,
        wasteReason: e.manual.wasteReason,
        operator: e.manual.operator,
        customer: e.manual.customer,
        note: e.manual.note,
      })
      banner.value = { kind: 'ok', text: `已确认「${updated.projectName || updated.formName}」并计入台账` }
    } catch (err) {
      banner.value = { kind: 'err', text: (err as Error).message }
    }
  } else {
    banner.value = { kind: 'ok', text: '已保存' }
  }
  onSubmitted()
}

function statusTag(e: LedgerEntry): { text: string; cls: string } {
  if (e.kind === 'correction') return { text: '更正', cls: 'warn' }
  if (e.status === 'archived') return { text: '已归档', cls: 'info' }
  if (e.status === 'recorded') return { text: '已登记', cls: 'ok' }
  return { text: '待确认', cls: 'warn' }
}

// ---------------- 导出 ----------------
function exportCustomer(): void {
  const s = summary.value
  if (s.rows.length === 0) {
    banner.value = { kind: 'err', text: '当前筛选下没有可导出的已登记作业' }
    return
  }
  const html = buildCustomerReportHtml({ studioName: '剪纸刻绘工作室', filter: filter, summary: s })
  downloadText(customerReportFilename(filter), html, 'text/html;charset=utf-8')
}

function exportCsv(): void {
  const s = summary.value
  if (s.rows.length === 0) {
    banner.value = { kind: 'err', text: '当前筛选下没有可导出的已登记作业' }
    return
  }
  downloadText(internalCsvFilename(filter), buildInternalCsv(s), 'text/csv;charset=utf-8')
}
</script>

<template>
  <div class="page">
    <div class="page narrow">
      <div class="page-head">
        <div>
          <h1>作业台账</h1>
          <p class="hint">每接一单剪纸记一笔。导出刀路时自动带出整场切割情况，人工补用纸、工时与废品；归档后只可更正、不可修改。</p>
        </div>
        <div class="btn-row">
          <button class="primary" @click="openCreate(null)">＋ 登记一笔</button>
        </div>
      </div>

      <div v-if="banner" class="banner" :class="banner.kind === 'err' ? 'err' : 'ok'" @click="banner = null">
        {{ banner.text }}
      </div>

      <!-- 待确认 -->
      <div v-if="pending.length > 0" class="card pending-card">
        <div class="section-title">
          待人工确认（导出刀路时自动记下）
          <span class="tag warn">{{ pending.length }}</span>
          <span class="spacer" style="margin-left:auto"></span>
          <span class="hint">自动带出参数，补录后点「确认」；没真切可「丢弃」</span>
        </div>
        <table class="grid">
          <thead>
            <tr>
              <th>导出时间</th><th>项目 / 纹样</th><th>纸张 / 材料</th><th class="num">刀路 mm</th><th class="num">段数</th>
              <th class="num">遍数</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in pending" :key="e.id">
              <td class="mono">{{ fmtDateTime(e.jobAt) }}</td>
              <td>{{ e.projectName }}<div class="hint">{{ e.formName }}</div></td>
              <td>{{ e.auto.paperLabel }}<div class="hint">{{ e.auto.materialName }}</div></td>
              <td class="num">{{ e.auto.cutLengthMm.toFixed(0) }}</td>
              <td class="num">{{ e.auto.segmentCount }}</td>
              <td class="num">{{ e.auto.passes }}</td>
              <td>
                <div class="btn-row">
                  <button class="tiny primary" @click="openEdit(e)">补录并确认</button>
                  <button class="tiny danger" @click="doDiscard(e)">丢弃</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 筛选 -->
      <div class="card filters">
        <div class="filters-row">
          <div class="field">
            <label>起始日期</label>
            <input type="date" v-model="filter.from" />
          </div>
          <div class="field">
            <label>截止日期</label>
            <input type="date" v-model="filter.to" />
          </div>
          <div class="field">
            <label>纸张</label>
            <select v-model="filter.paper">
              <option value="">全部纸张</option>
              <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>操作人</label>
            <select v-model="filter.operator">
              <option value="">全部操作人</option>
              <option v-for="o in operators" :key="o" :value="o">{{ o }}</option>
            </select>
          </div>
          <div class="field grow">
            <label>搜索（项目 / 纹样 / 客户 / 备注）</label>
            <input type="search" v-model="filter.keyword" placeholder="关键字" />
          </div>
        </div>
        <div class="btn-row quick">
          <button class="tiny" @click="setQuickRange(0)">今天</button>
          <button class="tiny" @click="setQuickRange(7)">近 7 天</button>
          <button class="tiny" @click="setQuickRange(30)">近 30 天</button>
          <button class="tiny" @click="setQuickRange(90)">近 90 天</button>
          <button class="tiny" @click="filter.from = defaultFrom()">本月</button>
          <button class="tiny" @click="clearRange()">全部时间</button>
          <span class="spacer" style="margin-left:auto"></span>
          <button class="tiny primary" @click="exportCustomer">导出客户清单（HTML 可打印）</button>
          <button class="tiny" @click="exportCsv">导出内部台账 CSV</button>
        </div>
      </div>

      <!-- 汇总 -->
      <div class="card summary">
        <div class="section-title">汇总（只统计已登记 / 已归档；待确认与丢弃不计）</div>
        <div class="stat-grid">
          <div class="stat"><div class="k">作业单数</div><div class="v">{{ summary.totals.count }}</div></div>
          <div class="stat"><div class="k">用纸</div><div class="v">{{ summary.totals.sheetsUsed }}<small>张</small></div></div>
          <div class="stat"><div class="k">刀路合计</div><div class="v">{{ toMeters(summary.totals.cutMm).toFixed(2) }}<small>m</small></div></div>
          <div class="stat"><div class="k">实际走刀（含遍数）</div><div class="v">{{ toMeters(summary.totals.actualCutMm).toFixed(2) }}<small>m</small></div></div>
          <div class="stat"><div class="k">工时</div><div class="v">{{ toHours(summary.totals.minutes).toFixed(2) }}<small>h</small></div></div>
          <div class="stat"><div class="k">废品</div><div class="v">{{ summary.totals.wasteSheets }}<small>张</small></div></div>
        </div>
        <div class="groups">
          <div>
            <h4>按纸张</h4>
            <table class="grid mini">
              <tbody>
                <tr v-for="g in summary.byPaper" :key="g.key">
                  <td>{{ g.label }}</td>
                  <td class="num">{{ g.totals.sheetsUsed }} 张</td>
                  <td class="num">{{ toMeters(g.totals.cutMm).toFixed(2) }} m</td>
                  <td class="num">{{ toHours(g.totals.minutes).toFixed(1) }} h</td>
                </tr>
                <tr v-if="summary.byPaper.length === 0"><td class="hint">无数据</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <h4>按操作人</h4>
            <table class="grid mini">
              <tbody>
                <tr v-for="g in summary.byOperator" :key="g.key">
                  <td>{{ g.label }}</td>
                  <td class="num">{{ g.totals.count }} 单</td>
                  <td class="num">{{ g.totals.sheetsUsed }} 张</td>
                  <td class="num">{{ toMeters(g.totals.cutMm).toFixed(2) }} m</td>
                  <td class="num">{{ toHours(g.totals.minutes).toFixed(1) }} h</td>
                </tr>
                <tr v-if="summary.byOperator.length === 0"><td class="hint">无数据</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 台账明细 -->
      <div class="card table-card">
        <div class="section-title">台账明细{{ pendingCount > 0 ? `（另有 ${pendingCount} 笔待确认在上方）` : '' }}</div>
        <div v-if="rows.length === 0" class="empty">该时间段没有记录</div>
        <table v-else class="grid ledger-table">
          <thead>
            <tr>
              <th></th>
              <th>作业时间</th>
              <th>项目 / 纹样</th>
              <th>纸张 / 材料</th>
              <th class="num">刀路(m)</th>
              <th class="num">段数</th>
              <th class="num">刀压/速度/遍数</th>
              <th class="num">用纸</th>
              <th class="num">工时</th>
              <th class="num">废品</th>
              <th>操作人</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.root.id">
              <tr :class="{ corrected: !!r.correction }">
                <td class="expand-cell">
                  <button v-if="r.corrections.length > 0" class="tiny ghost" @click="toggle(r.root.id)">
                    {{ expanded.has(r.root.id) ? '−' : '+' }}{{ r.corrections.length }}
                  </button>
                </td>
                <td class="mono">{{ fmtDateTime(r.entry.jobAt) }}</td>
                <td>
                  {{ r.entry.projectName || r.entry.formName }}
                  <span v-if="r.entry.projectDeleted" class="tag err" title="纹样项目已删除，台账仍保留">项目已删</span>
                  <span v-if="r.entry.duplicateOfId" class="tag warn" title="与当天另一笔相同，已注明原因">重复登记</span>
                  <div class="hint">{{ r.entry.formName }}</div>
                </td>
                <td>
                  {{ r.entry.auto.paperLabel }}
                  <div class="hint">{{ r.entry.auto.materialName }}</div>
                </td>
                <td class="num">{{ toMeters(r.entry.auto.cutLengthMm).toFixed(2) }}</td>
                <td class="num">{{ r.entry.auto.segmentCount }}</td>
                <td class="num">{{ r.entry.auto.force }} / {{ r.entry.auto.speedMmS }} / ×{{ r.entry.auto.passes }}</td>
                <td class="num">{{ r.entry.manual.sheetsUsed }}</td>
                <td class="num">{{ toHours(r.entry.manual.minutesSpent).toFixed(2) }}h</td>
                <td class="num" :class="{ warnCell: r.entry.manual.wasteSheets > 0 }">
                  {{ r.entry.manual.wasteSheets }}
                  <div v-if="r.entry.manual.wasteSheets > 0" class="hint">{{ r.entry.manual.wasteReason }}</div>
                </td>
                <td>{{ r.entry.manual.operator }}</td>
                <td>
                  <span class="tag" :class="statusTag(r.root).cls">{{ statusTag(r.root).text }}</span>
                  <span v-if="r.correction" class="tag warn">已更正</span>
                </td>
                <td>
                  <div class="btn-row">
                    <button class="tiny" @click="openEdit(r.root)">查看</button>
                    <button v-if="r.root.status === 'recorded'" class="tiny" @click="doArchive(r.root)">归档</button>
                    <button v-if="r.root.status === 'archived'" class="tiny" @click="openCorrect(r.root)">更正</button>
                  </div>
                </td>
              </tr>
              <tr v-if="expanded.has(r.root.id)">
                <td colspan="13" class="corr-td">
                  <div v-for="c in r.corrections" :key="c.id" class="corr-line">
                    <span class="tag warn">更正 {{ fmtDateTime(c.recordedAt) }}</span>
                    <span class="hint">原因：{{ c.correctReason }}</span>
                    <span class="hint">
                      更正值：刀路 {{ c.auto.cutLengthMm.toFixed(0) }}mm / {{ c.auto.segmentCount }} 段 /
                      用纸 {{ c.manual.sheetsUsed }} 张 / 工时 {{ c.manual.minutesSpent }} 分钟 / 废品 {{ c.manual.wasteSheets }}
                    </span>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>

    <LedgerEntryEditor
      v-if="editorOpen"
      :mode="editorMode"
      :entry="editingEntry"
      :initial="createInitial"
      :operators="operators"
      @close="onSubmitted"
      @submitted="onEditorSubmitted"
    />
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 12px;
}

.page-head h1 {
  margin-bottom: 2px;
}

.card {
  margin-bottom: 12px;
  padding: 10px 12px;
}

.pending-card {
  border-color: rgba(255, 200, 87, 0.4);
}

.filters-row {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.filters-row .field {
  flex: 0 0 150px;
  margin-bottom: 0;
}

.filters-row .field.grow {
  flex: 1 1 180px;
}

.quick {
  margin-top: 9px;
}

.groups {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-top: 10px;
}

table.mini td {
  padding: 3px 6px;
  font-size: 11.5px;
}

.ledger-table {
  font-size: 11.5px;
}

.ledger-table th,
.ledger-table td {
  white-space: normal;
  vertical-align: top;
}

.ledger-table tr.corrected {
  background: rgba(255, 200, 87, 0.05);
}

.expand-cell {
  width: 30px;
}

.corr-td {
  background: var(--panel-2);
}

.corr-line {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  padding: 4px 2px;
  font-size: 11.5px;
}

.warnCell {
  color: var(--warn);
}

.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12.5px;
  cursor: pointer;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}

.banner.ok {
  background: rgba(71, 192, 122, 0.12);
  border: 1px solid rgba(71, 192, 122, 0.35);
  color: #9fe0b8;
}

@media (max-width: 900px) {
  .groups {
    grid-template-columns: 1fr;
  }
}
</style>
