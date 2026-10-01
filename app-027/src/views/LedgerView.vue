<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { store, state as projectState } from '@/logic/store'
import {
  buildMachineSnapshot,
  customerReportCsv,
  customerReportRows,
  emptyManualData,
  EMPTY_FILTER,
  ledger,
  LedgerError,
  projectExists,
  summarize,
  todayStr,
  type LedgerEntry,
  type LedgerGroupBy,
  type LedgerManualData,
  type MachineSnapshot,
} from '@/logic/ledger'
import { paperLabel } from '@/data/materials'
import { downloadText, sanitizeFilename } from '@/logic/download'

onMounted(() => {
  store.loadState()
  ledger.load()
})

const tab = ref<'pending' | 'list' | 'summary'>('pending')

const allEntries = computed(() => ledger.state.entries)
const pendingEntries = computed(() =>
  allEntries.value
    .filter((e) => e.status === 'pending')
    .sort((a, b) => b.createdAt - a.createdAt),
)

// ---------------- 手工登记 / 待确认编辑表单 ----------------

type FormState = {
  mode: 'new' | 'pending'
  entryId: string
  projectId: string
  data: LedgerManualData
  projectName: string
  force: boolean
  machinePreview: LedgerEntry['machine'] | null
}

const form = ref<FormState | null>(null)
const formError = ref('')
const formDuplicate = ref<LedgerEntry | null>(null)

const projectOptions = computed(() =>
  projectState.projects
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((p) => ({ id: p.id, name: p.name, stats: `${p.shapes.length} 形状` })),
)

function openNew(): void {
  const first = projectOptions.value[0]
  form.value = {
    mode: 'new',
    entryId: '',
    projectId: first?.id ?? '',
    data: emptyManualData(),
    projectName: first?.name ?? '',
    force: false,
    machinePreview: null,
  }
  formError.value = ''
  formDuplicate.value = null
}

function openPending(e: LedgerEntry): void {
  form.value = {
    mode: 'pending',
    entryId: e.id,
    projectId: e.projectId,
    data: { ...e.data },
    projectName: e.projectNameSnapshot,
    force: false,
    machinePreview: e.machine,
  }
  formError.value = ''
  formDuplicate.value = null
}

function closeForm(): void {
  form.value = null
  formError.value = ''
  formDuplicate.value = null
}

const selectedProject = computed(() => projectState.projects.find((p) => p.id === form.value?.projectId) ?? null)

/** 手工登记预览：与真正登记时调用的是同一个 buildMachineSnapshot，保证所见即所记 */
const pendingPreview = computed<MachineSnapshot | null>(() => {
  const f = form.value
  if (!f) return null
  if (f.mode === 'pending') return f.machinePreview
  const p = selectedProject.value
  if (!p) return null
  const { job, isBatch } = store.jobOf(p)
  if (job.runCount === 0) return null
  const mat = store.materialOf(p)
  if (!mat) return null
  return buildMachineSnapshot(p, job, mat, isBatch, '手工登记')
})

function submitForm(): void {
  const f = form.value
  if (!f) return
  formError.value = ''
  formDuplicate.value = null
  try {
    if (f.mode === 'pending') {
      // 先暂存再确认（confirm 内含校验与编号）
      ledger.saveDraft(f.entryId, f.data)
      ledger.confirm(f.entryId, f.data)
    } else {
      ledger.registerManual(f.projectId, f.data, f.force)
    }
    closeForm()
  } catch (e) {
    if (e instanceof LedgerError && e.duplicateOf) formDuplicate.value = e.duplicateOf
    formError.value = (e as Error).message
  }
}

function discardPending(e: LedgerEntry): void {
  if (confirm(`丢弃「${e.projectNameSnapshot}」的待确认台账？丢弃后不保留任何记录。`)) {
    ledger.discard(e.id)
    if (form.value?.entryId === e.id) closeForm()
  }
}

// ---------------- 明细 / 更正 ----------------

const detailId = ref<string | null>(null)
const detail = computed(() => allEntries.value.find((e) => e.id === detailId.value) ?? null)
const correctedSource = computed(() =>
  detail.value?.correctsEntryId ? allEntries.value.find((e) => e.id === detail.value!.correctsEntryId) ?? null : null,
)
const correctionTarget = computed(() =>
  detail.value?.supersededByEntryId ? allEntries.value.find((e) => e.id === detail.value!.supersededByEntryId) ?? null : null,
)

const correction = ref<{ open: boolean; data: LedgerManualData; reason: string; error: string } | null>(null)

function openCorrection(e: LedgerEntry): void {
  correction.value = { open: true, data: { ...e.data }, reason: '', error: '' }
}

function closeCorrection(): void {
  correction.value = null
}

function submitCorrection(): void {
  const c = correction.value
  const d = detail.value
  if (!c || !d) return
  try {
    ledger.correct(d.id, c.data, c.reason)
    closeCorrection()
  } catch (e) {
    c.error = (e as Error).message
  }
}

// ---------------- 筛选 / 汇总 ----------------

const filter = ref({ ...EMPTY_FILTER })
const quickRange = ref<'all' | '7' | '30' | 'month'>('all')

function setQuickRange(kind: typeof quickRange.value): void {
  quickRange.value = kind
  if (kind === 'all') {
    filter.value.dateFrom = ''
    filter.value.dateTo = ''
    return
  }
  const now = new Date()
  filter.value.dateTo = todayStr(now)
  if (kind === '7' || kind === '30') {
    const d = new Date(now)
    d.setDate(d.getDate() - (kind === '7' ? 6 : 29))
    filter.value.dateFrom = todayStr(d)
  } else {
    filter.value.dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  }
}

function matchesFilter(e: LedgerEntry): boolean {
  const f = filter.value
  if (f.dateFrom && e.data.workDate < f.dateFrom) return false
  if (f.dateTo && e.data.workDate > f.dateTo) return false
  if (f.paper && e.machine.paper !== f.paper) return false
  if (f.operator && e.data.operator !== f.operator) return false
  const kw = f.keyword.trim().toLowerCase()
  if (kw && ![e.code, e.data.customer, e.projectNameSnapshot, e.data.operator].some((s) => s.toLowerCase().includes(kw))) return false
  return true
}

const paperOptions = computed(() => {
  const set = new Set<string>()
  for (const e of allEntries.value) set.add(e.machine.paper)
  return Array.from(set).map((p) => ({ value: p, label: paperLabel(p) }))
})

const operatorOptions = computed(() => {
  const set = new Set<string>()
  for (const e of allEntries.value) if (e.status === 'archived' && e.data.operator) set.add(e.data.operator)
  return Array.from(set).sort()
})

const groupBy = ref<LedgerGroupBy>('none')
const summary = computed(() => summarize(allEntries.value, filter.value, groupBy.value))

// 明细页展示所有归档记录（含被更正取代的旧单，保留可追溯）；汇总 / 客户清单只认有效单
const listEntries = computed(() =>
  allEntries.value
    .filter((e) => e.status === 'archived' && matchesFilter(e))
    .sort((a, b) =>
      a.data.workDate === b.data.workDate ? b.code.localeCompare(a.code) : a.data.workDate.localeCompare(b.data.workDate),
    ),
)

const reportRows = computed(() => customerReportRows(allEntries.value, filter.value))
const reportTotal = computed(() => summarize(allEntries.value, filter.value, 'none').total)

// ---------------- 导出 / 打印 ----------------

const studioName = ref('剪纸工作室')
const printTitle = computed(() => `${studioName.value || '剪纸工作室'} · 作业清单（${filter.value.dateFrom || '起始'} 至 ${filter.value.dateTo || '至今'}）`)

function printReport(): void {
  window.print()
}

function downloadCsv(): void {
  const csv = customerReportCsv(allEntries.value, filter.value)
  downloadText(sanitizeFilename(`作业清单_${filter.value.dateFrom || 'all'}_${filter.value.dateTo || todayStr()}`) + '.csv', csv, 'text/csv;charset=utf-8')
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusOf(e: LedgerEntry): { text: string; cls: string } {
  if (e.status === 'pending') return { text: '待确认', cls: 'warn' }
  if (e.supersededByEntryId) return { text: '已更正', cls: 'err' }
  if (e.source === 'correction') return { text: '更正单', cls: 'info' }
  return { text: '已归档', cls: 'ok' }
}
</script>

<template>
  <div class="page">
    <div class="page narrow ledger-page">
      <div class="ledger-head no-print">
        <div>
          <h1>作业台账</h1>
          <p class="hint">每接一单记一笔。导出刀路自动带出整场作业数据，人工补录用纸、工时与废品；归档后不可改，更正须留痕。</p>
        </div>
        <div class="head-actions">
          <button class="primary" @click="openNew">＋ 手工登记一单</button>
        </div>
      </div>

      <div v-if="ledger.state.lastError" class="banner err no-print">{{ ledger.state.lastError }}</div>

      <div class="tabs no-print">
        <button :class="{ active: tab === 'pending' }" @click="tab = 'pending'">
          待确认
          <span v-if="pendingEntries.length" class="badge">{{ pendingEntries.length }}</span>
        </button>
        <button :class="{ active: tab === 'list' }" @click="tab = 'list'">台账明细</button>
        <button :class="{ active: tab === 'summary' }" @click="tab = 'summary'">汇总 · 客户清单</button>
      </div>

      <!-- ============ 待确认 ============ -->
      <div v-if="tab === 'pending'" class="no-print">
        <div v-if="pendingEntries.length === 0" class="card empty">
          没有待确认记录。在导出页下载刀路（PLT / G-code / SVG）后，会自动按整场作业记一条到这里，等你补录用纸与工时。
        </div>
        <div v-else class="card-list">
          <div v-for="e in pendingEntries" :key="e.id" class="card pending-card" :class="{ sel: form?.entryId === e.id }">
            <div class="pc-head">
              <span class="tag warn">待确认</span>
              <strong>{{ e.projectNameSnapshot }}</strong>
              <span v-if="!projectExists(e.projectId)" class="tag err">纹样项目已删除·台账保留</span>
              <span class="spacer"></span>
              <span class="hint mono">导出自动记录 · {{ fmtTime(e.createdAt) }}</span>
            </div>
            <div class="pc-machine">
              <span><b>刀路总长</b>{{ (e.machine.totalCutLengthMm / 1000).toFixed(2) }} 米<small>（{{ e.machine.passes }} 遍）</small></span>
              <span><b>段数</b>{{ e.machine.segmentCount }}</span>
              <span><b>纸张</b>{{ e.machine.paperLabel }}</span>
              <span><b>刀压 / 速度</b>{{ e.machine.force }} / {{ e.machine.speedMmS }}mm/s</span>
              <span><b>形状 / 图层</b>{{ e.machine.shapeCount }} / {{ e.machine.layerCount }}</span>
              <span><b>纸幅</b>{{ e.machine.sheetWidthMm }}×{{ e.machine.sheetHeightMm }}mm</span>
            </div>
            <div class="btn-row">
              <button class="tiny primary" @click="openPending(e)">补录并确认归档</button>
              <button class="tiny danger" @click="discardPending(e)">丢弃</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ============ 台账明细 ============ -->
      <div v-if="tab === 'list'" class="no-print">
        <div class="card filter-card">
          <div class="filter-row">
            <label>时间段
              <input type="date" v-model="filter.dateFrom" />
              <span>至</span>
              <input type="date" v-model="filter.dateTo" />
            </label>
            <div class="quick">
              <button class="tiny" :class="{ active: quickRange === 'all' }" @click="setQuickRange('all')">全部</button>
              <button class="tiny" :class="{ active: quickRange === '7' }" @click="setQuickRange('7')">近 7 天</button>
              <button class="tiny" :class="{ active: quickRange === '30' }" @click="setQuickRange('30')">近 30 天</button>
              <button class="tiny" :class="{ active: quickRange === 'month' }" @click="setQuickRange('month')">本月</button>
            </div>
          </div>
          <div class="filter-row">
            <label>纸张
              <select v-model="filter.paper">
                <option value="">全部</option>
                <option v-for="p in paperOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
            <label>操作人
              <select v-model="filter.operator">
                <option value="">全部</option>
                <option v-for="o in operatorOptions" :key="o" :value="o">{{ o }}</option>
              </select>
            </label>
            <label class="grow">搜索（编号 / 客户 / 纹样 / 操作人）
              <input type="search" v-model="filter.keyword" placeholder="输入关键字" />
            </label>
            <button class="tiny ghost" @click="filter = { ...EMPTY_FILTER }; setQuickRange('all')">清空筛选</button>
          </div>
        </div>

        <table v-if="listEntries.length" class="grid ledger-table">
          <thead>
            <tr>
              <th>状态</th>
              <th>编号</th>
              <th>日期</th>
              <th>纹样项目</th>
              <th>客户/单号</th>
              <th>纸张</th>
              <th class="num">刀路(米)</th>
              <th class="num">段数</th>
              <th class="num">用纸</th>
              <th class="num">废品</th>
              <th class="num">工时</th>
              <th>操作人</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in listEntries" :key="e.id" :class="{ sel: detailId === e.id, dead: e.supersededByEntryId }" @click="detailId = e.id">
              <td><span class="tag" :class="statusOf(e).cls">{{ statusOf(e).text }}</span></td>
              <td class="mono">{{ e.code }}</td>
              <td class="mono">{{ e.data.workDate }}</td>
              <td>
                {{ e.projectNameSnapshot }}
                <i v-if="!projectExists(e.projectId)" class="gone">（纹样已删除）</i>
              </td>
              <td>{{ e.data.customer || '—' }}</td>
              <td>{{ e.machine.paperLabel }}</td>
              <td class="num">{{ (e.machine.totalCutLengthMm / 1000).toFixed(2) }}</td>
              <td class="num">{{ e.machine.segmentCount }}</td>
              <td class="num">{{ e.data.sheetsUsed }}</td>
              <td class="num" :class="{ warnCell: e.data.wasteCount > 0 }">{{ e.data.wasteCount }}</td>
              <td class="num">{{ (e.data.workMinutes / 60).toFixed(2) }}</td>
              <td>{{ e.data.operator }}</td>
              <td><button class="tiny" @click.stop="detailId = e.id">查看</button></td>
            </tr>
          </tbody>
        </table>
        <div v-else class="card empty">当前筛选条件下没有台账记录。</div>

        <p class="hint" style="margin-top: 8px">
          已归档记录不可修改、不可删除；发现录错请打开详情点「新增更正记录」，原单保留并标记「已更正」、不再计入汇总与客户清单。
        </p>
      </div>

      <!-- ============ 汇总 / 客户清单 ============ -->
      <div v-if="tab === 'summary'" class="no-print">
        <div class="card filter-card">
          <div class="filter-row">
            <label>时间段
              <input type="date" v-model="filter.dateFrom" />
              <span>至</span>
              <input type="date" v-model="filter.dateTo" />
            </label>
            <div class="quick">
              <button class="tiny" :class="{ active: quickRange === 'all' }" @click="setQuickRange('all')">全部</button>
              <button class="tiny" :class="{ active: quickRange === '7' }" @click="setQuickRange('7')">近 7 天</button>
              <button class="tiny" :class="{ active: quickRange === '30' }" @click="setQuickRange('30')">近 30 天</button>
              <button class="tiny" :class="{ active: quickRange === 'month' }" @click="setQuickRange('month')">本月</button>
            </div>
          </div>
          <div class="filter-row">
            <label>纸张
              <select v-model="filter.paper">
                <option value="">全部</option>
                <option v-for="p in paperOptions" :key="p.value" :value="p.value">{{ p.label }}</option>
              </select>
            </label>
            <label>操作人
              <select v-model="filter.operator">
                <option value="">全部</option>
                <option v-for="o in operatorOptions" :key="o" :value="o">{{ o }}</option>
              </select>
            </label>
            <label class="grow">汇总口径
              <select v-model="groupBy">
                <option value="none">不分组（总体合计）</option>
                <option value="paper">按纸张</option>
                <option value="operator">按操作人</option>
                <option value="customer">按客户</option>
                <option value="date">按日期</option>
              </select>
            </label>
          </div>
        </div>

        <div class="stat-grid summary-stats">
          <div class="stat"><div class="k">作业单数</div><div class="v">{{ reportTotal.jobs }}</div></div>
          <div class="stat"><div class="k">用纸张数</div><div class="v">{{ reportTotal.sheets }}<small>张</small></div></div>
          <div class="stat"><div class="k">成品张数</div><div class="v">{{ reportTotal.goodSheets }}<small>张</small></div></div>
          <div class="stat"><div class="k">废纸张数</div><div class="v" :style="{ color: reportTotal.waste ? 'var(--warn)' : '' }">{{ reportTotal.waste }}<small>张</small></div></div>
          <div class="stat"><div class="k">刀路总长</div><div class="v">{{ reportTotal.cutMeters.toFixed(2) }}<small>米</small></div></div>
          <div class="stat"><div class="k">总工时</div><div class="v">{{ reportTotal.workHours.toFixed(2) }}<small>小时</small></div></div>
        </div>

        <table v-if="summary.rows.length" class="grid" style="margin: 10px 0">
          <thead>
            <tr>
              <th>{{ { none: '口径', paper: '纸张', operator: '操作人', customer: '客户', date: '日期' }[groupBy] }}</th>
              <th class="num">单数</th>
              <th class="num">用纸(张)</th>
              <th class="num">成品(张)</th>
              <th class="num">废品(张)</th>
              <th class="num">刀路(米)</th>
              <th class="num">工时(小时)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in summary.rows" :key="r.key">
              <td>{{ r.label }}</td>
              <td class="num">{{ r.jobs }}</td>
              <td class="num">{{ r.sheets }}</td>
              <td class="num">{{ r.goodSheets }}</td>
              <td class="num" :class="{ warnCell: r.waste > 0 }">{{ r.waste }}</td>
              <td class="num">{{ r.cutMeters.toFixed(2) }}</td>
              <td class="num">{{ r.workHours.toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="card">
          <div class="section-title">
            客户作业清单
            <span class="spacer"></span>
            <label class="studio-field">抬头
              <input type="text" v-model="studioName" placeholder="剪纸工作室" />
            </label>
            <button class="tiny primary" :disabled="!reportRows.length" @click="printReport">打印 / 另存 PDF（客户版）</button>
            <button class="tiny" :disabled="!reportRows.length" @click="downloadCsv">导出 CSV</button>
          </div>
          <p class="hint">客户版只列当前筛选条件下的有效记录（不含已被更正的旧单与待确认记录）。</p>
          <table class="grid report-table">
            <thead>
              <tr>
                <th>编号</th><th>日期</th><th>纹样</th><th>客户/单号</th><th>纸张</th>
                <th class="num">刀路(米)</th><th class="num">用纸</th><th class="num">成品</th><th class="num">废品</th>
                <th class="num">工时(h)</th><th>操作人</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in reportRows" :key="r.code">
                <td class="mono">{{ r.code }}</td>
                <td class="mono">{{ r.date }}</td>
                <td>{{ r.project }}</td>
                <td>{{ r.customer || '—' }}</td>
                <td>{{ r.paper }}</td>
                <td class="num">{{ r.cutMeters.toFixed(2) }}</td>
                <td class="num">{{ r.sheets }}</td>
                <td class="num">{{ r.goodSheets }}</td>
                <td class="num" :class="{ warnCell: r.waste > 0 }">{{ r.waste }}</td>
                <td class="num">{{ r.workHours.toFixed(2) }}</td>
                <td>{{ r.operator }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ============ 登记表单（侧栏抽屉） ============ -->
      <div v-if="form" class="drawer-mask" @click.self="closeForm">
        <div class="drawer">
          <div class="drawer-head">
            {{ form.mode === 'new' ? '手工登记一单' : '补录作业数据并确认' }}
            <span class="spacer"></span>
            <button class="tiny ghost" @click="closeForm">关闭</button>
          </div>
          <div class="drawer-body">
            <div v-if="form.mode === 'new'" class="field">
              <label>纹样项目（自动带出整场刀路与材料数据）</label>
              <select v-model="form.projectId">
                <option value="" disabled>请选择项目</option>
                <option v-for="p in projectOptions" :key="p.id" :value="p.id">{{ p.name }}（{{ p.stats }}）</option>
              </select>
            </div>
            <div v-else class="field">
              <label>纹样项目</label>
              <div class="ro-box">
                {{ form.projectName }}
                <span v-if="!projectExists(form.projectId)" class="tag err">项目已删除·数据保留</span>
              </div>
            </div>

            <div v-if="pendingPreview" class="machine-box">
              <div class="section-title">整场作业基本情况（自动带出，不可改）</div>
              <div class="pc-machine">
                <span><b>刀路总长</b>{{ (pendingPreview.totalCutLengthMm / 1000).toFixed(2) }} 米<small>（{{ pendingPreview.passes }} 遍，单遍 {{ (pendingPreview.cutLengthMm / 1000).toFixed(2) }} 米）</small></span>
                <span><b>段数</b>{{ pendingPreview.segmentCount }}</span>
                <span><b>跳刀</b>{{ pendingPreview.travelMm.toFixed(0) }}mm</span>
                <span><b>形状 / 图层</b>{{ pendingPreview.shapeCount }} / {{ pendingPreview.layerCount }}</span>
                <span><b>纸张</b>{{ pendingPreview.paperLabel }}</span>
                <span><b>材料预设</b>{{ pendingPreview.materialName }}</span>
                <span><b>刀压</b>{{ pendingPreview.force }}</span>
                <span><b>速度</b>{{ pendingPreview.speedMmS }} mm/s</span>
                <span><b>重复遍数</b>{{ pendingPreview.passes }}</span>
                <span><b>垫板</b>{{ pendingPreview.backing }}</span>
                <span><b>纸幅</b>{{ pendingPreview.sheetName }} {{ pendingPreview.sheetWidthMm }}×{{ pendingPreview.sheetHeightMm }}mm</span>
                <span v-if="pendingPreview.batch"><b>排版份数</b>{{ pendingPreview.batchCopies }} 份</span>
              </div>
            </div>
            <div v-else-if="form.mode === 'new'" class="hint err-text">该项目暂无可切割刀路（没有轮廓），无法登记。</div>

            <div class="section-title">人工补录</div>
            <div class="form-grid">
              <label>作业日期<input type="date" v-model="form.data.workDate" /></label>
              <label>操作人 *<input type="text" v-model="form.data.operator" placeholder="如：王师傅" /></label>
              <label>客户 / 单号<input type="text" v-model="form.data.customer" placeholder="如：李家婚庆 / 散客可留空" /></label>
              <label>实际用纸（张）*<input type="number" min="1" step="1" v-model.number="form.data.sheetsUsed" /></label>
              <label>实际工时（分钟）*<input type="number" min="1" step="1" v-model.number="form.data.workMinutes" /></label>
              <label>废品（张）<input type="number" min="0" step="1" v-model.number="form.data.wasteCount" /></label>
            </div>
            <div class="field">
              <label>废品原因{{ form.data.wasteCount > 0 ? ' *' : '' }}</label>
              <input type="text" v-model="form.data.wasteReason" :disabled="form.data.wasteCount === 0" placeholder="如：第 2 张宣纸起毛切不透、走位 1 张" />
            </div>
            <div class="field">
              <label>备注</label>
              <textarea rows="2" v-model="form.data.note" placeholder="其他需要说明的情况"></textarea>
            </div>

            <div v-if="formError" class="banner err">
              {{ formError }}
              <template v-if="formDuplicate">
                <div v-if="formDuplicate.status === 'pending'" class="dup-actions">该作业已在待确认队列中，请到「待确认」页签处理，无需重复登记。</div>
                <div v-else class="dup-actions">
                  已有归档记录：<span class="mono">{{ formDuplicate.code }}</span>（{{ formDuplicate.data.workDate }}）。
                  <label class="check" v-if="form.mode === 'new'"><input type="checkbox" v-model="form.force" @change="formError = ''" /> 确属补切 / 重切，强制登记一单</label>
                </div>
              </template>
            </div>
          </div>
          <div class="drawer-foot">
            <button @click="closeForm">取消</button>
            <button class="primary" :disabled="form.mode === 'new' && !form.projectId" @click="submitForm()">
              {{ form.mode === 'new' ? '登记并归档' : '确认归档（不可再改）' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ============ 详情抽屉 ============ -->
      <div v-if="detail" class="drawer-mask" @click.self="detailId = null">
        <div class="drawer wide">
          <div class="drawer-head">
            台账详情
            <span class="tag" :class="statusOf(detail).cls">{{ statusOf(detail).text }}</span>
            <span class="spacer"></span>
            <button class="tiny ghost" @click="detailId = null">关闭</button>
          </div>
          <div class="drawer-body">
            <div class="detail-code">
              <span class="mono big">{{ detail.code || '（待确认）' }}</span>
              <span class="hint">记录于 {{ fmtTime(detail.createdAt) }}｜{{ detail.source === 'auto' ? '导出自动带出' : detail.source === 'manual' ? '手工登记' : '更正记录' }}</span>
            </div>

            <div v-if="detail.source === 'correction'" class="banner info">
              本单为更正记录，原因为：{{ detail.reason }}
              <div v-if="correctedSource" class="hint" style="color: inherit">
                更正自 {{ correctedSource.code }}（{{ correctedSource.data.workDate }}），原单已保留、标记为「已更正」，不再计入汇总。
              </div>
            </div>
            <div v-else-if="correctionTarget" class="banner warn">
              本单数据已被更正单 <span class="mono">{{ correctionTarget.code }}</span> 取代，不计入汇总；本单保留仅作追溯。
            </div>

            <div class="detail-grid">
              <div><span>纹样项目</span><b>{{ detail.projectNameSnapshot }}<i v-if="!projectExists(detail.projectId)" class="gone">（纹样已删除·台账保留）</i></b></div>
              <div><span>作业日期</span><b class="mono">{{ detail.data.workDate }}</b></div>
              <div><span>客户 / 单号</span><b>{{ detail.data.customer || '—' }}</b></div>
              <div><span>操作人</span><b>{{ detail.data.operator }}</b></div>
            </div>

            <div class="section-title">整场机台数据（冻结）</div>
            <table class="grid kv">
              <tbody>
                <tr><td>刀路总长</td><td class="mono">{{ (detail.machine.totalCutLengthMm / 1000).toFixed(3) }} 米</td><td>单遍</td><td class="mono">{{ (detail.machine.cutLengthMm / 1000).toFixed(3) }} 米</td></tr>
                <tr><td>段数</td><td class="mono">{{ detail.machine.segmentCount }}</td><td>跳刀</td><td class="mono">{{ detail.machine.travelMm.toFixed(1) }} mm</td></tr>
                <tr><td>形状 / 图层</td><td class="mono">{{ detail.machine.shapeCount }} / {{ detail.machine.layerCount }}</td><td>排版</td><td class="mono">{{ detail.machine.batch ? `${detail.machine.batchCopies} 份批量` : '单场' }}</td></tr>
                <tr><td>纸张</td><td>{{ detail.machine.paperLabel }}</td><td>材料预设</td><td>{{ detail.machine.materialName }}</td></tr>
                <tr><td>刀压</td><td class="mono">{{ detail.machine.force }}</td><td>速度</td><td class="mono">{{ detail.machine.speedMmS }} mm/s</td></tr>
                <tr><td>重复遍数</td><td class="mono">{{ detail.machine.passes }}</td><td>刀补</td><td class="mono">{{ detail.machine.bladeOffsetMm }} mm</td></tr>
                <tr><td>纸幅</td><td class="mono">{{ detail.machine.sheetWidthMm }}×{{ detail.machine.sheetHeightMm }} mm（{{ detail.machine.sheetName }}）</td><td>缩放 / 来源</td><td class="mono">{{ Math.round(detail.machine.scale * 100) }}% / {{ detail.machine.format }}</td></tr>
              </tbody>
            </table>

            <div class="section-title">人工补录数据</div>
            <table class="grid kv">
              <tbody>
                <tr><td>实际用纸</td><td class="mono">{{ detail.data.sheetsUsed }} 张</td><td>成品</td><td class="mono">{{ detail.data.sheetsUsed - detail.data.wasteCount }} 张</td></tr>
                <tr><td>废品</td><td class="mono">{{ detail.data.wasteCount }} 张</td><td>工时</td><td class="mono">{{ fmtMin(detail.data.workMinutes) }}</td></tr>
                <tr><td>废品原因</td><td colspan="3">{{ detail.data.wasteReason || '—' }}</td></tr>
                <tr><td>备注</td><td colspan="3">{{ detail.data.note || '—' }}</td></tr>
              </tbody>
            </table>

            <div class="hint">作业指纹 <span class="mono">{{ detail.fingerprint }}</span>：同一场刀路（总长 / 段数 / 材料 / 纸幅 / 排版一致）重复登记时据此拦下。</div>
          </div>
          <div class="drawer-foot" v-if="detail.status === 'archived' && !detail.supersededByEntryId">
            <span class="hint">归档数据不可改；确属录错请走更正流程：</span>
            <span class="spacer"></span>
            <button class="primary" @click="openCorrection(detail)">新增更正记录</button>
          </div>
        </div>
      </div>

      <!-- ============ 更正抽屉 ============ -->
      <div v-if="correction" class="drawer-mask" @click.self="closeCorrection">
        <div class="drawer">
          <div class="drawer-head">
            新增更正记录
            <span class="spacer"></span>
            <button class="tiny ghost" @click="closeCorrection">关闭</button>
          </div>
          <div class="drawer-body">
            <div class="banner warn">原单 {{ detail?.code }} 保持不动并标记为「已更正」；更正单使用同一套机台数据，只需重填人工补录项并写明原因。</div>
            <div class="field">
              <label>更正原因 *</label>
              <input type="text" v-model="correction.reason" placeholder="如：工时少记了 20 分钟 / 废品数把邻单的算进来了" />
            </div>
            <div class="form-grid">
              <label>作业日期<input type="date" v-model="correction.data.workDate" /></label>
              <label>操作人 *<input type="text" v-model="correction.data.operator" /></label>
              <label>客户 / 单号<input type="text" v-model="correction.data.customer" /></label>
              <label>实际用纸（张）*<input type="number" min="1" step="1" v-model.number="correction.data.sheetsUsed" /></label>
              <label>实际工时（分钟）*<input type="number" min="1" step="1" v-model.number="correction.data.workMinutes" /></label>
              <label>废品（张）<input type="number" min="0" step="1" v-model.number="correction.data.wasteCount" /></label>
            </div>
            <div class="field">
              <label>废品原因{{ correction.data.wasteCount > 0 ? ' *' : '' }}</label>
              <input type="text" v-model="correction.data.wasteReason" :disabled="correction.data.wasteCount === 0" />
            </div>
            <div class="field">
              <label>备注</label>
              <textarea rows="2" v-model="correction.data.note"></textarea>
            </div>
            <div v-if="correction.error" class="banner err">{{ correction.error }}</div>
          </div>
          <div class="drawer-foot">
            <button @click="closeCorrection">取消</button>
            <button class="primary" @click="submitCorrection">提交更正并归档</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 打印区：客户作业清单 ============ -->
    <div class="print-area">
      <div class="client-sheet">
        <h1>{{ printTitle }}</h1>
        <p class="ps-meta">出具日期：{{ todayStr() }}｜共 {{ reportRows.length }} 单</p>
        <table>
          <thead>
            <tr>
              <th>编号</th><th>日期</th><th>纹样</th><th>客户/单号</th><th>纸张</th>
              <th class="num">刀路(米)</th><th class="num">用纸</th><th class="num">成品</th><th class="num">废品</th>
              <th class="num">工时(h)</th><th>操作人</th><th>废品说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in reportRows" :key="r.code">
              <td>{{ r.code }}</td>
              <td>{{ r.date }}</td>
              <td>{{ r.project }}</td>
              <td>{{ r.customer || '—' }}</td>
              <td>{{ r.paper }}</td>
              <td class="num">{{ r.cutMeters.toFixed(2) }}</td>
              <td class="num">{{ r.sheets }}</td>
              <td class="num">{{ r.goodSheets }}</td>
              <td class="num">{{ r.waste }}</td>
              <td class="num">{{ r.workHours.toFixed(2) }}</td>
              <td>{{ r.operator }}</td>
              <td>{{ r.wasteReason || '—' }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">合计</td>
              <td class="num">{{ reportTotal.cutMeters.toFixed(2) }}</td>
              <td class="num">{{ reportTotal.sheets }}</td>
              <td class="num">{{ reportTotal.goodSheets }}</td>
              <td class="num">{{ reportTotal.waste }}</td>
              <td class="num">{{ reportTotal.workHours.toFixed(2) }}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>
        <p class="ps-foot">机台参数（刀压 / 速度 / 遍数）已按每场作业随刀路文件留存；本清单由作业台账导出。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ledger-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
}

.head-actions {
  flex: 0 0 auto;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 12px;
}

.tabs button {
  border: 0;
  background: transparent;
  border-radius: 6px 6px 0 0;
  padding: 7px 14px;
  color: var(--text-dim);
  position: relative;
}

.tabs button.active {
  color: var(--accent-2);
  background: var(--panel);
  box-shadow: inset 0 -2px 0 var(--accent);
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 8px;
  background: var(--warn);
  color: #241a02;
  font-size: 10px;
  font-weight: 700;
}

.card-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.pending-card {
  padding: 10px 12px;
}

.pending-card.sel {
  border-color: var(--accent);
}

.pc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.spacer {
  flex: 1 1 auto;
}

.pc-machine {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 3px 12px;
  margin-bottom: 9px;
  font-size: 12px;
  color: var(--text-dim);
}

.pc-machine b {
  display: inline-block;
  min-width: 82px;
  color: var(--text-mute);
  font-weight: 500;
}

.pc-machine small {
  color: var(--text-mute);
}

.filter-card {
  margin-bottom: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.filter-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.filter-row label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-dim);
}

.filter-row label.grow {
  flex: 1 1 220px;
}

.filter-row input,
.filter-row select {
  width: auto;
  min-width: 110px;
}

.filter-row label.grow input {
  flex: 1 1 auto;
}

.quick {
  display: flex;
  gap: 4px;
}

.quick button.active {
  background: var(--accent);
  border-color: var(--accent);
  color: #1a1206;
}

.ledger-table td,
.report-table td {
  white-space: nowrap;
}

.warnCell {
  color: var(--warn);
}

tr.dead td {
  color: var(--text-mute);
}

.gone {
  color: var(--err);
  font-style: normal;
  font-size: 11px;
}

.summary-stats {
  margin: 10px 0;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
}

.studio-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-mute);
}

.studio-field input {
  width: 130px;
}

/* 抽屉 */
.drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 14, 0.62);
  z-index: 50;
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: min(520px, 96vw);
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}

.drawer.wide {
  width: min(680px, 97vw);
}

.drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  font-weight: 600;
  flex: 0 0 auto;
}

.drawer-body {
  padding: 14px;
  overflow: auto;
  flex: 1 1 auto;
}

.drawer-foot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  padding: 10px 14px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
  flex: 0 0 auto;
}

.machine-box {
  background: var(--panel-2);
  border: 1px solid var(--line-soft);
  border-radius: 6px;
  padding: 9px 10px;
  margin: 10px 0;
}

.machine-box .section-title {
  margin-bottom: 6px;
}

.ro-box {
  background: var(--bg-grid);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 6px 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
  margin-bottom: 9px;
}

.form-grid label {
  font-size: 11.5px;
  color: var(--text-dim);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin: 8px 0;
  font-size: 12px;
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}

.banner.warn {
  background: rgba(255, 200, 87, 0.1);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: var(--warn);
}

.banner.info {
  background: rgba(90, 169, 255, 0.1);
  border: 1px solid rgba(90, 169, 255, 0.4);
  color: #9cc8ff;
}

.dup-actions {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.err-text {
  color: var(--err);
}

/* 详情 */
.detail-code {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
}

.big {
  font-size: 17px;
  color: var(--accent-2);
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 14px;
  margin-bottom: 10px;
  font-size: 12.5px;
}

.detail-grid span {
  display: block;
  font-size: 11px;
  color: var(--text-mute);
}

table.kv td {
  white-space: normal;
}

table.kv td:nth-child(odd) {
  color: var(--text-mute);
  width: 18%;
}

.check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--text-dim);
}

/* 客户清单打印 */
.client-sheet {
  color: #111;
  font-size: 11px;
}

.client-sheet h1 {
  font-size: 16px;
  text-align: center;
  margin-bottom: 2px;
}

.ps-meta {
  text-align: center;
  color: #444;
  font-size: 10.5px;
  margin-bottom: 8px;
}

.client-sheet table {
  width: 100%;
  border-collapse: collapse;
}

.client-sheet th,
.client-sheet td {
  border: 1px solid #333;
  padding: 3px 5px;
  text-align: left;
}

.client-sheet th {
  background: #f0f0f0;
}

.client-sheet td.num,
.client-sheet th.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.ps-foot {
  margin-top: 8px;
  color: #555;
  font-size: 10px;
}

@media print {
  .client-sheet {
    padding: 10mm;
  }
}
</style>
