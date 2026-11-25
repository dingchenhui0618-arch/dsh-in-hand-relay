#!/usr/bin/env node
/**
 * 连通性保活实验：从一台机器上压「手机 → nginx → SSH 反向隧道 → 中继 → DSH」
 * 这条真实链路，回答的不是「重连快不快」，而是「连接能不能一直活着」。
 *
 *   TW_BASE=https://dsh.example.com TW_TOKEN=... node scripts/soak.mjs
 *
 * 三段：
 *   1. 冷/热轮询：/healthz 与 /taskwatch/data?view=phone 各打 N 次，算 p50/p95，
 *      记录失败与超时——这一段对应手机上「运行记录是不是实时刷新」。
 *   2. 空闲 SSE：拿当前会话开 /taskwatch/chat/stream，故意什么都不做，握满
 *      --hold 秒。记录首字节、每条事件/心跳的间隔、流被谁掐断（自己结束还是
 *      链路上的超时）。nginx 默认 proxy_read_timeout 60s，没有心跳时这里会
 *      看到「60 秒整被关」——那就是手机端「一直重连」的来源。
 *   3. 断后重连：主动 abort，立刻重开 3 次，量「回到首字节」要多久。
 *
 * 判定（任何一条不满足退出码 1）：
 *   - 热轮询失败 0 次，p95 < 1500ms
 *   - SSE 握满全程没被掐断
 *   - 首字节 < 5s
 *   - 给了 --expect-heartbeat 时：心跳间隔 ≤ 20s（宿主 12s 一条注释帧）
 *
 * 环境变量：
 *   TW_BASE              远端入口，默认 https://dsh.dionysusding.cn
 *   TW_TOKEN             中继令牌（必填；只发 Authorization: Bearer，不进日志）
 *   TW_HOLD              空闲 SSE 握多久，秒，默认 180
 *   TW_POLLS             轮询次数，默认 30
 *   TW_EXPECT_HEARTBEAT  =1 时要求 SSE 有心跳帧
 *   TW_SESSION           指定会话 id，默认取 /taskwatch/data 里第一个 running
 */
import { performance } from 'node:perf_hooks'

const BASE = (process.env.TW_BASE || 'https://dsh.dionysusding.cn').replace(/\/+$/, '')
const TOKEN = process.env.TW_TOKEN || ''
const HOLD = Math.max(10, Number(process.env.TW_HOLD || 180))
const POLLS = Math.max(3, Number(process.env.TW_POLLS || 30))
const EXPECT_HEARTBEAT = process.env.TW_EXPECT_HEARTBEAT === '1'
const WANT_SESSION = process.env.TW_SESSION || ''
const TIMEOUT_MS = 40_000

if (!TOKEN) {
  console.error('缺 TW_TOKEN（中继令牌），拒绝跑空实验。')
  process.exit(2)
}

const headers = { authorization: `Bearer ${TOKEN}` }
const results = { base: BASE, poll: null, stream: null, reconnect: null, pass: true, notes: [] }

function fail(note) {
  results.pass = false
  results.notes.push(note)
}

function pct(sorted, p) {
  if (!sorted.length) return null
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[i]
}

function fmtMs(ms) {
  return ms == null ? '—' : `${ms.toFixed(0)}ms`
}

async function timed(pathname, opts = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || TIMEOUT_MS)
  const t0 = performance.now()
  try {
    const res = await fetch(BASE + pathname, {
      headers: { ...headers, ...(opts.headers || {}) },
      signal: ac.signal,
      redirect: 'manual',
    })
    const ms = performance.now() - t0
    return { res, ms, timedOut: false }
  } finally {
    clearTimeout(timer)
  }
}

async function warmPolls() {
  // 第一发是冷的：会话扫描 + 隧道刚建立。它单独报，不混进 p95。
  await timed('/healthz', { timeoutMs: 20_000 }).then(r => r.res.body?.cancel?.()).catch(() => {})
  const rows = []
  for (let i = 0; i < POLLS; i++) {
    const t0 = performance.now()
    try {
      const { res } = await timed('/taskwatch/data?view=phone')
      const body = await res.text()
      rows.push({ ok: res.ok, status: res.status, ms: performance.now() - t0, bytes: body.length })
    } catch (e) {
      rows.push({ ok: false, status: 0, ms: performance.now() - t0, error: String(e && e.name) })
    }
  }
  const okRows = rows.filter(r => r.ok)
  const times = okRows.map(r => r.ms).sort((a, b) => a - b)
  const summary = {
    attempts: rows.length,
    ok: okRows.length,
    failed: rows.length - okRows.length,
    failures: rows.filter(r => !r.ok).slice(0, 5),
    p50: pct(times, 50),
    p95: pct(times, 95),
    max: times.length ? times[times.length - 1] : null,
    min: times.length ? times[0] : null,
  }
  results.poll = summary
  if (summary.failed) fail(`轮询失败 ${summary.failed}/${rows.length} 次`)
  if (summary.p95 != null && summary.p95 > 1500) fail(`热轮询 p95 ${fmtMs(summary.p95)} > 1500ms`)
  return summary
}

async function pickSession() {
  const { res } = await timed('/taskwatch/data?view=phone')
  const json = await res.json()
  if (WANT_SESSION) return WANT_SESSION
  const list = Array.isArray(json.sessions) ? json.sessions : []
  const running = list.find(s => s && s.running && s.id)
  const any = list.find(s => s && s.id)
  return (running || any || {}).id || ''
}

/** 读 SSE：按空行切帧，记录每帧到达时间、类型、字节数；流被对端结束时立刻返回。 */
async function holdStream(sessionId, holdSeconds) {
  const ac = new AbortController()
  const url = `${BASE}/taskwatch/chat/stream?sessionId=${encodeURIComponent(sessionId)}&maxMessages=60`
  const t0 = performance.now()
  const frames = []
  let bytes = 0
  let endedBy = 'timeout' // timeout = 我们自己按秒数收；closed = 链路上被关
  let status = 0
  let ttfb = null
  let buf = ''

  const stopAt = t0 + holdSeconds * 1000
  // 截止时间是「赛跑」而不是只靠 abort：undici 在长连接上 abort 后 read()
  // 有时不再落地，整段实验会一直挂着（2026-11-25 实测 300s 那次卡在这里）。
  const deadline = new Promise((resolve) => setTimeout(resolve, holdSeconds * 1000))
  const timer = setTimeout(() => {
    endedBy = 'timeout'
    try { ac.abort() } catch { /* 已结束 */ }
  }, holdSeconds * 1000)
  const verbose = process.env.TW_VERBOSE === '1'

  try {
    const res = await fetch(url, { headers: { ...headers, accept: 'text/event-stream' }, signal: ac.signal })
    status = res.status
    if (!res.ok) {
      endedBy = 'http-error'
      clearTimeout(timer)
      return { status, frames, bytes, ttfb: null, endedBy, error: 'HTTP ' + res.status }
    }
    if (!res.body) throw new Error('没有 body')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    for (;;) {
      const hit = await Promise.race([
        reader.read().then((r) => ({ r })),
        deadline.then(() => ({ deadline: true })),
      ])
      if (hit.deadline) {
        endedBy = 'timeout'
        try { reader.cancel() } catch { /* 已结束 */ }
        break
      }
      const { value, done } = hit.r
      if (done) {
        endedBy = performance.now() < stopAt ? 'closed' : 'timeout'
        break
      }
      if (ttfb == null) ttfb = performance.now() - t0
      bytes += value.byteLength
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const at = performance.now() - t0
        const isComment = raw.startsWith(':')
        frames.push({ at, comment: isComment, kind: isComment ? raw.slice(1).trim() : 'data', bytes: raw.length })
        if (verbose && isComment) console.log(`  [${Math.round(at / 1000)}s] ${raw.trim()}`)
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      endedBy = performance.now() < stopAt ? 'aborted-early' : 'timeout'
    } else {
      endedBy = 'error'
      results.notes.push('SSE 读取异常：' + String(e && (e.code || e.message || e.name)))
    }
  } finally {
    clearTimeout(timer)
  }

  const commentFrames = frames.filter(f => f.comment)
  const gaps = []
  for (let i = 1; i < frames.length; i++) gaps.push(frames[i].at - frames[i - 1].at)
  const maxGap = gaps.length ? Math.max(...gaps) : null
  const heartbeatGaps = []
  for (let i = 1; i < commentFrames.length; i++) heartbeatGaps.push(commentFrames[i].at - commentFrames[i - 1].at)

  const summary = {
    status,
    heldSeconds: holdSeconds,
    ttfb,
    frames: frames.length,
    dataFrames: frames.length - commentFrames.length,
    heartbeats: commentFrames.length,
    bytes,
    endedBy,
    endedAt: performance.now() - t0,
    maxGap,
    heartbeatGaps,
    firstFrames: frames.slice(0, 6).map(f => ({ at: Math.round(f.at), kind: f.kind })),
  }
  results.stream = summary

  if (endedBy !== 'timeout') fail(`SSE 在 ${(summary.endedAt / 1000).toFixed(1)}s 被掐断（${endedBy}）`)
  if (ttfb != null && ttfb > 5000) fail(`SSE 首字节 ${fmtMs(ttfb)} > 5s`)
  if (EXPECT_HEARTBEAT) {
    if (!commentFrames.length) fail('EXPECT_HEARTBEAT=1 但整段没有任何心跳帧')
    else if (heartbeatGaps.length && Math.max(...heartbeatGaps) > 20_000) {
      fail(`心跳最大间隔 ${(Math.max(...heartbeatGaps) / 1000).toFixed(1)}s > 20s`)
    }
  } else if (!commentFrames.length && endedBy === 'timeout') {
    results.notes.push('整段没有心跳帧：如果链路上有 60s 空闲超时，这条流只是还没到点')
  }
  return summary
}

/** 断后重连：只量「再回到首字节」，不读正文。 */
async function reconnectProbe(sessionId, times = 3) {
  const rows = []
  for (let i = 0; i < times; i++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    const t0 = performance.now()
    try {
      const res = await fetch(`${BASE}/taskwatch/chat/stream?sessionId=${encodeURIComponent(sessionId)}&maxMessages=10`, {
        headers: { ...headers, accept: 'text/event-stream' },
        signal: ac.signal,
      })
      const reader = res.body?.getReader()
      let first = null
      if (reader) {
        const { value } = await reader.read()
        first = value ? performance.now() - t0 : null
        try { await reader.cancel() } catch {}
      }
      rows.push({ ok: res.ok, status: res.status, ttfb: first, total: performance.now() - t0 })
    } catch (e) {
      rows.push({ ok: false, status: 0, ttfb: null, error: String(e && e.name) })
    } finally {
      clearTimeout(timer)
    }
    await new Promise(r => setTimeout(r, 300))
  }
  const summary = {
    attempts: rows.length,
    ok: rows.filter(r => r.ok).length,
    ttfb: rows.map(r => (r.ttfb == null ? null : Math.round(r.ttfb))),
  }
  results.reconnect = summary
  if (summary.ok !== summary.attempts) fail(`重连失败 ${summary.attempts - summary.ok}/${summary.attempts} 次`)
  return summary
}

function report() {
  const L = []
  L.push(`基线：${BASE}`)
  L.push(`轮询 ${results.poll.attempts} 次 → 成功 ${results.poll.ok}，p50 ${fmtMs(results.poll.p50)}，p95 ${fmtMs(results.poll.p95)}，最大 ${fmtMs(results.poll.max)}`)
  const s = results.stream
  L.push(`空闲 SSE：${s.heldSeconds}s 窗口，状态 ${s.status}，首字节 ${fmtMs(s.ttfb)}，`)
  L.push(`  ${s.endedBy === 'timeout' ? '握满全程未被掐断' : `在 ${(s.endedAt / 1000).toFixed(1)}s 断了（${s.endedBy}）`}，`)
  L.push(`  帧 ${s.frames}（心跳 ${s.heartbeats} / 数据 ${s.dataFrames}），字节 ${s.bytes}，帧间最大空档 ${fmtMs(s.maxGap)}`)
  if (s.heartbeatGaps.length) {
    L.push(`  心跳间隔：${s.heartbeatGaps.map(g => (g / 1000).toFixed(1) + 's').join(' / ')}`)
  }
  L.push(`断后重连 ${results.reconnect.attempts} 次 → 成功 ${results.reconnect.ok}，首字节 ${results.reconnect.ttfb.map(fmtMs).join(' / ')}`)
  L.push(results.pass ? '判定：连通稳定（全部阈值通过）' : '判定：不稳定 → ' + results.notes.join('；'))
  console.log(L.join('\n'))
  console.log('\n--- JSON ---')
  console.log(JSON.stringify(results, null, 2))
}

const sessionId = await pickSession()
if (!sessionId) {
  console.error('拿不到会话 id，没法测 SSE。')
  process.exit(2)
}
console.log(`会话 ${sessionId}；先跑 ${POLLS} 次轮询……`)
await warmPolls()
console.log(`握 ${HOLD}s 空闲 SSE（故意不发请求）……`)
await holdStream(sessionId, HOLD)
await reconnectProbe(sessionId)
report()
process.exit(results.pass ? 0 : 1)
