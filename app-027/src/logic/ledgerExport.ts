import { toHours, toMeters, type LedgerFilter, type LedgerSummary } from './ledger'
import { paperLabel } from '@/data/materials'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function rangeTitle(f: LedgerFilter): string {
  if (f.from && f.to) return `${f.from} 至 ${f.to}`
  if (f.from) return `${f.from} 起`
  if (f.to) return `截至 ${f.to}`
  return '全部时间'
}

function rangeName(f: LedgerFilter): string {
  if (f.from && f.to) return `${f.from}_${f.to}`
  if (f.from) return `${f.from}_`
  if (f.to) return `_${f.to}`
  return '全部时间'
}

function fmtDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export type CustomerReportOpts = {
  studioName: string
  filter: LedgerFilter
  summary: LedgerSummary
}

/**
 * 客户清单（可直接打印 / 另存 PDF 的自包含 HTML）：
 * 只含可对客户展示的内容（作业内容、纸张、刀路、用纸、工时），不含废品原因与操作人等内部信息。
 */
export function buildCustomerReportHtml(opts: CustomerReportOpts): string {
  const { summary, filter, studioName } = opts
  const generatedAt = fmtDateTime(Date.now())
  const rows = summary.rows.map((ef) => {
    const e = ef.entry
    return [
      fmtDateTime(e.jobAt),
      esc(e.projectName || e.formName || '—'),
      esc(e.formName || '—'),
      esc(e.auto.paperLabel || paperLabel(e.auto.paper) || '—'),
      toMeters(e.auto.cutLengthMm).toFixed(2),
      String(e.manual.sheetsUsed || 0),
      toHours(e.manual.minutesSpent).toFixed(2),
    ]
  })
  const rowHtml = rows
    .map(
      (r) =>
        `      <tr>${r.map((c, i) => `<td${i === 4 || i === 5 || i === 6 ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`,
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>作业清单 ${esc(rangeTitle(filter))}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans GB', sans-serif; color: #111; margin: 0; padding: 28px 32px; font-size: 13px; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  .sub { color: #555; font-size: 12px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th, td { border: 1px solid #888; padding: 6px 8px; text-align: left; }
  th { background: #f0f0f0; font-weight: 600; font-size: 12px; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: 700; background: #fafafa; }
  .totals { display: flex; gap: 24px; margin: 10px 0 18px; flex-wrap: wrap; }
  .totals div { border: 1px solid #bbb; border-radius: 6px; padding: 8px 14px; }
  .totals .k { font-size: 11px; color: #666; }
  .totals .v { font-size: 18px; font-weight: 700; }
  .sign { margin-top: 28px; color: #333; font-size: 12px; }
  @media print { body { padding: 12mm; } button { display: none; } }
  @page { size: A4; margin: 12mm; }
</style>
</head>
<body>
  <button onclick="window.print()" style="margin-bottom:12px;padding:6px 14px;">打印 / 另存为 PDF</button>
  <h1>${esc(studioName)} · 作业清单</h1>
  <div class="sub">统计时段：${esc(rangeTitle(filter))}${filter.paper ? `｜纸张：${esc(paperLabel(filter.paper))}` : ''}｜生成时间：${generatedAt}｜共 ${summary.totals.count} 单</div>

  <div class="totals">
    <div><div class="k">合计用纸</div><div class="v">${summary.totals.sheetsUsed} 张</div></div>
    <div><div class="k">合计刀路</div><div class="v">${toMeters(summary.totals.cutMm).toFixed(2)} m</div></div>
    <div><div class="k">合计工时</div><div class="v">${toHours(summary.totals.minutes).toFixed(2)} h</div></div>
  </div>

  <table>
    <thead>
      <tr><th>作业时间</th><th>项目</th><th>纹样内容</th><th>纸张</th><th class="num">刀路 (m)</th><th class="num">用纸 (张)</th><th class="num">工时 (h)</th></tr>
    </thead>
    <tbody>
${rowHtml || '      <tr><td colspan="7" style="text-align:center;color:#888">该时段没有已登记作业</td></tr>'}
    </tbody>
    <tfoot>
      <tr><td colspan="4">合计</td><td class="num">${toMeters(summary.totals.cutMm).toFixed(2)}</td><td class="num">${summary.totals.sheetsUsed}</td><td class="num">${toHours(summary.totals.minutes).toFixed(2)}</td></tr>
    </tfoot>
  </table>

  <div class="sign">客户签字：________________　日期：____________</div>
</body>
</html>
`
}

export function customerReportFilename(filter: LedgerFilter): string {
  return `客户作业清单_${rangeName(filter)}.html`
}

// ---------------- 内部台账 CSV（含全部字段） ----------------

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const CSV_HEADERS = [
  '作业时间',
  '状态',
  '项目',
  '纹样内容',
  '形状数',
  '图层数',
  '纸张',
  '材料',
  '垫板',
  '刀路总长(mm)',
  '实际走刀(mm,含遍数)',
  '刀路段数',
  '刀压',
  '速度(mm/s)',
  '重复遍数',
  '连刀点宽(mm)',
  '纸幅',
  '批量排版',
  '用纸(张)',
  '工时(分钟)',
  '废品(张)',
  '废品原因',
  '操作人',
  '客户',
  '备注',
  '项目已删除',
  '更正',
  '更正原因',
  '来源',
  '登记时间',
]

export function buildInternalCsv(summary: LedgerSummary): string {
  const lines: string[] = [CSV_HEADERS.join(',')]
  for (const ef of summary.rows) {
    const e = ef.entry
    lines.push(
      [
        fmtDateTime(e.jobAt),
        ef.root.status === 'archived' ? '已归档' : '已登记',
        e.projectName,
        e.formName,
        e.auto.shapeCount,
        e.auto.layerCount,
        e.auto.paperLabel || paperLabel(e.auto.paper),
        e.auto.materialName,
        e.auto.backing,
        e.auto.cutLengthMm.toFixed(1),
        e.auto.actualCutMm.toFixed(1),
        e.auto.segmentCount,
        e.auto.force,
        e.auto.speedMmS,
        e.auto.passes,
        e.auto.bridgeWidthMm,
        `${e.auto.sheetWidthMm}×${e.auto.sheetHeightMm}mm ${e.auto.sheetName}`,
        e.auto.batch ? `${e.auto.batchCols}×${e.auto.batchRows}` : '',
        e.manual.sheetsUsed,
        e.manual.minutesSpent,
        e.manual.wasteSheets,
        e.manual.wasteReason,
        e.manual.operator,
        e.manual.customer,
        e.manual.note,
        e.projectDeleted ? '是' : '',
        ef.correction ? '已更正（取值为最新更正）' : '',
        ef.correction?.correctReason ?? '',
        e.source === 'export_auto' ? '导出自动' : '手工登记',
        fmtDateTime(e.recordedAt),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // 合计行
  lines.push(
    [
      '合计',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      summary.totals.cutMm.toFixed(1),
      summary.totals.actualCutMm.toFixed(1),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      summary.totals.sheetsUsed,
      summary.totals.minutes,
      summary.totals.wasteSheets,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ]
      .map(csvCell)
      .join(','),
  )
  // BOM 让 Excel 正确识别 UTF-8
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export function internalCsvFilename(filter: LedgerFilter): string {
  return `作业台账_${rangeName(filter)}.csv`
}
