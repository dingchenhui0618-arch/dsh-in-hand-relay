#!/usr/bin/env node
/**
 * dsh-in-hand-relay —— 「掌上 DSH」的只读中继
 *
 * 为什么需要它：DSH 的 web GUI 本身没有任何认证，而本机默认文件权限常常是
 * danger-full-access。把这个 GUI 直接暴露到公网 = 把整台机器的控制权挂出去。
 * 但"看看任务跑到哪了"只需要读，所以这里在**另一个端口**上按白名单重发固定路径，
 * 其余一律 404 —— 操控面永远不出回环。
 *
 * 暴露面是硬编码白名单，不可配置成任意上游路径：
 *   GET  /taskwatch                       -> 本地上层外壳（见 PAGE_FILE），读不到才代理上游
 *   GET  /taskwatch/data                  -> <上游>/taskwatch/data      （JSON）
 *   GET  /taskwatch/session               -> <上游>/taskwatch/session   （单会话最近对话）
 *   其余 /taskwatch/chat/* 见下面 ROUTES 表（读 + 少量写，逐条注释了理由）
 *   GET  /taskwatch/manifest.webmanifest  -> 本地 public/（PWA 外壳）
 *   GET  /taskwatch/sw.js                 -> 本地 public/（PWA 外壳）
 *   GET  /taskwatch/icon-192.png|icon-512.png -> 本地 public/
 *   GET  /healthz                         -> 200，免鉴权，供看门狗探活
 *   GET  /taskwatch/lan | /taskwatch/lan.json  -> 免鉴权的局域网入口说明（不含凭据）
 *   GET  /taskwatch/pair                  -> 配对页；本机打开才显示 6 位码
 *   POST /taskwatch/pair/claim            -> 手机用 6 位码换 cookie
 *   GET/POST /taskwatch/pair/new          -> 只能从 127.0.0.1 取码
 *   GET  /taskwatch/entries               -> 当前有哪些入口（需令牌）
 *   GET  /taskwatch/upstream-health       -> 上游体检（需令牌）
 *   POST /taskwatch/ticket                -> 一次性换路凭据（需令牌）
 *   GET  /                                -> 302 到 /taskwatch 或 /taskwatch/pair
 *   其他任何路径、任何方法 -> 404。不代理 /api、不代理任意静态资源。
 *
 * 鉴权：共享令牌。三种携带方式，任一通过即可
 *   - ?k=<token>           首次访问用；校验通过后种 HttpOnly cookie 并跳转到去掉 k 的地址
 *   - Cookie: tw=<token>   后续请求自动带上（30 天，随请求滑动续期）
 *   - Authorization: Bearer <token>
 * 令牌首次运行自动生成 256 位随机值并写入同目录 .token（权限 0600）。
 *
 * 配置（全部可选，见 README 的完整表格）：
 *   RELAY_PORT         监听端口，默认 3099
 *   RELAY_BIND         监听地址，默认 127.0.0.1；开了局域网模式则默认 0.0.0.0
 *   RELAY_UPSTREAM     DSH 上游地址，默认 http://127.0.0.1:3080
 *   RELAY_TOKEN        直接指定令牌（优先级最高，不落盘）
 *   RELAY_LAN=1        开局域网模式（等价于放一个 .lan 标记文件）
 *   RELAY_LAN_ALL=1    局域网地址清单里也列出虚拟网卡（WSL / Hyper-V / VMware…）
 *   RELAY_PUBLIC_URL   公网入口（如 https://dsh.example.com）；不填则从 Host 头学
 *   RELAY_PAGE_FILE    覆盖页面外壳文件路径
 *   RELAY_SW_FILE      覆盖 service worker 文件路径
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.RELAY_PORT || 3099)

// 局域网模式：存在 .lan 标记文件（或 RELAY_LAN=1）就绑 0.0.0.0，同一 Wi-Fi 里的
// 手机可以直接连；默认仍然只绑回环。
//
// 为什么标记文件和环境变量两种都认：有人用看门狗/服务管理器拉起中继，那种脚本里
// 改环境变量要动别的东西；放个文件等价，而且"开没开"在目录里一眼可见
// （删掉文件就恢复仅回环）。两种方式都只是**开关**，不改变鉴权。
const LAN_MARKER = join(HERE, '.lan')
const LAN_MODE = process.env.RELAY_LAN === '1' || process.env.RELAY_LAN === 'true' || existsSync(LAN_MARKER)
const BIND = process.env.RELAY_BIND || (LAN_MODE ? '0.0.0.0' : '127.0.0.1')
const UPSTREAM = (process.env.RELAY_UPSTREAM || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const TOKEN_FILE = join(HERE, '.token')
const COOKIE = 'tw'
const PUBLIC_DIR = join(HERE, 'public')

// 页面外壳与 service worker 默认用本目录 public/ 下的同名文件，所以本项目中继
// 自己就是完整的（不需要别处再装什么）。想改用别处那份也行 ——
// 环境变量优先，其次才是本地 public/。
function resolveShell(envValue, localName) {
  const candidates = [
    { path: envValue, how: '环境变量' },
    { path: join(PUBLIC_DIR, localName), how: '本地 public/' },
  ].filter((c) => c.path)
  for (const c of candidates) {
    try {
      readFileSync(c.path)
      return c
    } catch { /* 试下一个 */ }
  }
  return null
}

// 页面外壳。读不到时退回"内建页面"（见 BUILTIN_PAGE），而不是 500 ——
// 一个缺失的静态文件不该让整条链路变成错误页。
const PAGE = resolveShell(process.env.RELAY_PAGE_FILE, 'page.html')
const PAGE_FILE = PAGE && PAGE.path

// service worker 必须和页面外壳同源同版本：这两个文件曾经各有一份、行为不同
// （一份不删旧缓存、也不认 /taskwatch/session），到底拿到哪个取决于请求先命中谁。
// 所以这里只认一次。
const SW = resolveShell(process.env.RELAY_SW_FILE, 'sw.js')

// 允许代理的上游路径：硬编码白名单，每条都带**显式** content-type 和允许的方法。
// 不按上游的响应头透传：中继自己决定发什么类型。
//
// 这里是**能力边界**：上游插件新增一条路由，必须在这里显式放行才会对外可见。
// 表里凡是标了 POST 的，都等于"把在宿主上驱动 agent 的能力开到了这条路上"。
// 改这一节之前先想清楚，并把风险写进 README 的安全模型。
const ROUTES = new Map([
  ['/taskwatch', { upstream: '/taskwatch', type: 'text/html; charset=utf-8' }],
  ['/taskwatch/data', { upstream: '/taskwatch/data', type: 'application/json; charset=utf-8' }],
  ['/taskwatch/session', { upstream: '/taskwatch/session', type: 'application/json; charset=utf-8' }],
  ['/taskwatch/chat/sessions', { upstream: '/taskwatch/chat/sessions', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  ['/taskwatch/chat/models', { upstream: '/taskwatch/chat/models', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  ['/taskwatch/chat/page', { upstream: '/taskwatch/chat/page', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  ['/taskwatch/chat/titles', { upstream: '/taskwatch/chat/titles', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  // 会话用量（轮次 / 步数 / token / 缓存命中 / 上下文占用）。**只读**，且只暴露数字：
  // 既不接受输入也不能驱动 agent，所以放行它不扩大上面说的那面边界。
  ['/taskwatch/chat/usage', { upstream: '/taskwatch/chat/usage', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  // 新建对话前先选工作区；只读，清单由上游插件算。
  ['/taskwatch/chat/workspaces', { upstream: '/taskwatch/chat/workspaces', type: 'application/json; charset=utf-8', methods: ['GET', 'HEAD'] }],
  // 交付文件：图片 / PDF / 文本 / 视频。同一路由下类型不固定，content-type 必须跟着
  // 上游走（图片和 PDF 不是同一个类型），所以这条单独标 passthroughType —— 其余路由
  // 仍然用写死的 type，避免上游返回什么都直接透给手机。
  // 真正的目录白名单 + 扩展名白名单在上游插件那一侧。
  ['/taskwatch/file', { upstream: '/taskwatch/file', type: 'application/octet-stream', methods: ['GET', 'HEAD'], passthroughType: true }],
  // stream 必须流式转发：上游是一次对话的 SSE，整段读完就变成"转圈到结束"。
  ['/taskwatch/chat/stream', { upstream: '/taskwatch/chat/stream', type: 'text/event-stream; charset=utf-8', methods: ['GET', 'HEAD'], stream: true }],
  // 附件上传：POST 原始二进制，大小上限由上游插件把关。
  // 它与其它写路由有两处必须不同的处理，见下面代理分支里的 upload 处理：
  //   1) 请求体**流式**转发 —— 默认路径 readBody(req, 64*1024) 是给小 JSON 包设计的，
  //      一张手机截图就能撞上限。
  //   2) 不吃 15 秒超时 —— 手机在外网上传几 MB，15 秒是常态而不是异常。
  ['/taskwatch/chat/upload', { upstream: '/taskwatch/chat/upload', type: 'application/json; charset=utf-8', methods: ['POST'], upload: true }],
  ['/taskwatch/chat/send', { upstream: '/taskwatch/chat/send', type: 'application/json; charset=utf-8', methods: ['POST'] }],
  ['/taskwatch/chat/create', { upstream: '/taskwatch/chat/create', type: 'application/json; charset=utf-8', methods: ['POST'] }],
  ['/taskwatch/chat/cancel', { upstream: '/taskwatch/chat/cancel', type: 'application/json; charset=utf-8', methods: ['POST'] }],
  ['/taskwatch/chat/model', { upstream: '/taskwatch/chat/model', type: 'application/json; charset=utf-8', methods: ['POST'] }],
])

// PWA 外壳：中继本地文件，不经过上游。同样是硬编码白名单。
const STATIC = new Map([
  ['/taskwatch/manifest.webmanifest', { file: join(PUBLIC_DIR, 'manifest.webmanifest'), type: 'application/manifest+json; charset=utf-8' }],
  ['/taskwatch/sw.js', { file: SW && SW.path, type: 'text/javascript; charset=utf-8' }],
  ['/taskwatch/icon-192.png', { file: join(PUBLIC_DIR, 'icon-192.png'), type: 'image/png' }],
  ['/taskwatch/icon-512.png', { file: join(PUBLIC_DIR, 'icon-512.png'), type: 'image/png' }],
])

function loadToken() {
  if (process.env.RELAY_TOKEN) return { token: process.env.RELAY_TOKEN, created: false, source: 'RELAY_TOKEN 环境变量' }
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return { token: t, created: false, source: TOKEN_FILE }
  }
  // 首次运行：自动生成 256 位随机令牌（32 字节 = 256 bit）。这一步是"别人拉下来就能跑"
  // 的关键 —— 不需要先去找谁要一个令牌，也不需要手工编辑任何文件。
  const t = randomBytes(32).toString('base64url')
  writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 })
  try { chmodSync(TOKEN_FILE, 0o600) } catch { /* Windows 上没有 POSIX 权限位，忽略 */ }
  return { token: t, created: true, source: TOKEN_FILE + '（本次新建）' }
}

const loaded = loadToken()
const TOKEN = loaded.token

/** 定长比较，避免用响应时间侧信道逐字节猜令牌。 */
function tokenEquals(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length !== y.length) return false
  return timingSafeEqual(x, y)
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** 从 query / cookie / Bearer 三处取令牌。
 *  返回 { ok, fromQuery, viaCookie } —— viaCookie 用来决定要不要滑动续期。 */
function authorize(req, url) {
  const q = url.searchParams.get('k')
  if (q && tokenEquals(q, TOKEN)) return { ok: true, fromQuery: true, viaCookie: false }
  const cookies = parseCookies(req.headers.cookie)
  if (cookies[COOKIE] && tokenEquals(cookies[COOKIE], TOKEN)) {
    return { ok: true, fromQuery: false, viaCookie: true }
  }
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Bearer ') && tokenEquals(auth.slice(7).trim(), TOKEN)) {
    return { ok: true, fromQuery: false, viaCookie: false }
  }
  return { ok: false, fromQuery: false, viaCookie: false }
}

// ── 配对码 ──────────────────────────────────────────────────────────────────
//
// 只把 256 位令牌拼进 URL 的问题：手机上要么存书签（一次误删就完）、要么每次翻令牌
// 文件，而且都没有"换一台设备"的正路。改成：在**这台电脑上**生成一个 6 位码，
// 手机输一次，换一个 30 天、且会滑动续期的 cookie。
//
// 安全边界（必须写清楚，因为"6 位数字"听着就弱）：
//   - 生成端点只接受来自 127.0.0.1 的连接 —— 只有能操作这台电脑的人取得到码；
//   - 有效期 120 秒，每个码最多试 5 次，用掉或过期立刻作废，同时只存在一个码；
//   - 单个来源连续失败 20 次封 10 分钟（防跨网段的暴力枚举）。
//   猜中概率是 5/1000000 量级，而且**不能离线爆破**（每次尝试都要打公网）。
//   对比把令牌贴在 URL 上：那条路径会被浏览历史、Referer、截图、剪贴板带走。
const COOKIE_MAX_AGE = 2592000        // 30 天
const PAIR_TTL_MS = 120 * 1000
const PAIR_MAX_TRIES = 5
const PAIR_FAIL_LIMIT = 20
const PAIR_FAIL_WINDOW = 10 * 60 * 1000
const pair = { code: null, expires: 0, tries: 0 }
const pairFails = new Map()           // ip -> { n, until }

/** 只认本机直连 —— 这是配对码的信任根，判断错了等于把码公开。
 *
 *  坑（实测踩到）：中继前面常常站着一个反向代理（公网流量经隧道进来），所以
 *  **公网请求的 remoteAddress 同样是 127.0.0.1**。只看 remoteAddress 的话，
 *  互联网上任何人打开 /taskwatch/pair 都会看到当前配对码。
 *  真正的判据是"有没有经过代理"：nginx 会加 X-Forwarded-For，本机直连不会。
 *  因此以 XFF 为准，且**失败即关闭**（见到代理头就一律不算本机）。 */
function isLocal(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers['forwarded']) return false
  const a = String((req.socket && req.socket.remoteAddress) || '')
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

/** 生成新码。用 randomBytes 而不是 Math.random —— 后者不是密码学随机的。 */
function newPairCode() {
  const n = randomBytes(4).readUInt32BE(0) % 1000000
  pair.code = String(n).padStart(6, '0')
  pair.expires = Date.now() + PAIR_TTL_MS
  pair.tries = 0
  return { code: pair.code, expiresAt: pair.expires, ttlSec: PAIR_TTL_MS / 1000 }
}

function pairAlive() { return Boolean(pair.code) && Date.now() < pair.expires }

/** 定长比较，和令牌那条一样，不给时间侧信道。 */
function pairEquals(input) {
  const a = Buffer.from(String(input || ''), 'utf8')
  const b = Buffer.from(String(pair.code || ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function cookieHeader() {
  return `${COOKIE}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`
}

function sendJson(res, status, obj, extraHeaders = {}) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(obj), extraHeaders)
}

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  })
  res.end(body)
}

/** 配对页。自包含 —— 不能依赖主页面那份 CSS/JS，因为它们本身也在鉴权后面。
 *
 *  同一个地址有两种面孔：
 *    - 从这台电脑打开：顶部直接显示当前配对码（生成只认本机）；
 *    - 从手机打开：只有输入框 —— 手机那边**生不出**码，只能兑换。
 *  这正是"只有能操作电脑的人才能授权设备"这条边界的 UX 表达。 */
const PAIR_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>连接到 DSH 助手</title>
<style>
 :root{
  --bg:#fff;--fg:#0f1115;--dim:#61666b;--faint:#81858c;--panel:#fff;--panel2:#f1f3f5;
  --line:#0000001a;--accent:#4176e6;--accent-fg:#fff;--bad:#ec1313;--ok:#22c55e;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
 }
 @media (prefers-color-scheme:dark){
  :root{--bg:#151517;--fg:#f9fafb;--dim:#cfd3d6;--faint:#adb2b8;--panel:#232324;
        --panel2:#2c2c2e;--line:#ffffff1f;--bad:#f25a5a}
 }
 *{box-sizing:border-box}
 body{margin:0;min-height:100vh;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);
      display:flex;align-items:center;justify-content:center;padding:24px;
      padding-bottom:calc(24px + env(safe-area-inset-bottom))}
 .b{width:100%;max-width:26rem}
 h1{margin:0 0 6px;font-size:20px}
 p{margin:0 0 14px;color:var(--dim);font-size:14.5px}
 label{display:block;font-size:13px;color:var(--faint);margin-bottom:6px}
 input{width:100%;height:60px;padding:0 14px;font:600 30px/1 var(--font);letter-spacing:.4em;
   text-align:center;color:var(--fg);background:var(--panel);border:1px solid var(--line);
   border-radius:12px;-webkit-appearance:none}
 input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
 button{width:100%;height:52px;margin-top:12px;border:0;border-radius:12px;background:var(--accent);
   color:var(--accent-fg);font:600 16px/1 var(--font);cursor:pointer}
 button:disabled{opacity:.45;cursor:default}
 .msg{min-height:22px;margin-top:12px;font-size:14px;color:var(--dim)}
 .msg.bad{color:var(--bad)} .msg.ok{color:var(--ok)}
 .hint{margin-top:18px;padding-top:14px;border-top:1px solid var(--line);color:var(--faint);font-size:13px}
 code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;background:var(--panel2);
   border-radius:6px;padding:1px 5px;word-break:break-all}
 .local{margin:0 0 18px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel2)}
 .local .t{font-size:13px;color:var(--dim);margin:0 0 6px}
 .local .c{font:700 34px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.18em;color:var(--fg)}
 .local .e{font-size:12.5px;color:var(--faint);margin-top:6px}
</style></head>
<body><div class="b">
<!--LOCAL-->
 <h1>连接到 DSH 助手</h1>
 <p>在这台电脑上取一个 6 位配对码输进来，之后 30 天内不用再输。</p>
 <label for="code">6 位配对码</label>
 <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
        pattern="[0-9]*" placeholder="------" aria-describedby="msg">
 <button id="go" type="button">连接</button>
 <div class="msg" id="msg" role="status" aria-live="polite"></div>
 <div class="hint">取码：在这台电脑上打开 <code><!--PAIRURL--></code>。
   配对码 2 分钟内有效，过期再取一个即可。</div>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var el = $('code'), go = $('go')
  function say(t, cls) { var m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : '') }
  function sync() { go.disabled = el.value.length !== 6 }
  el.addEventListener('input', function () {
    el.value = el.value.replace(/[^0-9]/g, '').slice(0, 6)
    sync()
  })
  sync()
  go.addEventListener('click', function () {
    if (el.value.length !== 6) return
    say('正在连接…'); go.disabled = true
    fetch('/taskwatch/pair/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: el.value })
    }).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) { return { s: r.status, j: j || {} } })
    }).then(function (x) {
      if (x.s === 200 && x.j.ok) { say('已连接，正在进入…', 'ok'); location.replace('/taskwatch'); return }
      say(x.j.error || '配对码不对或已过期', 'bad')
      el.value = ''; sync(); el.focus()
    }).catch(function () { say('网络不通，稍后再试', 'bad'); sync() })
  })
  el.focus()
})()
</script>
</body></html>`

/** 本机访问时插进页面的取码卡（含自动刷新，免得看着一个已经过期的码）。 */
function localCodeCard(info) {
  const secs = Math.max(0, Math.round((info.expiresAt - Date.now()) / 1000))
  return `<meta http-equiv="refresh" content="${Math.max(20, secs)}">
<div class="local"><p class="t">这台电脑上的配对码（在手机上输入它）</p>
<div class="c">${info.code}</div>
<div class="e">${secs} 秒后自动换新码 · 用掉一次即作废</div></div>`
}

/** 没有有效令牌、又是浏览器在导航要 HTML 时，送到配对页而不是甩一个 401。
 *  只认 text/html：fetch() 默认发 Accept: * / *，把它也当导航会让页面的
 *  fetch 收到 302 + 一段 HTML，response.json() 直接抛错。 */
function wantsHtml(req) {
  const a = String(req.headers.accept || '')
  return req.method === 'GET' && a.includes('text/html')
}

/** 读请求体，带上限。POST 的体都很小，但没上限就等于让人随便占内存。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        try { req.destroy() } catch { /* 已断开 */ }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ── 双入口（公网 / 局域网）──────────────────────────────────────────────────
// 手机在同一 Wi-Fi 里打开 http://<本机局域网 IP>:3099/taskwatch，走的是**同一套**
// 配对码流程：6 位码只在本机的 /taskwatch/pair 页面上显示，手机端只负责输入。
// 所以这条路不需要域名、不需要隧道、也不需要把令牌抄给任何人。
//
// 手机端**不可能**"探测一下再自动选"：https 页面不许探测 http:// 的局域网地址
// （混合内容被拦，IP 主机连"可升级"都不算），而中继经隧道看到的来源一律是
// 127.0.0.1，也看不出手机在哪个网络。所以判定只能放在页面里，靠"当前这条路是否
// 失败"来推。中继负责提供事实（有哪些入口、上游活不活）和**免输配对码的换路凭据**。
const PUBLIC_URL_FILE = join(HERE, '.public-url')
const TICKET_TTL_MS = 60 * 1000
const tickets = new Map()             // ticket -> 过期时间戳
const VIRTUAL_IFACE = /vEthernet|Hyper-V|WSL|VMware|VirtualBox|Loopback|docker|Bluetooth|TAP-/i

function readPublicUrl() {
  const fromEnv = String(process.env.RELAY_PUBLIC_URL || '').trim()
  if (fromEnv) return fromEnv.replace(/\/+$/, '')
  try {
    const t = readFileSync(PUBLIC_URL_FILE, 'utf8').trim()
    return t ? t.replace(/\/+$/, '') : ''
  } catch { return '' }
}
let publicUrl = readPublicUrl()

/** 公网入口不必手填：反向代理转发的请求带着 Host 头，第一次见到就记下来。
 *  只认真正的域名 —— 本机、局域网地址都不算公网入口。 */
function learnPublicUrl(req) {
  if (publicUrl) return
  const host = String(req.headers.host || '').trim()
  if (!host) return
  if (/^(127\.|localhost|\[::1\])/i.test(host)) return
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(host)) return
  if (!/^[A-Za-z0-9.\-]+(:\d+)?$/.test(host)) return
  publicUrl = 'https://' + host
  try { writeFileSync(PUBLIC_URL_FILE, publicUrl + '\n') } catch { /* 只读目录就只记在内存 */ }
  console.log('  公网入口  从 Host 头学到：' + publicUrl)
}

function mintTicket() {
  const now = Date.now()
  for (const [k, exp] of tickets) if (exp < now) tickets.delete(k)
  const t = randomBytes(18).toString('base64url')
  tickets.set(t, now + TICKET_TTL_MS)
  return t
}

/** 一次性兑换：换路成功即作废，重放无效，60 秒过期。 */
function redeemTicket(t) {
  const exp = tickets.get(t)
  if (!exp) return false
  tickets.delete(t)
  return exp > Date.now()
}

function lanAddresses() {
  const includeVirtual = process.env.RELAY_LAN_ALL === '1'
  const out = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    if (!includeVirtual && VIRTUAL_IFACE.test(name)) continue
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push({ iface: name, ip: addr.address })
    }
  }
  return out
}

function lanInfo() {
  const addrs = lanAddresses()
  return {
    lanMode: LAN_MODE,
    bind: BIND,
    port: PORT,
    publicUrl: publicUrl,
    markerFile: LAN_MARKER,
    addresses: addrs,
    entries: addrs.map((a) => 'http://' + a.ip + ':' + PORT + '/taskwatch'),
    pairing: 'http://127.0.0.1:' + PORT + '/taskwatch/pair',
  }
}

function lanPage() {
  const info = lanInfo()
  const list = info.entries.length
    ? info.entries.map((u) => '<li><code>' + u + '</code></li>').join('')
    : '<li class="dim">没找到局域网 IPv4 地址（网卡没连上 Wi-Fi？）</li>'
  const toggle = info.lanMode
    ? '当前<b class="on">已开启</b>。关掉：删除 <code>' + info.markerFile + '</code> 并重启中继（之后只监听回环）。'
    : '当前<b class="off">未开启</b>（只监听回环，只有本机与隧道能连）。开启：新建空文件 <code>' + info.markerFile + '</code> 并重启中继。'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>局域网入口 · 掌上 DSH</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:20px;font:15px/1.65 -apple-system,"Segoe UI",system-ui,sans-serif;max-width:760px}
 h1{font-size:19px;margin:0 0 4px}
 h2{font-size:15px;margin:22px 0 6px}
 code{background:color-mix(in srgb,currentColor 10%,transparent);padding:1px 5px;border-radius:4px;word-break:break-all}
 ul{padding-left:22px;margin:6px 0}
 li{margin:3px 0}
 .dim{opacity:.6}
 .on{color:#16a34a}.off{color:#d97706}
 .box{border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:10px;padding:12px 14px;margin:10px 0}
 .warn{border-color:#d97706}
 ol{padding-left:22px;margin:6px 0}
 footer{margin-top:22px;opacity:.6;font-size:13px}
</style></head><body>
<h1>局域网入口</h1>
<p>给「不想折腾域名和隧道」的人用：手机跟这台电脑连同一个 Wi-Fi 就能用。</p>
<div class="box">${toggle}</div>

<h2>手机怎么连</h2>
<ol>
 <li>在这台电脑上打开 <code>${info.pairing}</code>，页面上会显示一个 <b>6 位配对码</b>。</li>
 <li>手机（同一 Wi-Fi）打开下面任意一条：</li>
</ol>
<ul>${list}</ul>
<ol start="3"><li>在弹出的配对页里输入那 6 位码 —— 之后 30 天内不用再输。</li></ol>
<p class="dim">配对码 2 分钟有效、最多试 5 次、只能用一次，且只在 127.0.0.1 的页面上显示。</p>

<h2>这条路的硬限制（先知道再决定）</h2>
<ul>
 <li><b>http 不是安全上下文</b>：装不成 PWA、没有 service worker 离线外壳；摄像头/麦克风、剪贴板 API 也用不了。页面本身照常能用。</li>
 <li><b>只在同一局域网有效</b>：出了这个 Wi-Fi 就连不上（要外网就用隧道那条路）。</li>
 <li><b>信任边界</b>：任何拿到这个地址 + 配对码的人，等于拿到这台机器上的一个终端。只在自己信任的 Wi-Fi 上开，不用就把 <code>${info.markerFile}</code> 删掉。</li>
</ul>

<h2>想要又稳又有域名</h2>
<p>把「本机 → SSH 反向隧道 → 你自己的 nginx」换成 <b>Tailscale</b>（真证书、免公网服务器）或 <b>Cloudflare 具名隧道</b>（需要自有域名托管在 CF）。两者都能把上面这些限制一起消掉。</p>
<footer>本页由 dsh-in-hand-relay 提供，不含任何凭据 · <code>/taskwatch/lan.json</code> 是同一份数据的 JSON 版</footer>
</body></html>`
}

/** 内建页面外壳：public/page.html 缺失时用它，保证「刚 clone 下来也能打开」。
 *  它不是完整 UI（完整 UI 由上游的 dsh-in-hand 插件提供），但会把最关键的几件事
 *  说清楚：上游活不活、数据长什么样、另一条入口在哪、怎么配对。 */
const BUILTIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex,nofollow">
<title>掌上 DSH · 中继</title>
<style>
 :root{color-scheme:light dark;--dim:#6b7280;--line:#0000001f;--bad:#dc2626;--ok:#16a34a}
 body{margin:0;padding:18px;font:15px/1.65 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif;max-width:900px}
 h1{font-size:19px;margin:0 0 2px}
 h2{font-size:13px;margin:20px 0 6px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
 code,pre{font-family:ui-monospace,Menlo,Consolas,monospace}
 code{background:color-mix(in srgb,currentColor 10%,transparent);padding:1px 5px;border-radius:4px;word-break:break-all}
 pre{margin:0;padding:12px;border:1px solid var(--line);border-radius:10px;overflow:auto;max-height:60vh;font-size:12.5px;white-space:pre-wrap;word-break:break-word}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0}
 button{font:600 14px/1 inherit;padding:10px 14px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;cursor:pointer}
 .box{border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
 .box.bad{border-color:var(--bad)}
 .ok{color:var(--ok)} .err{color:var(--bad)} .dim{color:var(--dim)}
 ul{padding-left:20px;margin:6px 0}
</style></head><body>
<h1>掌上 DSH · 中继</h1>
<p class="dim">这是中继的内建兜底页（没读到 <code>public/page.html</code>）。完整界面由 DSH 上的 <b>dsh-in-hand</b> 插件提供：装上它之后这一页会自动换成真界面。</p>

<div class="box" id="health"><span class="dim">正在体检上游…</span></div>

<h2>入口</h2>
<div class="box" id="entries"><span class="dim">读取中…</span></div>

<h2>任务数据 /taskwatch/data</h2>
<div class="row"><button id="reload" type="button">刷新</button><span class="dim" id="stamp"></span></div>
<pre id="data">读取中…</pre>

<h2>配对</h2>
<div class="box">
 <p>在这台电脑上打开 <code id="pairurl"></code> 取 6 位配对码，然后在这里输入：</p>
 <div class="row">
  <input id="code" inputmode="numeric" maxlength="6" placeholder="6 位码" aria-label="6 位配对码"
    style="height:44px;padding:0 12px;font:600 20px/1 ui-monospace,monospace;letter-spacing:.3em;
    width:9em;text-align:center;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit">
  <button id="pair" type="button">连接</button>
  <span id="pmsg" class="dim"></span>
 </div>
</div>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id) }
  $('pairurl').textContent = location.protocol + '//' + location.host + '/taskwatch/pair'
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }
  function json(u, opt) {
    return fetch(u, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null
        try { j = JSON.parse(t) } catch (e) { /* 非 JSON（502 纯文本） */ }
        return { status: r.status, text: t, json: j }
      })
    })
  }
  function health() {
    json('/taskwatch/upstream-health').then(function (x) {
      var el = $('health'), j = x.json || {}
      if (x.status !== 200) {
        el.className = 'box bad'
        el.innerHTML = '<b class="err">上游体检失败</b> http ' + x.status + '<br><span class="dim">' + esc(x.text.slice(0, 300)) + '</span>'
        return
      }
      el.className = 'box' + (j.ok ? '' : ' bad')
      el.innerHTML = '<b>上游 DSH ' + (j.ok ? '<span class="ok">可达</span>' : '<span class="err">不可达</span>') + '</b><br>'
        + '<span class="dim">地址 <code>' + esc(j.upstream || '') + '</code> · 状态 ' + (j.status || 0) + ' · ' + j.ms + ' ms'
        + (j.error ? ' · ' + esc(j.error) : '') + '</span>'
        + (j.ok ? '' : '<br><span class="dim">检查：DSH 的 web 服务在监听吗？<code>RELAY_UPSTREAM</code> 写对了吗？</span>')
    }).catch(function (e) { $('health').className = 'box bad'; $('health').textContent = '上游体检请求失败：' + e })
  }
  function entries() {
    json('/taskwatch/entries').then(function (x) {
      var el = $('entries')
      if (x.status === 401) { el.innerHTML = '<span class="dim">需要令牌（在下面配对后刷新）</span>'; return }
      var j = x.json || {}
      var items = []
      if (j.remote) items.push('<li>公网：<code>' + esc(j.remote) + '/taskwatch</code></li>')
      ;(j.lan || []).forEach(function (u) { items.push('<li>局域网：<code>' + esc(u) + '</code></li>') })
      el.innerHTML = '<ul>' + (items.length ? items.join('') : '<li class="dim">只有一个入口</li>') + '</ul>'
        + '<span class="dim">你当前从 <b>' + esc(j.current || '?') + '</b> 进来 · 局域网模式 ' + (j.lanMode ? '已开' : '未开') + '</span>'
    }).catch(function (e) { $('entries').textContent = '读取入口失败：' + e })
  }
  function data() {
    json('/taskwatch/data').then(function (x) {
      $('stamp').textContent = new Date().toLocaleTimeString()
      if (x.status === 401) { $('data').innerHTML = '<span class="err">401 需要令牌</span> —— 先在下面配对，或用带 ?k= 的地址打开。'; return }
      if (x.status === 502) { $('data').innerHTML = '<span class="err">502：中继正常、上游 DSH 不可达</span>\\n\\n' + esc(x.text); return }
      $('data').textContent = x.json ? JSON.stringify(x.json, null, 2) : x.text.slice(0, 20000)
    }).catch(function (e) { $('data').textContent = '读取失败：' + e })
  }
  $('reload').addEventListener('click', function () { health(); entries(); data() })
  $('pair').addEventListener('click', function () {
    var v = $('code').value.replace(/[^0-9]/g, '')
    if (v.length !== 6) { $('pmsg').className = 'err'; $('pmsg').textContent = '需要 6 位数字'; return }
    json('/taskwatch/pair/claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: v }) })
      .then(function (x) {
        if (x.status === 200 && x.json && x.json.ok) { $('pmsg').className = 'ok'; $('pmsg').textContent = '已连接，刷新中…'; location.reload(); return }
        $('pmsg').className = 'err'; $('pmsg').textContent = (x.json && x.json.error) || ('失败 http ' + x.status)
      }).catch(function (e) { $('pmsg').className = 'err'; $('pmsg').textContent = '网络不通：' + e })
  })
  health(); entries(); data()
  setInterval(function () { if (!document.hidden) { health(); entries(); data() } }, 15000)
})()
</script>
</body></html>`

/** 根路径：能进就进，不能进就去配对页 —— 免得新人不知道该打开哪个地址。 */
function handleRoot(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, HEAD' })
    return
  }
  const dest = authorize(req, url).ok ? '/taskwatch' : '/taskwatch/pair'
  send(res, 302, 'text/plain; charset=utf-8', '', { location: dest })
}

const server = createServer(async (req, res) => {
  let url
  try {
    url = new URL(req.url, 'http://relay.invalid')
  } catch {
    send(res, 400, 'text/plain; charset=utf-8', 'bad request')
    return
  }

  // 看门狗探活：免鉴权，且不回显任何状态内容。
  if (url.pathname === '/healthz') {
    send(res, 200, 'text/plain; charset=utf-8', 'ok')
    return
  }

  // 根路径只是个指路牌。
  if (url.pathname === '/' || url.pathname === '/index.html') {
    handleRoot(req, res, url)
    return
  }

  // 顺手学一下公网入口（只在没配过时，且只认域名）。
  learnPublicUrl(req)

  // 换路凭据兑换：免鉴权（它就是用来换鉴权的），一次性、60 秒、重放无效。
  // 只作用在 /taskwatch 这一个路径上 —— 别去碰其他路由的 query。
  if (url.pathname === '/taskwatch' && url.searchParams.get('t')) {
    if (redeemTicket(url.searchParams.get('t'))) {
      res.writeHead(302, { location: '/taskwatch', 'set-cookie': cookieHeader(), 'cache-control': 'no-store' })
      res.end()
      return
    }
    send(res, 401, 'text/plain; charset=utf-8', '换路凭据无效或已过期，请再点一次切换。\n')
    return
  }

  // 局域网入口说明（免鉴权，但**不含任何凭据**，只列地址与步骤）。
  if (url.pathname === '/taskwatch/lan' || url.pathname === '/taskwatch/lan.json') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    if (url.pathname === '/taskwatch/lan.json') {
      sendJson(res, 200, lanInfo())
      return
    }
    send(res, 200, 'text/html; charset=utf-8', lanPage())
    return
  }

  // ── 配对：免鉴权，但三条各有自己的边界 ─────────────────────────────────
  if (url.pathname === '/taskwatch/pair') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, HEAD' })
      return
    }
    let html = PAIR_PAGE.replace('<!--PAIRURL-->', 'http://127.0.0.1:' + PORT + '/taskwatch/pair')
    // 本机访问顺手生成并展示一个码；手机访问就只是个输入框。
    if (isLocal(req)) {
      const info = pairAlive() ? { code: pair.code, expiresAt: pair.expires } : newPairCode()
      html = html.replace('<!--LOCAL-->', localCodeCard(info))
    } else {
      html = html.replace('<!--LOCAL-->', '')
    }
    send(res, 200, 'text/html; charset=utf-8', html)
    return
  }

  // 取码：**只能从本机**。这是整条链路的信任根 —— 能操作这台电脑的人才能授权设备。
  if (url.pathname === '/taskwatch/pair/new') {
    if (!isLocal(req)) { sendJson(res, 403, { ok: false, error: '只能在本机取码' }); return }
    if (req.method !== 'GET' && req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'GET, POST' })
      return
    }
    sendJson(res, 200, Object.assign({ ok: true }, newPairCode()))
    return
  }

  // 兑换：从手机来，必须免鉴权 —— 否则就是先有鸡还是先有蛋。
  if (url.pathname === '/taskwatch/pair/claim') {
    if (req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'POST' })
      return
    }
    const ip = String((req.socket && req.socket.remoteAddress) || '?')
    const fail = pairFails.get(ip)
    if (fail && fail.until > Date.now()) {
      sendJson(res, 429, { ok: false, error: '尝试次数过多，请过一会儿再试' })
      return
    }
    let body
    try { body = await readBody(req, 4096) }
    catch { sendJson(res, 400, { ok: false, error: '请求体不合法' }); return }
    let code = ''
    try { code = String((JSON.parse(body.toString('utf8')) || {}).code || '') } catch { code = '' }
    if (!pairAlive()) {
      sendJson(res, 400, { ok: false, error: '配对码已过期，请在电脑上重新取一个' })
      return
    }
    if (!/^[0-9]{6}$/.test(code) || !pairEquals(code)) {
      pair.tries++
      const rec = pairFails.get(ip) || { n: 0, until: 0 }
      rec.n++
      if (rec.n >= PAIR_FAIL_LIMIT) { rec.until = Date.now() + PAIR_FAIL_WINDOW; rec.n = 0 }
      pairFails.set(ip, rec)
      if (pair.tries >= PAIR_MAX_TRIES) { pair.code = null; pair.expires = 0 }
      sendJson(res, 400, {
        ok: false,
        error: pairAlive() ? '配对码不对' : '尝试次数用尽，请在电脑上重新取一个',
      })
      return
    }
    // 成功：一次性，用完立刻作废。
    pair.code = null; pair.expires = 0; pair.tries = 0
    pairFails.delete(ip)
    sendJson(res, 200, { ok: true }, { 'set-cookie': cookieHeader() })
    return
  }

  // ── 双入口：入口清单 / 换路凭据 / 上游体检（都要令牌）────────────────────
  if (url.pathname === '/taskwatch/entries' || url.pathname === '/taskwatch/ticket'
      || url.pathname === '/taskwatch/upstream-health') {
    if (!authorize(req, url).ok) {
      sendJson(res, 401, { ok: false, error: '需要中继令牌' })
      return
    }
    const info = lanInfo()

    if (url.pathname === '/taskwatch/entries') {
      const host = String(req.headers.host || '').replace(/:\d+$/, '')
      const isLanHost = info.addresses.some((a) => a.ip === host)
      sendJson(res, 200, {
        ok: true,
        remote: publicUrl,
        lan: info.entries,
        current: isLanHost ? 'lan' : (/^(127\.|localhost)$/i.test(host) ? 'local' : (publicUrl ? 'remote' : 'unknown')),
        lanMode: LAN_MODE,
      })
      return
    }

    if (url.pathname === '/taskwatch/upstream-health') {
      const started = Date.now()
      const probe = UPSTREAM + '/taskwatch/icon-192.png'
      try {
        const r = await fetch(probe, { signal: AbortSignal.timeout(4000) })
        sendJson(res, 200, { ok: r.ok, status: r.status, ms: Date.now() - started, upstream: UPSTREAM })
      } catch (err) {
        sendJson(res, 200, {
          ok: false, status: 0, ms: Date.now() - started, upstream: UPSTREAM,
          error: err && err.message ? err.message : String(err),
        })
      }
      return
    }

    // 换路凭据：告诉页面"另一条路在哪"，并给它一张一次性的通行证。
    if (req.method !== 'POST') {
      send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: 'POST' })
      return
    }
    let want = 'lan'
    try {
      const raw = await readBody(req, 1024)
      want = String((JSON.parse(raw.toString('utf8') || '{}') || {}).to) === 'remote' ? 'remote' : 'lan'
    } catch { /* 默认切到局域网 */ }
    const ticket = mintTicket()
    if (want === 'remote') {
      if (!publicUrl) { sendJson(res, 409, { ok: false, error: '还不知道公网入口（先经公网访问一次，或写 .public-url）' }); return }
      sendJson(res, 200, { ok: true, to: 'remote', url: publicUrl + '/taskwatch?t=' + ticket, expiresInMs: TICKET_TTL_MS })
      return
    }
    if (info.entries.length === 0) { sendJson(res, 409, { ok: false, error: '没有局域网地址，或中继没开局域网模式' }); return }
    const peer = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '')
    const sameSubnet = info.addresses.find((a) => a.ip.split('.').slice(0, 3).join('.') === peer.split('.').slice(0, 3).join('.'))
    const pick = sameSubnet || info.addresses[0]
    sendJson(res, 200, {
      ok: true, to: 'lan', address: pick.ip, iface: pick.iface,
      url: 'http://' + pick.ip + ':' + PORT + '/taskwatch?t=' + ticket, expiresInMs: TICKET_TTL_MS,
    })
    return
  }

  // 前缀路由只给"确实是一棵子树"的入口用：路径是活的（动作名 + 头像 id），
  // 逐个列举会随上游插件演进漂移。
  const route = ROUTES.get(url.pathname) ||
    [...ROUTES.entries()].find(([p, r]) => r.prefix && (url.pathname === p || url.pathname.startsWith(p + '/')))?.[1]
  const asset = STATIC.get(url.pathname)
  if (!route && !asset) {
    send(res, 404, 'text/plain; charset=utf-8', 'not found')
    return
  }

  // 方法检查放在路由查找**之后**：否则未知路径也回 405，
  // 把「没有这条路由」和「这条路由不吃这个方法」混成同一个现象。
  const allowed = route && route.methods ? route.methods : ['GET', 'HEAD']
  if (!allowed.includes(req.method)) {
    send(res, 405, 'text/plain; charset=utf-8', 'method not allowed', { allow: allowed.join(', ') })
    return
  }

  const auth = authorize(req, url)
  if (!auth.ok) {
    // 浏览器在导航（要 HTML）：送到配对页 —— 那才是"没登录"该看到的东西。
    // 一律甩 401 + 一段"请使用带令牌的完整地址"，等于让用户自己去翻服务器上的
    // .token 文件，手机端根本没法完成。
    // fetch/XHR 仍然回 401：让页面拿到明确状态码，而不是一段 HTML。
    if (wantsHtml(req)) {
      send(res, 302, 'text/plain; charset=utf-8', '', { location: '/taskwatch/pair' })
    } else {
      send(res, 401, 'text/plain; charset=utf-8', 'unauthorized')
    }
    return
  }

  // 滑动续期：只要这次是靠 cookie 进来的，就重新签一次 30 天。
  // cookie 若"种一次、30 天不自动续"，手机搁着不动就必然掉登录，
  // 而"掉登录"在手机端等于"再也进不去"（没人会去翻那台电脑上的 .token 文件）。
  // 页面每 5 秒轮询一次 /taskwatch/data，所以只要打开过一次就一直在续期。
  // 用 setHeader 而不是改各个 send()：writeHead 会与它合并，一处生效覆盖所有分支。
  if (!auth.fromQuery && auth.viaCookie) {
    res.setHeader('set-cookie', cookieHeader())
  }

  // 首次用 ?k= 进来：种 cookie 并跳转到不带令牌的地址，
  // 免得令牌留在地址栏、浏览历史、以及任何 Referer 里。
  // 只对 GET/HEAD 这么做 —— 对 POST 回 302 会让浏览器把请求体重发一遍，
  // 语义完全变了。
  if (auth.fromQuery && (req.method === 'GET' || req.method === 'HEAD')) {
    url.searchParams.delete('k')
    const rest = url.searchParams.toString()
    const location = url.pathname + (rest ? '?' + rest : '')
    send(res, 302, 'text/plain; charset=utf-8', '', {
      location,
      'set-cookie': cookieHeader(),
    })
    return
  }

  // PWA 外壳：本地文件，直接回，不碰上游。文件缺了就当这条路由不存在，
  // 而不是 500 —— 一个缺失的静态文件不该让整页变成错误。
  if (asset && asset.file) {
    let buf
    try {
      buf = readFileSync(asset.file)
    } catch {
      buf = undefined
    }
    if (buf !== undefined) {
      send(res, 200, asset.type, buf, { 'service-worker-allowed': '/taskwatch' })
      return
    }
  }

  // 页面外壳：优先用本目录 public/page.html（或 RELAY_PAGE_FILE 指的那份）。
  // 读不到就用内建兜底页 —— 保证 clone 下来就能打开，而不是 500。
  if (url.pathname === '/taskwatch') {
    if (PAGE_FILE) {
      let page
      try {
        page = readFileSync(PAGE_FILE)
      } catch {
        page = undefined
      }
      if (page !== undefined) {
        send(res, 200, 'text/html; charset=utf-8', page, { 'service-worker-allowed': '/taskwatch' })
        return
      }
    }
    send(res, 200, 'text/html; charset=utf-8', BUILTIN_PAGE, { 'service-worker-allowed': '/taskwatch' })
    return
  }

  // 必须带上剩余的查询串：/taskwatch/session 靠 ?id= 定位会话，
  // /taskwatch/chat/stream 靠 ?sessionId= 定位。
  // 这里漏过一次 —— 上游收到的一律是"缺少 id 参数"，接口看着 200 却是空的。
  // 转发前删掉 k：令牌只在本机中继这一层消费，绝不带给上游。
  url.searchParams.delete('k')
  // 前缀路由必须把请求里多出来的那段路径接到上游后面：
  // <prefix>/act -> UPSTREAM + <prefix> + /act。少了 suffix，动作名会被吃掉，
  // 所有 POST 都会打到快照那一条上，看起来能连、其实什么都没做。
  const suffix = route.prefix ? url.pathname.slice(route.upstream.length) : ''
  const target = UPSTREAM + route.upstream + suffix + (url.search || '')

  const headers = { accept: '*/*' }
  // 有些上游插件用 Origin 判来源、用自定义头认会话与 CSRF。中继默认只转 accept，
  // 于是插件看到的是「没有来源」，一律 403。只对前缀路由补，影响面限于那一个插件。
  // 这里**故意不转发** origin / referer / sec-fetch-site：插件用它们判断
  // 「是不是第一方请求」，而中继是宿主自己的本机组件（回环 + 令牌门禁），
  // 它替手机转话时不该冒充成一个跨站页面。剥掉这三个头，插件看到的就是一次
  // 第一方请求。真正的控制仍然是它自己的 CSRF 令牌 —— 只有从中继已鉴权的会话里
  // 才拿得到，跨站页面拿不到。会话与 set-cookie 反过来必须透传（见下面）。
  if (route.prefix) {
    for (const h of ['x-holdem-session', 'x-csrf-token']) {
      if (req.headers[h]) headers[h] = req.headers[h]
    }
  }
  let body
  if (req.method === 'POST') {
    headers['content-type'] = req.headers['content-type'] || 'application/json'
    if (route.upload) {
      // 附件：把请求流原样交给上游，不攒在内存里。攒完再发的表现是
      // 手机侧"点了上传、一直没反应"，而且几十 MB 的缓冲对中继没有意义。
      body = req
    } else {
      try {
        body = await readBody(req, 64 * 1024)
      } catch {
        send(res, 413, 'text/plain; charset=utf-8', '请求体过大')
        return
      }
    }
  }

  // 客户端断开时把上游也掐掉，否则一条被放弃的 SSE 会在宿主上
  // 一直挂着 follow（每个会话一条）。
  const ctl = new AbortController()
  res.on('close', () => ctl.abort())

  let upstreamResponse
  try {
    upstreamResponse = await fetch(target, {
      method: req.method === 'POST' ? 'POST' : 'GET',
      headers,
      body,
      // 请求体是流（附件上传）时 Node 要求显式声明 duplex。
      ...(route.upload ? { duplex: 'half' } : {}),
      // 流式路由**不能**挂 15 秒超时：一次对话可能持续几分钟，
      // 掐断的表现是"回复说到一半就没了"。改成跟着客户端连接走。
      // 附件上传同理：手机在外网上传几 MB 通常就要几十秒。
      signal: route.stream || route.upload ? ctl.signal : AbortSignal.timeout(15000),
    })
  } catch (err) {
    // 这一条 502 是**中继自己**发的（上游 DSH 连不上），和 nginx 发的 502 是两回事。
    // 带上 x-taskwatch-hop: relay，手机上再看到 502 时一眼能分清断在哪一段。
    const why = err && err.message ? err.message : String(err)
    const hint = /timeout|abort/i.test(why)
      ? '上游 15 秒内没应答：DSH 可能正忙，或正在重启。'
      : '上游拒绝连接：DSH（或它前面的反向代理）此刻没在监听。'
    send(res, 502, 'text/plain; charset=utf-8',
      '中继正常，是 DSH 上游不可达。\n' + hint + '\n上游地址：' + UPSTREAM + '\n原因：' + why + '\n',
      { 'x-taskwatch-hop': 'relay', 'retry-after': '5' })
    return
  }

  // 会话与 CSRF 是上游插件通过响应头下发的，不透传浏览器就永远建不出会话。
  // set-cookie 一起带过去，让浏览器的会话 cookie 也能续上（双保险）。
  if (route.prefix) {
    for (const h of ['x-holdem-session', 'x-csrf-token', 'set-cookie']) {
      const v = upstreamResponse.headers.get(h)
      if (v) res.setHeader(h, v)
    }
  }

  if (route.stream) {
    // SSE：边收边发，不做任何缓冲。整段读完再发等于把流式变成"转圈到最后"。
    try {
      res.writeHead(upstreamResponse.status, {
        'content-type': route.type,
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      })
      for await (const chunk of upstreamResponse.body) {
        if (res.writableEnded || res.destroyed) break
        res.write(chunk)
      }
    } catch {
      // 客户端断开、上游中断等：连接已经没意义了，直接收尾。
    } finally {
      if (!res.writableEnded) { try { res.end() } catch { /* 已断开 */ } }
    }
    return
  }

  const responseBody = Buffer.from(await upstreamResponse.arrayBuffer())
  // 交付文件要照抄上游的 content-type / disposition / cache-control：图片、PDF、文本
  // 共用同一条路由，只有上游知道这一份到底是什么。其余路由仍用写死的 type ——
  // 让上游决定类型是这里的例外，不是新常态。
  const pass = route.passthroughType ? upstreamResponse.headers : null
  send(res, upstreamResponse.status, (pass && pass.get('content-type')) || route.type, responseBody, {
    'service-worker-allowed': '/taskwatch',
    ...(pass && pass.get('content-disposition') ? { 'content-disposition': pass.get('content-disposition') } : {}),
    ...(pass && pass.get('cache-control') ? { 'cache-control': pass.get('cache-control') } : {}),
  })
})

server.listen(PORT, BIND, () => {
  console.log('dsh-in-hand-relay 已启动')
  console.log('  监听      http://' + BIND + ':' + PORT)
  console.log('  上游      ' + UPSTREAM)
  console.log('  访问地址  http://' + BIND + ':' + PORT + '/taskwatch?k=' + TOKEN)
  console.log('  令牌文件  ' + TOKEN_FILE)
  console.log('  令牌来源  ' + loaded.source)
  if (loaded.created) {
    console.log('')
    console.log('  ⚠ 首次运行：已自动生成一个 256 位随机令牌并写进上面那个文件（权限 0600）。')
    console.log('    在这台电脑上打开下面这个地址即可登录，登录后浏览器记 30 天：')
    console.log('      http://127.0.0.1:' + PORT + '/taskwatch?k=' + TOKEN)
    console.log('    换令牌 = 删掉 .token 再重启；也可以直接用 RELAY_TOKEN 环境变量覆盖。')
    console.log('')
  }
  console.log('  页面外壳  ' + (PAGE_FILE ? PAGE_FILE : '（未找到页面外壳，使用内建兜底页）'))
  if (LAN_MODE) {
    const info = lanInfo()
    console.log('  局域网模式 已开启（标记文件 ' + LAN_MARKER + '）')
    for (const entry of info.entries) console.log('    手机入口  ' + entry)
    console.log('    配对码页  ' + info.pairing)
    console.log('    说明页    http://127.0.0.1:' + PORT + '/taskwatch/lan')
  }
  console.log(publicUrl
    ? '  公网入口  ' + publicUrl + '（页面上的切换按钮用它）'
    : '  公网入口  未知：经公网访问一次后会自动学到（或设 RELAY_PUBLIC_URL / 写 ' + PUBLIC_URL_FILE + '）')
})

server.on('error', (err) => {
  console.error('dsh-in-hand-relay 启动失败：', err && err.message ? err.message : err)
  process.exitCode = 1
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('收到 ' + sig + '，关闭中继')
    server.close(() => process.exit(0))
  })
}
