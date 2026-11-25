#!/usr/bin/env node
/**
 * 手机轮询的替身：每 5 秒打一次 /taskwatch/data（8 秒超时，和页面一致），
 * 记录失败的状态码、耗时、响应体片段，以及两次成功之间的间隔。
 *
 *   TW_TOKEN=... node scripts/watch-polls.mjs [秒数] [间隔ms]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = (process.env.TW_BASE || 'https://dsh.dionysusding.cn').replace(/\/+$/, '')
const TOKEN = process.env.TW_TOKEN || readFileSync(join(process.cwd(), '.token'), 'utf8').trim()
const TOTAL = Math.max(30, Number(process.argv[2] || 900))
const EVERY = Math.max(1000, Number(process.argv[3] || 5000))

const started = Date.now()
let i = 0, ok = 0
const failures = []
let lastOk = 0
let maxGap = 0
let gapFrom = ''
const gaps = []

function ts() {
  return new Date().toTimeString().slice(0, 8)
}

while ((Date.now() - started) / 1000 < TOTAL) {
  i++
  const t0 = performance.now()
  const ac = new AbortController()
  const to = setTimeout(() => ac.abort(), 8000)
  let status = 0, body = '', err = ''
  try {
    const r = await fetch(BASE + '/taskwatch/data?view=phone', {
      headers: { authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
      signal: ac.signal,
    })
    status = r.status
    body = (await r.text()).slice(0, 240)
    if (r.ok) {
      ok++
      const now = Date.now()
      if (lastOk) {
        const gap = Math.round((now - lastOk) / 1000)
        if (gap > maxGap) { maxGap = gap; gapFrom = ts() }
        if (gap > 8) gaps.push({ at: ts(), gap })
      }
      lastOk = now
    } else {
      failures.push({ at: ts(), status, ms: Math.round(performance.now() - t0), body })
      console.log(`FAIL ${ts()} status=${status} ${Math.round(performance.now() - t0)}ms ${JSON.stringify(body.slice(0, 120))}`)
    }
  } catch (e) {
    err = e && e.name === 'AbortError' ? 'timeout>8s' : (e && e.message) || String(e)
    failures.push({ at: ts(), status: 0, ms: Math.round(performance.now() - t0), err })
    console.log(`FAIL ${ts()} ${err} ${Math.round(performance.now() - t0)}ms`)
  } finally {
    clearTimeout(to)
  }
  await sleep(EVERY)
}

console.log('\n== summary ==')
console.log('requests', i, 'ok', ok, 'failures', failures.length)
console.log('max ok-to-ok gap', maxGap + 's', gapFrom ? 'at ' + gapFrom : '')
console.log('gaps>8s', JSON.stringify(gaps.slice(0, 10)))
for (const f of failures) console.log(JSON.stringify(f))
