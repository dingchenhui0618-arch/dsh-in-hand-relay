#!/usr/bin/env node
/**
 * 把插件仓库 lib/ 下的页面外壳同步进 public/。
 *
 * 中继的 /taskwatch、/taskwatch/sw.js、/taskwatch/manifest.webmanifest 都读本地
 * public/：插件升级了 UI（例如 v1.10.0 的简洁模式、运行进度条、连接诊断）而这里
 * 没跟着换，手机拿到的就还是旧壳 —— 页面 200、能跑，但看不到任何新东西。
 * 2026-11-25 就踩过这一次：public/page.html 停在 10-12，远端界面还是一个月前的。
 *
 * 发版前跑一次：
 *
 *   node scripts/sync-shell.mjs ../dsh-taskwatch
 *
 * 只复制这三个文件；图标本来就同源（哈希一致），不在这里动。
 */
import { copyFileSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const src = resolve(process.argv[2] || process.env.TW_PLUGIN_REPO || '')
const files = ['page.html', 'sw.js', 'manifest.webmanifest']

if (!src || !existsSync(join(src, 'lib', 'page.html'))) {
  console.error('用法: node scripts/sync-shell.mjs <插件仓库路径>（例如 ../dsh-taskwatch）')
  process.exit(2)
}

for (const f of files) {
  const from = join(src, 'lib', f)
  if (!existsSync(from)) {
    console.error('插件仓库里缺: ' + from)
    process.exit(1)
  }
  const to = join(process.cwd(), 'public', f)
  copyFileSync(from, to)
  console.log(`同步 ${f}  ${statSync(to).size} B`)
}

console.log('完成：远端刷新后 /taskwatch 与插件是同一份外壳。')
