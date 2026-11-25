#!/usr/bin/env node
/**
 * 把插件仓库 lib/ 下的页面外壳同步进 public/，并留下可核对的指纹记录。
 *
 * 为什么要有这个脚本：中继的 /taskwatch、/taskwatch/sw.js、/taskwatch/manifest
 * 读的都是本地 public/。插件升级了 UI 而这里没跟着换，手机拿到的就还是旧壳 ——
 * 页面 200、能跑，但看不到任何新东西。2026-11-25 就踩过这一次：public/page.html
 * 停在 10-12（181,175 B），远端界面还是一个月前的，HTTP 全绿、从外面查不出来。
 *
 * 发版前：
 *
 *   node scripts/sync-shell.mjs ../dsh-taskwatch
 *
 * 只检查、不写文件（CI / 发版前最后一道闸）：
 *
 *   node scripts/sync-shell.mjs --check ../dsh-taskwatch
 *
 * 检查模式会逐字节比对三个外壳文件，并核对 public/shell.json 里记的指纹：
 *   - 文件不一致 → 报「N 个文件与插件不同」，退出码 1
 *   - 文件一致但指纹记录缺失/过期 → 提示重跑同步（中继会把它标成 x-shell-sync: unknown/stale）
 *
 * 同步模式会写 public/shell.json（来源、插件版本、逐文件 SHA-256、同步时间），
 * 中继把它跟实际发出去的文件比对，响应头 /healthz 与 /taskwatch/shell.json 里
 * 就能看到 ok / stale —— 同类漂移下次在 curl -I 里就能发现。
 */
import { copyFileSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve, relative } from 'node:path'

const FILES = ['page.html', 'sw.js', 'manifest.webmanifest']

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const positional = argv.filter((a) => a !== '--check')
const src = resolve(positional[0] || process.env.TW_PLUGIN_REPO || '')
const outDir = join(process.cwd(), 'public')
const recordFile = join(outDir, 'shell.json')

if (!src || !existsSync(join(src, 'lib', 'page.html'))) {
  console.error('用法: node scripts/sync-shell.mjs [--check] <插件仓库路径>（例如 ../dsh-taskwatch）')
  process.exit(2)
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

let pluginVersion = 'unknown'
try { pluginVersion = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version || 'unknown' } catch { /* 用 unknown */ }

const problems = []
const rows = []
for (const f of FILES) {
  const from = join(src, 'lib', f)
  const to = join(outDir, f)
  if (!existsSync(from)) {
    problems.push(`插件仓库里缺 lib/${f}`)
    continue
  }
  if (!existsSync(to)) {
    problems.push(`中继 public/${f} 不存在（还没同步过）`)
    continue
  }
  const a = sha256(from)
  const b = sha256(to)
  rows.push({ f, from, to, a, b, same: a === b, bytes: statSync(to).size })
  if (a !== b) problems.push(`public/${f} 与插件不同（中继 ${statSync(to).size} B，插件 ${statSync(from).size} B）`)
}

// 指纹记录：文件一致但记录对不上，也说明"上次同步之后有人动过文件"。
let record = null
try { record = JSON.parse(readFileSync(recordFile, 'utf8')) } catch { /* 不存在 */ }
if (record && record.sha256 && rows.length) {
  const page = rows.find((r) => r.f === 'page.html')
  if (page && record.sha256 !== page.b) {
    problems.push(`public/shell.json 记的 page.html 指纹与当前文件不一致（记录 ${record.sha256.slice(0, 12)}…，实际 ${page.b.slice(0, 12)}…）`)
  }
  if (record.pluginVersion && pluginVersion !== 'unknown' && record.pluginVersion !== pluginVersion) {
    problems.push(`public/shell.json 记的插件版本 ${record.pluginVersion} 与插件当前 ${pluginVersion} 不一致`)
  }
} else if (!record) {
  problems.push('public/shell.json 不存在（同步一次即可生成；中继会标 x-shell-sync: unknown）')
}

if (checkOnly) {
  for (const r of rows) {
    console.log(`${r.same ? 'OK  ' : 'DIFF'}  ${r.f.padEnd(22)} ${String(r.bytes).padStart(8)} B  ${r.b.slice(0, 12)}…`)
  }
  if (record) console.log(`记录：插件 ${record.pluginVersion || '?'} @ ${record.syncedAt || '?'}`)
  if (problems.length) {
    console.error('\n外壳不同步：')
    for (const p of problems) console.error('  - ' + p)
    console.error('\n修法：node scripts/sync-shell.mjs ' + relative(process.cwd(), src).replace(/\\/g, '/'))
    process.exit(1)
  }
  console.log('\n外壳与插件一致，指纹记录也对得上。')
  process.exit(0)
}

for (const f of FILES) {
  const from = join(src, 'lib', f)
  if (!existsSync(from)) {
    console.error('插件仓库里缺: ' + from)
    process.exit(1)
  }
  copyFileSync(from, join(outDir, f))
  console.log(`同步 ${f.padEnd(22)} ${statSync(join(outDir, f)).size} B`)
}

const pageFile = join(outDir, 'page.html')
writeFileSync(recordFile, JSON.stringify({
  source: src.replace(/\\/g, '/'),
  pluginVersion,
  syncedAt: new Date().toISOString(),
  bytes: statSync(pageFile).size,
  sha256: sha256(pageFile),
  files: Object.fromEntries(FILES.map((f) => [f, {
    bytes: statSync(join(outDir, f)).size,
    sha256: sha256(join(outDir, f)),
  }])),
}, null, 2) + '\n')

console.log(`完成：远端刷新后 /taskwatch 与插件 ${pluginVersion} 是同一份外壳（指纹写进 public/shell.json）。`)
