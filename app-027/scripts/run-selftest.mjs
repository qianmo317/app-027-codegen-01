// 自检运行器（Node）：esbuild 打包 selftest，polyfill fetch/performance/localStorage
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const result = await build({
  entryPoints: [join(root, 'src/logic/selftest.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': join(root, 'src') },
  define: { 'import.meta.env.BASE_URL': '"/"' },
})

const code = result.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')

// polyfills
import { parseHTML } from 'linkedom'
const { DOMParser } = parseHTML(`<!doctype html><html><body></body></html>`)
globalThis.DOMParser = DOMParser
globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000n) / 1e6 }
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
}
globalThis.fetch = async (url) => {
  const m = /patterns\/([^?]+)$/.exec(String(url))
  if (!m) throw new Error('unexpected fetch ' + url)
  const text = readFileSync(join(root, 'public/patterns', m[1]), 'utf8')
  return { ok: true, status: 200, text: async () => text }
}

const mod = await import(dataUrl)
const report = await mod.runSelfTest()
const pass = report.checks.filter((c) => c.pass).length
const fail = report.checks.filter((c) => !c.pass).length
for (const c of report.checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.title}`)
  console.log(`       ${c.detail}`)
}
console.log(`\n${pass}/${report.checks.length} 通过${fail ? `，${fail} 失败` : ''}（总耗时 ${report.totalMs.toFixed(0)}ms）`)
writeFileSync(join(here, 'selftest-result.json'), JSON.stringify(report, null, 2))
process.exit(fail ? 1 : 0)
