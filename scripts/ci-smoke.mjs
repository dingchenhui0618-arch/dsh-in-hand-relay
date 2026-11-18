#!/usr/bin/env node
/**
 * CI smoke test for dsh-in-hand-relay.
 *
 * Starts the real `server.mjs` on a loopback port with a fixed token, then
 * asserts the properties SECURITY.md promises: the whitelist 404s, the token
 * gate answers 401/302 without a cookie, `/taskwatch/entries` answers with the
 * token, and the pairing code is only minted on loopback.
 *
 * 另外用真实 HTTP 验一遍换路票据（v3）：这里**自己签票**（十行 HMAC），不 import
 * server.mjs —— 那个文件一加载就会起监听。中继与插件共用同一份密钥，所以"宿主签的票
 * 中继能兑现"这件事可以直接在 CI 里复现。
 *
 * The upstream DSH (default 127.0.0.1:3080) is intentionally NOT running in
 * CI: every route this script touches is served by the relay itself, so the
 * smoke test proves the relay boots and enforces its gate without needing a
 * host. Routes that would proxy upstream are left alone.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const TOKEN = 'ci-smoke-token'
// 固定的 48 字符测试密钥（≥32 才有效）。只用于 CI，不是任何真实部署的密钥。
const TICKET_SECRET = 'ci-smoke-ticket-secret-0123456789abcdefghijklmno'
const TICKET_SECRET_WRONG = 'ci-smoke-wrong-secret-9876543210abcdefghijklmnop'
const PORT = 20000 + Math.floor(Math.random() * 20000)
const BASE = `http://127.0.0.1:${PORT}`

/**
 * 签一张票：与 dsh-in-hand/lib/ticket.js、server.mjs 的格式完全一致。
 *   v3 = 'v3.<expMs>.<nonce>.<aud>.<hmac>'
 *   v2 = 'v2.<expMs>.<nonce>.<hmac>'
 * hmac = HMAC-SHA256(secret, 'v3|expMs|nonce|aud')（v2 去掉 aud 一段）。
 */
function signTicket({ version = 3, aud = 'remote', ttlMs = 60_000, secret = TICKET_SECRET } = {}) {
  const expMs = Date.now() + ttlMs
  const nonce = randomBytes(16).toString('base64url')
  if (version === 2) {
    const hmac = createHmac('sha256', secret).update(`v2|${expMs}|${nonce}`).digest('base64url')
    return `v2.${expMs}.${nonce}.${hmac}`
  }
  const hmac = createHmac('sha256', secret).update(`v3|${expMs}|${nonce}|${aud}`).digest('base64url')
  return `v3.${expMs}.${nonce}.${aud}.${hmac}`
}

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    RELAY_BIND: '127.0.0.1',
    RELAY_TOKEN: TOKEN,
    RELAY_LAN: '0',
    // 固定公网入口，让 POST /taskwatch/ticket {to:"remote"} 有东西可回（不靠 Host 头学）。
    RELAY_PUBLIC_URL: 'https://ci.example.com',
    // 中继与插件共用这份密钥；CI 用固定值，绝不读用户 ~/.dsh 下的真密钥。
    TASKWATCH_TICKET_SECRET: TICKET_SECRET,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message)
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) fail(`relay exited early with code ${child.exitCode}`)
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.status === 200 && (await r.text()) === 'ok') return
    } catch {
      /* not listening yet */
    }
    await sleep(200)
  }
  fail('relay did not answer /healthz within 20s')
}

async function expect(path, { status, contains, init } = {}) {
  const r = await fetch(`${BASE}${path}`, { redirect: 'manual', ...(init || {}) })
  const body = await r.text()
  if (status !== undefined && r.status !== status) {
    fail(`${path}: expected ${status}, got ${r.status} (${body.slice(0, 200)})`)
  }
  if (contains !== undefined && !body.includes(contains)) {
    fail(`${path}: body does not contain ${JSON.stringify(contains)} (${body.slice(0, 200)})`)
  }
  return { status: r.status, body, headers: r.headers }
}

async function run() {
  await waitForHealth()

  // 1. Loopback-only binding promise: the server is reachable and alive.
  console.log('OK   /healthz answers ok')

  // 2. No token => the read API is closed, and a browser navigation is sent to
  //    the pairing page instead of a bare 401.
  await expect('/taskwatch/data', { status: 401 })
  await expect('/taskwatch', {
    status: 302,
    init: { headers: { accept: 'text/html' } },
  })
  console.log('OK   unauthenticated /taskwatch/data is 401 and /taskwatch redirects to pairing')

  // 3. Token gate opens: /taskwatch/entries is served locally (no upstream).
  await expect(`/taskwatch/entries?k=${TOKEN}`, { status: 200, contains: '"ok":true' })
  console.log('OK   /taskwatch/entries accepts the token')

  // 4. First ?k= visit is swapped for an HttpOnly cookie and redirected to a
  //    clean URL, so the token does not stay in the address bar.
  const first = await fetch(`${BASE}/taskwatch?k=${TOKEN}`, {
    redirect: 'manual',
    headers: { accept: 'text/html' },
  })
  if (first.status !== 302) fail(`/taskwatch?k=<token>: expected 302, got ${first.status}`)
  if (first.headers.get('location') !== '/taskwatch') {
    fail(`/taskwatch?k=<token>: expected Location /taskwatch, got ${first.headers.get('location')}`)
  }
  const cookie = first.headers.get('set-cookie') || ''
  if (!/^tw=.*HttpOnly/i.test(cookie)) fail(`/taskwatch?k=<token>: missing HttpOnly tw cookie (${cookie})`)
  console.log('OK   ?k= login sets an HttpOnly cookie and redirects to a clean URL')

  // 5. The whitelist is the capability boundary: anything not listed is 404.
  await expect('/api/private', { status: 404 })
  await expect('/etc/passwd', { status: 404 })
  console.log('OK   non-whitelisted paths are 404')

  // 6. Pairing codes are minted on loopback only; the format is 6 digits.
  const pair = await expect('/taskwatch/pair/new', { status: 200 })
  const code = JSON.parse(pair.body)
  if (!code.ok || !/^[0-9]{6}$/.test(String(code.code))) {
    fail(`/taskwatch/pair/new: unexpected payload ${pair.body.slice(0, 200)}`)
  }
  console.log('OK   loopback pairing code is 6 digits')

  // 7. Capacity advertisement: the plugin reads these to choose v3 over v2.
  const hz = await fetch(`${BASE}/healthz`)
  const hzBody = await hz.text()
  if (hz.status !== 200 || hzBody !== 'ok') fail(`/healthz: expected 200 ok, got ${hz.status} ${hzBody.slice(0, 80)}`)
  if (hz.headers.get('x-taskwatch-ticket-versions') !== '3,2') {
    fail(`/healthz: expected x-taskwatch-ticket-versions "3,2", got ${JSON.stringify(hz.headers.get('x-taskwatch-ticket-versions'))}`)
  }
  console.log('OK   /healthz declares x-taskwatch-ticket-versions: 3,2')

  // 8. lan.json is unauthenticated, declares the same capabilities, and never
  //    carries the ticket secret.
  const lan = await expect('/taskwatch/lan.json', { status: 200 })
  const lanJson = JSON.parse(lan.body)
  if (JSON.stringify(lanJson.ticketVersions) !== '[3,2]') {
    fail(`/taskwatch/lan.json: expected ticketVersions [3,2], got ${JSON.stringify(lanJson.ticketVersions)}`)
  }
  if (lanJson.ticketAudience !== 'remote') {
    fail(`/taskwatch/lan.json: expected ticketAudience "remote", got ${JSON.stringify(lanJson.ticketAudience)}`)
  }
  if (lan.body.includes(TICKET_SECRET)) fail('/taskwatch/lan.json: must never contain the ticket secret')
  console.log('OK   /taskwatch/lan.json declares ticketVersions [3,2] and ticketAudience remote')

  // 9. A ticket signed by the plugin host (same secret, v3, aud=remote) is
  //    redeemed exactly like one minted by the relay: 302 + HttpOnly cookie.
  const redeemV3 = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 3, aud: 'remote' }))}`, {
    redirect: 'manual',
  })
  await redeemV3.text()
  if (redeemV3.status !== 302) fail(`v3 remote ticket: expected 302, got ${redeemV3.status}`)
  if (redeemV3.headers.get('location') !== '/taskwatch') {
    fail(`v3 remote ticket: expected Location /taskwatch, got ${redeemV3.headers.get('location')}`)
  }
  if (!/^tw=.*HttpOnly/i.test(redeemV3.headers.get('set-cookie') || '')) {
    fail(`v3 remote ticket: missing HttpOnly tw cookie (${redeemV3.headers.get('set-cookie')})`)
  }
  console.log('OK   v3/aud=remote ticket redeems to 302 with an HttpOnly cookie')

  // 10. Strictly single use: the very same ticket a second time is 401.
  const replayUrl = `${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 3, aud: 'remote' }))}`
  const firstUse = await fetch(replayUrl, { redirect: 'manual' })
  await firstUse.text()
  if (firstUse.status !== 302) fail(`replay setup: expected the fresh ticket to redeem, got ${firstUse.status}`)
  const replay = await fetch(replayUrl, { redirect: 'manual' })
  await replay.text()
  if (replay.status !== 401) fail(`v3 replay: expected 401, got ${replay.status}`)
  console.log('OK   v3 tickets are strictly single-use (replay is 401)')

  // 11. Audience binding: a lan ticket must not be redeemable by the public relay.
  const lanTicket = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 3, aud: 'lan' }))}`, {
    redirect: 'manual',
  })
  await lanTicket.text()
  if (lanTicket.status !== 401) fail(`v3/aud=lan ticket: expected 401, got ${lanTicket.status}`)
  console.log('OK   v3/aud=lan ticket is rejected (401)')

  // 12. Wrong secret: shape is valid, signature is not.
  const wrong = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 3, secret: TICKET_SECRET_WRONG }))}`, {
    redirect: 'manual',
  })
  await wrong.text()
  if (wrong.status !== 401) fail(`wrong-secret ticket: expected 401, got ${wrong.status}`)
  console.log('OK   ticket signed with a different secret is rejected (401)')

  // 13. Expired: correctly signed but past its expMs.
  const expired = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 3, ttlMs: -1_000 }))}`, {
    redirect: 'manual',
  })
  await expired.text()
  if (expired.status !== 401) fail(`expired ticket: expected 401, got ${expired.status}`)
  console.log('OK   expired ticket is rejected (401)')

  // 14. v2 stays accepted during the sunset window (until 2027-01-01), so an
  //     old plugin + new relay keeps working; after the shared deadline the
  //     relay must reject it. Keep this date in sync with TICKET_V2_SUNSET_AT
  //     in server.mjs (and with the plugin's constant).
  const V2_SUNSET_AT = Date.UTC(2027, 0, 1, 0, 0, 0)
  const v2Expected = Date.now() < V2_SUNSET_AT ? 302 : 401
  const v2 = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(signTicket({ version: 2 }))}`, { redirect: 'manual' })
  await v2.text()
  if (v2.status !== v2Expected) fail(`v2 ticket: expected ${v2Expected}, got ${v2.status}`)
  console.log(`OK   v2 ticket follows the sunset rule (${v2Expected} today)`)


  // 15. The relay's own POST /taskwatch/ticket still mints a redeemable v3
  //     ticket (the switch-link feature existed before this change).
  const mint = await fetch(`${BASE}/taskwatch/ticket?k=${TOKEN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'remote' }),
  })
  const minted = await mint.json()
  const mintedTicket = typeof minted.url === 'string' ? new URL(minted.url).searchParams.get('t') : null
  if (mint.status !== 200 || !minted.ok || !mintedTicket) {
    fail(`/taskwatch/ticket: unexpected payload ${mint.status} ${JSON.stringify(minted).slice(0, 200)}`)
  }
  const mintedRedeem = await fetch(`${BASE}/taskwatch?t=${encodeURIComponent(mintedTicket)}`, { redirect: 'manual' })
  await mintedRedeem.text()
  if (mintedRedeem.status !== 302) fail(`relay-minted ticket: expected 302, got ${mintedRedeem.status}`)
  console.log('OK   POST /taskwatch/ticket mints a redeemable v3 ticket')

  console.log('PASS relay smoke test')
}

let failed = false
try {
  await run()
} catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof SmokeFailure ? error.message : error}`)
  console.error('--- relay log ---')
  console.error(log)
} finally {
  child.kill()
  await once(child, 'exit').catch(() => {})
}
if (failed) process.exitCode = 1
