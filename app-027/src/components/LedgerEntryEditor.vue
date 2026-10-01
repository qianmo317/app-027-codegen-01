<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { store } from '@/logic/store'
import {
  buildAutoSnapshot,
  createManualEntry,
  addCorrection,
  updateEntry,
  toLocalInput,
  fromLocalInput,
  type LedgerAuto,
  type LedgerEntry,
  type LedgerManual,
} from '@/logic/ledger'
import { PAPER_KINDS } from '@/logic/types'

export type EditorInitial = {
  projectId: string | null
  projectName: string
  formName: string
  auto: LedgerAuto
}

const props = defineProps<{
  mode: 'create' | 'edit' | 'correct'
  entry?: LedgerEntry | null
  initial?: EditorInitial | null
  operators: string[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submitted', entry: LedgerEntry): void
}>()

const FREE = '__free__'

const projects = computed(() => store.state.projects)

const form = reactive({
  jobAt: toLocalInput(Date.now()),
  projectKey: FREE,
  projectName: '',
  formName: '',
  freePaper: 'red-paper',
  freeMaterial: '',
  // 自动字段（仅手工新建 / 更正时可编辑）
  cutLengthMm: 0,
  segmentCount: 0,
  shapeCount: 1,
  layerCount: 1,
  force: 0,
  speedMmS: 0,
  passes: 1,
  // 人工字段
  sheetsUsed: 0,
  minutesSpent: 0,
  wasteSheets: 0,
  wasteReason: '',
  operator: '',
  customer: '',
  note: '',
  // 更正
  correctReason: '',
  // 重复登记强制
  dupReason: '',
})

const dupInfo = ref<{ id: string; text: string } | null>(null)
const error = ref('')

const isCreate = computed(() => props.mode === 'create')
const isEdit = computed(() => props.mode === 'edit')
const isCorrect = computed(() => props.mode === 'correct')

const autoLocked = computed(() => {
  // 待确认（自动带出）与归档查看：自动字段一律只读
  if (isCreate.value) return false
  const e = props.entry
  if (!e) return false
  if (isCorrect.value) return false // 更正时允许改全部参数
  return e.status === 'pending' || e.status === 'archived' || e.source === 'export_auto'
})

const title = computed(() => {
  if (isCreate.value) return '登记一笔作业'
  if (isCorrect.value) return '更正已归档作业'
  return props.entry?.status === 'pending' ? '确认自动记下的作业' : props.entry?.status === 'archived' ? '查看已归档作业' : '编辑作业记录'
})

const readonlyArchived = computed(() => isEdit.value && props.entry?.status === 'archived')

function syncProjectAuto(projectId: string): void {
  const p = store.getProject(projectId)
  if (!p) return
  const d = store.jobOf(p)
  const m = store.materialOf(p)
  if (!m) return
  const auto = buildAutoSnapshot({
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
  })
  form.projectName = p.name
  form.formName = (d.isBatch && d.shape ? [d.shape] : p.shapes).map((s) => s.name).join('、')
  applyAuto(auto)
}

function applyAuto(a: LedgerAuto): void {
  form.cutLengthMm = Math.round(a.cutLengthMm * 10) / 10
  form.segmentCount = a.segmentCount
  form.shapeCount = a.shapeCount
  form.layerCount = a.layerCount
  form.force = a.force
  form.speedMmS = a.speedMmS
  form.passes = a.passes
  form.freeMaterial = a.materialName
  form.freePaper = a.paper
}

function loadFromEntry(e: LedgerEntry): void {
  form.jobAt = toLocalInput(e.jobAt)
  form.projectKey = e.projectId ?? FREE
  form.projectName = e.projectName
  form.formName = e.formName
  applyAuto(e.auto)
  form.freeMaterial = e.auto.materialName
  form.freePaper = e.auto.paper
  const m: LedgerManual = e.manual
  form.sheetsUsed = m.sheetsUsed
  form.minutesSpent = m.minutesSpent
  form.wasteSheets = m.wasteSheets
  form.wasteReason = m.wasteReason
  form.operator = m.operator
  form.customer = m.customer
  form.note = m.note
}

watch(
  () => [props.mode, props.entry, props.initial],
  () => {
    error.value = ''
    dupInfo.value = null
    form.correctReason = ''
    form.dupReason = ''
    if ((isEdit.value || isCorrect.value) && props.entry) {
      loadFromEntry(props.entry)
    } else if (isCreate.value && props.initial) {
      form.jobAt = toLocalInput(Date.now())
      form.projectKey = props.initial.projectId ?? FREE
      form.projectName = props.initial.projectName
      form.formName = props.initial.formName
      applyAuto(props.initial.auto)
      form.freeMaterial = props.initial.auto.materialName
      form.freePaper = props.initial.auto.paper
    } else if (isCreate.value) {
      form.projectKey = FREE
      form.projectName = ''
      form.formName = ''
      applyAuto({ ...blankAuto() })
    }
  },
  { immediate: true },
)

function blankAuto(): LedgerAuto {
  const k = PAPER_KINDS[0]
  return {
    cutLengthMm: 0,
    actualCutMm: 0,
    segmentCount: 0,
    shapeCount: 1,
    layerCount: 1,
    travelMm: 0,
    paper: k.paper,
    paperLabel: k.label,
    materialName: '',
    backing: k.backing,
    force: k.force,
    speedMmS: k.speedMmS,
    passes: k.passes,
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

function onProjectChange(): void {
  if (form.projectKey !== FREE) syncProjectAuto(form.projectKey)
}

function onPaperChange(): void {
  const k = PAPER_KINDS.find((x) => x.paper === form.freePaper)
  if (!k) return
  if (isCreate.value || isCorrect.value || (isEdit.value && props.entry?.source === 'manual')) {
    form.force = k.force
    form.speedMmS = k.speedMmS
    form.passes = k.passes
  }
}

function buildAuto(): LedgerAuto {
  const k = PAPER_KINDS.find((x) => x.paper === form.freePaper)
  const cut = Math.max(0, Number(form.cutLengthMm) || 0)
  const passes = Math.max(1, Math.round(Number(form.passes) || 1))
  return {
    cutLengthMm: Math.round(cut * 1000) / 1000,
    actualCutMm: Math.round(cut * passes * 1000) / 1000,
    segmentCount: Math.max(0, Math.round(Number(form.segmentCount) || 0)),
    shapeCount: Math.max(1, Math.round(Number(form.shapeCount) || 1)),
    layerCount: Math.max(1, Math.round(Number(form.layerCount) || 1)),
    travelMm: 0,
    paper: form.freePaper,
    paperLabel: k?.label ?? form.freePaper,
    materialName: form.freeMaterial.trim(),
    backing: k?.backing ?? '',
    force: Number(form.force) || 0,
    speedMmS: Number(form.speedMmS) || 0,
    passes,
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

function num(v: number): number {
  return Math.max(0, Number(v) || 0)
}

function manualFromForm(): LedgerManual {
  return {
    sheetsUsed: num(form.sheetsUsed),
    minutesSpent: num(form.minutesSpent),
    wasteSheets: num(form.wasteSheets),
    wasteReason: form.wasteReason.trim(),
    operator: form.operator.trim(),
    customer: form.customer.trim(),
    note: form.note.trim(),
  }
}

function validate(): string {
  if (!form.operator.trim()) return '请填写操作人'
  if (isCreate.value && form.projectKey === FREE && !form.formName.trim()) return '请填写纹样内容（这次做的是什么）'
  if (isCreate.value && form.projectKey === FREE && num(form.cutLengthMm) <= 0) return '请填写整场刀路长度（mm）'
  if (num(form.wasteSheets) > 0 && !form.wasteReason.trim()) return '有废品时必须填写废品原因'
  if (isCorrect.value && !form.correctReason.trim()) return '更正必须写明原因'
  return ''
}

function save(): void {
  if (readonlyArchived.value) {
    error.value = '归档记录不可修改，请在台账列表中点「更正」'
    return
  }
  error.value = validate()
  if (error.value) return

  const jobAt = fromLocalInput(form.jobAt)

  if (isCreate.value) {
    const bound = form.projectKey !== FREE ? store.getProject(form.projectKey) : null
    const res = createManualEntry(
      {
        jobAt,
        projectId: bound?.id ?? null,
        projectName: bound?.name ?? form.projectName.trim(),
        formName: form.formName.trim(),
        auto: buildAuto(),
        manual: manualFromForm(),
      },
      dupInfo.value ? { allow: true, reason: form.dupReason } : undefined,
    )
    if ('duplicate' in res) {
      dupInfo.value = { id: res.duplicate.id, text: '当天已有同一次作业的记录' }
      error.value = '识别到同一次作业的重复登记：如确属另一单，请写明原因后强制登记。'
      return
    }
    emit('submitted', res.entry)
    return
  }

  if (!props.entry) return

  // pending：只允许补录人工信息与作业时间，自动字段只读
  if (props.entry.status === 'pending') {
    emit('submitted', { ...props.entry, manual: manualFromForm(), jobAt })
    return
  }

  if (isCorrect.value) {
    const res = addCorrection(
      props.entry.id,
      { auto: buildAutoPatch(), manual: manualFromForm() },
      form.correctReason,
    )
    if ('error' in res) {
      error.value = res.error
      return
    }
    emit('submitted', res.entry)
    return
  }

  // edit
  try {
    const patch = { jobAt, manual: manualFromForm() }
    if (props.entry.source === 'manual') {
      const e = updateEntry(props.entry.id, { ...patch, auto: buildAutoPatch() })
      emit('submitted', e)
    } else {
      const e = updateEntry(props.entry.id, patch)
      emit('submitted', e)
    }
  } catch (err) {
    error.value = (err as Error).message
  }
}

/** 更正时，auto 始终可改（归档参数记错了也靠更正修） */
function buildAutoPatch(): Partial<LedgerAuto> {
  const a = buildAuto()
  return {
    cutLengthMm: a.cutLengthMm,
    segmentCount: a.segmentCount,
    shapeCount: a.shapeCount,
    layerCount: a.layerCount,
    paper: a.paper,
    paperLabel: a.paperLabel,
    materialName: a.materialName,
    backing: a.backing,
    force: a.force,
    speedMmS: a.speedMmS,
    passes: a.passes,
  }
}

const actualCutPreview = computed(() => Math.round((num(form.cutLengthMm) * Math.max(1, num(form.passes))) * 10) / 10)
</script>

<template>
  <div class="editor-mask" @click.self="emit('close')">
    <div class="editor">
      <div class="editor-head">
        {{ title }}
        <span class="spacer"></span>
        <button class="tiny ghost" @click="emit('close')">关闭</button>
      </div>

      <div class="editor-body">
        <div v-if="isCorrect && entry" class="banner warn">
          原记录保持不变（归档不可改）；保存后会新增一条更正记录，汇总与导出以最新更正值为准。
          <div class="hint" style="margin-top:4px">
            原值：{{ entry.auto.cutLengthMm.toFixed(0) }}mm / {{ entry.auto.segmentCount }} 段 / {{ entry.auto.paperLabel }} /
            用纸 {{ entry.manual.sheetsUsed }} 张 / 工时 {{ entry.manual.minutesSpent }} 分钟
          </div>
        </div>

        <div class="grid2">
          <div class="field">
            <label>作业时间</label>
            <input type="datetime-local" v-model="form.jobAt" />
          </div>
          <div class="field">
            <label>操作人 *</label>
            <input type="text" list="ledger-operators" v-model="form.operator" placeholder="上机操作人" />
            <datalist id="ledger-operators">
              <option v-for="o in operators" :key="o" :value="o" />
            </datalist>
          </div>
        </div>

        <div v-if="isCreate" class="field">
          <label>来自项目</label>
          <select v-model="form.projectKey" @change="onProjectChange">
            <option :value="FREE">无项目（手工填写，不绑定纹样项目）</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <div v-if="form.projectKey !== FREE" class="hint">选择项目后自动带出整场刀路情况；可先在「导出」页下载刀路让系统自动记一笔。</div>
        </div>

        <div class="field">
          <label>纹样内容（这次做的是什么）</label>
          <input type="text" v-model="form.formName" :disabled="isCreate && form.projectKey !== FREE" placeholder="如：经典八角窗花 ×4" />
        </div>

        <div class="section-title">上机切割基本情况{{ isCreate ? '（选了项目自动带出）' : '' }}</div>
        <div class="grid2">
          <div class="field">
            <label>整场刀路长度 (mm)</label>
            <input type="number" min="0" step="0.1" v-model.number="form.cutLengthMm" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>刀路段数</label>
            <input type="number" min="0" step="1" v-model.number="form.segmentCount" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>形状数</label>
            <input type="number" min="1" step="1" v-model.number="form.shapeCount" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>图层数</label>
            <input type="number" min="1" step="1" v-model.number="form.layerCount" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>纸张</label>
            <select v-model="form.freePaper" :disabled="autoLocked" @change="onPaperChange">
              <option v-for="k in PAPER_KINDS" :key="k.paper" :value="k.paper">{{ k.label }}</option>
            </select>
          </div>
          <div class="field">
            <label>材料预设 / 说明</label>
            <input type="text" v-model="form.freeMaterial" :disabled="autoLocked" placeholder="如：红纸剪纸（非遗）" />
          </div>
          <div class="field">
            <label>刀压</label>
            <input type="number" min="0" v-model.number="form.force" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>速度 (mm/s)</label>
            <input type="number" min="0" v-model.number="form.speedMmS" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>重复遍数</label>
            <input type="number" min="1" step="1" v-model.number="form.passes" :disabled="autoLocked" />
          </div>
          <div class="field">
            <label>实际走刀 (mm，含遍数)</label>
            <input type="text" :value="actualCutPreview.toFixed(1)" disabled />
          </div>
        </div>

        <div class="section-title">人工补录</div>
        <div class="grid2">
          <div class="field">
            <label>实际用纸 (张)</label>
            <input type="number" min="0" step="1" v-model.number="form.sheetsUsed" />
          </div>
          <div class="field">
            <label>花费时间 (分钟)</label>
            <input type="number" min="0" step="1" v-model.number="form.minutesSpent" />
          </div>
          <div class="field">
            <label>废品 (张)</label>
            <input type="number" min="0" step="1" v-model.number="form.wasteSheets" />
          </div>
          <div class="field">
            <label>客户</label>
            <input type="text" v-model="form.customer" placeholder="客户名称（客户清单用）" />
          </div>
        </div>
        <div class="field">
          <label>废品原因（废了几张必填）</label>
          <input type="text" v-model="form.wasteReason" placeholder="如：第 2 张走纸偏移重切；连刀点开大了" />
        </div>
        <div class="field">
          <label>备注</label>
          <textarea v-model="form.note" rows="2"></textarea>
        </div>

        <div v-if="isCorrect" class="field">
          <label>更正原因 *</label>
          <textarea v-model="form.correctReason" rows="2" placeholder="为什么更正（如：刀压记错，实际 100；废品漏记 1 张走纸偏移）"></textarea>
        </div>

        <div v-if="dupInfo" class="banner err">
          {{ error }}
          <div class="field" style="margin-top:6px">
            <label>强制登记原因 *</label>
            <input type="text" v-model="form.dupReason" placeholder="如：同图样当天追加的第二单（客户加订）" />
          </div>
        </div>
        <div v-else-if="error" class="banner err">{{ error }}</div>
      </div>

      <div class="editor-foot">
        <span class="hint" v-if="readonlyArchived">归档记录不可修改，只能新增更正（关闭后在列表点「更正」）</span>
        <span class="spacer"></span>
        <button @click="emit('close')">{{ readonlyArchived ? '关闭' : '取消' }}</button>
        <button v-if="!readonlyArchived" class="primary" @click="save">{{ isCorrect ? '提交更正' : isCreate ? '登记' : '保存' }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-mask {
  position: fixed;
  inset: 0;
  background: rgba(8, 11, 15, 0.62);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}

.editor {
  width: min(560px, 100%);
  height: 100%;
  background: var(--panel);
  border-left: 1px solid var(--line);
  display: flex;
  flex-direction: column;
}

.editor-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel-2);
  font-weight: 600;
  flex: 0 0 auto;
}

.editor-head .spacer {
  margin-left: auto;
}

.editor-body {
  padding: 12px 14px;
  overflow: auto;
  flex: 1 1 auto;
}

.editor-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-top: 1px solid var(--line);
  background: var(--panel-2);
  flex: 0 0 auto;
}

.editor-foot .spacer {
  margin-left: auto;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 10px;
}

.banner {
  padding: 7px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 12px;
}

.banner.warn {
  background: rgba(255, 200, 87, 0.1);
  border: 1px solid rgba(255, 200, 87, 0.4);
  color: var(--warn);
}

.banner.err {
  background: rgba(255, 107, 107, 0.12);
  border: 1px solid rgba(255, 107, 107, 0.4);
  color: #ffb3b3;
}
</style>
