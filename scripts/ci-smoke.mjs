#!/usr/bin/env node
/**
 * CI smoke test for dsh-in-hand-relay.
 *
 * Starts the real `server.mjs` on a loopback port with a fixed token, then
 * asserts the properties SECURITY.md promises: the whitelist 404s, the token
 * gate answers 401/302 without a cookie, `/taskwatch/entries` answers with the
 * token, and the pairing code is only minted on loopback.
 *
 * The upstream DSH (default 127.0.0.1:3080) is intentionally NOT running in
 * CI: every route this script touches is served by the relay itself, so the
 * smoke test proves the relay boots and enforces its gate without needing a
 * host. Routes that would proxy upstream are left alone.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'

const TOKEN = 'ci-smoke-token'
const PORT = 20000 + Math.floor(Math.random() * 20000)
const BASE = `http://127.0.0.1:${PORT}`

const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    RELAY_BIND: '127.0.0.1',
    RELAY_TOKEN: TOKEN,
    RELAY_LAN: '0',
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
  return { status: r.status, body }
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
