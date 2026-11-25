# 安全模型 / Security model

这份文档说明 **dsh-in-hand-relay** 监听什么、谁能连、凭什么连、把请求转发到哪里。
它从实现（`server.mjs`、`lan.ps1`）里读出来；
**如果文档和代码不一致，以代码为准，那说明这份文档是个 bug。**

> 一句话：这是一个**共享令牌门禁的固定路径转发器**，边界画在「有没有那个 256 位令牌」上，
> 端口本身默认只绑回环；开了局域网模式就绑 `0.0.0.0`，能连上端口的人仍然过不了令牌这一关，
> 但 6 位配对码是第二条入口。它**不是** DSH GUI 的认证层——3080 上的 GUI 依旧没有认证，
> 中继也不转发 GUI 的管理面（`/api` 等）。但 `/taskwatch/*` 这一层从 1.2.0 起是**完整控制面**：
> 白名单现在覆盖审批、回答、队列、设备、通知、推送、点星，**持有配对 cookie 的人等于持有这台机器的终端**。

## 信任边界

中继是一个独立的 `node:http` 进程（`server.mjs`），不是 DSH 的插件，也不跑在宿主进程里。

| 表面 | 默认值 | 谁能连 | 鉴权 |
| --- | --- | --- | --- |
| 中继监听 | `RELAY_PORT`（默认 `3099`），`RELAY_BIND` 默认 `127.0.0.1`；存在 `.lan` 标记文件或 `RELAY_LAN=1` 时默认改绑 `0.0.0.0` | 回环，或（局域网模式下）同网段 | 共享令牌 `tw`，见下 |
| 上游转发 | `RELAY_UPSTREAM`，默认 `http://127.0.0.1:3080` | 只有中继进程自己 | 中继不带上游的任何认证头，也不需要：上游就是本机 DSH 的 web 服务 |
| 公网入口 | 不在中继里 | 由用户自己的 nginx + 反向隧道提供 | 在中继这一层仍是同一个 `tw` 令牌 |

**视为不可信输入**的：

- **所有网络请求**——路径、查询串（`?k=`、`?t=`、`?id=`、`?sessionId=`）、Cookie、`Authorization`、
  `Host`、`X-Forwarded-For`、POST body；
- **上游的响应**——状态码、`content-type`、`content-disposition`、`set-cookie` 都来自上游，
  中继只对白名单里少数几条路由按上游转发；
- **`.token` / `.public-url` 文件的内容**——按普通文本读入，不做格式校验（只 trim）；
- **`TASKWATCH_TICKET_SECRET` / `~/.dsh/taskwatch-ticket.key` 的内容**——只做 trim 与长度校验
  （≥32 字符），不解析、不回显、不写日志；
- **`lan.ps1` 的操作对象**——它会重启中继、读写 `.lan` 标记、必要时改防火墙规则，这些动作以
  当前用户权限执行。

## 鉴权现状（照实写）

- **共享令牌**：首次运行用 `randomBytes(32).toString('base64url')`（256 bit）生成，写入同目录
  `.token`（`mode: 0o600`；Windows 上 `chmodSync` 会被忽略，见「已知限制」）。
  `RELAY_TOKEN` 环境变量优先级最高且不落盘。比较用 `crypto.timingSafeEqual`，长度不同直接 false。
- **三种携带方式**，任一通过即可（`authorize()`）：`?k=<token>`、`Cookie: tw=<token>`、
  `Authorization: Bearer <token>`。
  - 用 `?k=` 成功访问 GET/HEAD 时，中继会去掉 `k` 并 302 到干净地址，同时种 `HttpOnly;
    SameSite=Lax; Path=/; Max-Age=2592000` 的 cookie（30 天，随 cookie 请求滑动续期）。
  - 用 `?k=` 的 POST 不会被 302（否则浏览器会重发请求体），令牌会留在那一次请求的 URL 里。
- **6 位配对码是第二条入口**（`POST /taskwatch/pair/claim`）：
  - 只在**本机**生成并显示；`isLocal()` 的判据是「没有 `X-Forwarded-For` / `X-Real-IP` /
    `Forwarded` 头，且 `remoteAddress` 是回环」。见到任何代理头一律不算本机——因为公网流量经
    反向代理进来时 `remoteAddress` 同样是 `127.0.0.1`；
  - `randomBytes(4) % 1000000` 生成，120 秒有效，同一时间只有一个码，每个码最多试 5 次，
    单个来源失败 20 次锁 10 分钟；用掉或过期立刻作废；
  - 兑换成功会下发和上面同一个 30 天 `tw` cookie。**配对码换来的就是完整令牌**，不是降权凭据。
- **一次性换路票据 `?t=`**：`POST /taskwatch/ticket`（需令牌）签发 v3 票
  `v3.<expMs>.<nonce>.<aud>.<hmac>`（HMAC-SHA256，密钥与插件宿主共用），60 秒有效；兑换时
  解析 → 受众（只收 `aud=remote`）→ 验签 → 时效（`> 0` 且 `≤ 180 秒`）→ nonce 记账，全部在
  一个同步函数里完成，重放回 401，只在 `/taskwatch` 这一条路径上兑换。v2 票（无 `aud`）在
  2027-01-01 前仍接受；不认识的老随机串回落到进程内 Map。
- **免鉴权的端点**（都是有意为之，逐条说明见「明确不算漏洞」）：
  `/healthz`、`/`（302 指路）、`/taskwatch/pair`（GET，本机才显示码）、`/taskwatch/pair/new`
  （仅本机）、`/taskwatch/pair/claim`（POST）、`/taskwatch/lan` 与 `/taskwatch/lan.json`。
- **没有任何角色/权限分级**：令牌是布尔门禁。拿到令牌就能调用白名单里所有路由，包括写路由。

## 票据密钥的信任边界

换路票据用 HMAC-SHA256 签名，密钥来自 `TASKWATCH_TICKET_SECRET`（≥32 字符）或
`~/.dsh/taskwatch-ticket.key`（首次生成，POSIX 上 0600、Windows 上用 `icacls` 去掉继承）。
它由**中继与插件宿主共用**，因此：

- 拿到密钥 ≈ 能给自己签一张 60 秒内有效、只能换一次的换路票，而兑换成功拿到的是完整
  `tw` cookie（和配对码换到的是同一个令牌）。也就是说它**等价于绕过配对码直接登录中继**，
  必须按凭据保管：不进仓库、不进聊天/截图/工单，也不写进 systemd 的 `ExecStart=` /
  `Environment=`（用 `EnvironmentFile`，文件 600 归 root）。
- **受众绑定**写在签名覆盖的票面里（`aud`）：中继只兑现 `aud=remote`，插件宿主只兑现
  `aud=lan`。这是跨进程有效的密码学约束，不是记账。
- **一次性是进程内记账**：nonce 只存在当前进程的 Map 里，重启即清空；中继与插件宿主之间
  不共享已用记录。所以「严格一次性」的承诺范围是**单个进程生命周期**：同一张票在同一个
  进程里只兑现一次，重启窗口内可能再兑现一次（票本身 60 秒过期，且需要密钥才签得出来）。
- 密钥**从不写日志、不出现在任何 HTTP 响应里**；`/healthz`（响应头）与 `/taskwatch/lan.json`
  只声明 `ticketVersions` / `ticketAudience`。轮换密钥只作废**未兑换**的票，不等于吊销已发的
  30 天 cookie —— 要一次性踢掉所有设备，还是换 `.token`。

## 转发面（能力边界）

上游路径是**硬编码白名单**（`ROUTES` / `STATIC`），表外一律 404，不代理 `/api`、不代理任意静态资源。
**从 1.2.0 起这张表是完整控制面**：不只是看数据，还能完成原本要回到电脑前做的动作。也就是说
**持有配对 cookie 的人等于持有这台机器的终端**——请按这个标准决定谁能访问。

- 对话写接口：`POST /taskwatch/chat/send`（发消息）、`/chat/create`（新建对话）、`/chat/cancel`（取消）、
  `/chat/model`（换模型）、`/chat/upload`（上传附件，原始二进制流式转发，大小上限在上游插件那侧）；
- 审批 / 提问：`POST /taskwatch/approve`（放行或拒绝一次待决定操作）、`/taskwatch/answer`（回答选项式提问）、
  `GET /taskwatch/decisions`（待决定清单）、`GET /taskwatch/approvals/stream`（审批与提问的 SSE 事件流）；
- 队列：`GET /taskwatch/chat/queue`（下一轮待发消息）、`POST /taskwatch/chat/queue/reorder`（整队重排）；
- 设备：`GET /taskwatch/devices`、`POST /taskwatch/devices/revoke`（撤销一台设备）；
- 通知：`GET /taskwatch/notify`、`POST /taskwatch/notify/add|remove|test|toggle`；
- 系统推送：`GET /taskwatch/push/state`、`POST /taskwatch/push/subscribe|test|unsubscribe`；
- 点星：`POST /taskwatch/star/start|poll`（GitHub device flow 在宿主里跑，页面拿不到 token）；
- 只读接口：`/taskwatch/data`、`/taskwatch/session`、`/chat/sessions`、`/chat/models`、`/chat/page`、
  `/chat/titles`、`/chat/usage`、`/chat/workspaces`、`/taskwatch/file`、`/chat/stream`（SSE 流式）。

「只读中继」这个说法从 1.2.0 起**不再成立**：它读不到 DSH 的设置、插件、文件系统浏览接口，但它能
替你发消息、批准操作、撤销设备、改通知设置、点星——这些都会改变宿主状态。
`/taskwatch/file` 的目录与扩展名白名单在上游插件那一侧，中继只负责按上游的 `content-type` 转发。

## 输入处理

- 小 JSON 包请求体上限 **64 KiB**（`readBody(req, 64*1024)`），配对码 4 KiB，换路凭据 1 KiB；
  超限返回 413。
- 附件上传（`/chat/upload`）**流式转发**，不攒进内存；也不吃 15 秒超时。
- 普通上游请求有 **15 秒超时**；SSE 与上传跟着客户端连接走，客户端断开时 `AbortController`
  会掐掉上游请求。
- 转发前删掉 `k` 参数，令牌不会带给上游；同时**故意不转发** `origin` / `referer` /
  `sec-fetch-site`，只对前缀路由补 `x-holdem-session` / `x-csrf-token`。
- 路径由 `new URL(req.url, 'http://relay.invalid')` 解析，非法 URL 直接 400。
- 本地文件（PWA 外壳）只从固定常量路径读：`public/page.html`、`public/sw.js`、两个图标；
  路径来自 `import.meta.url` 或环境变量，不接受请求参数。

## 数据与副作用

- **写文件**：只在启动/首次运行时写 `.token`（同目录）与 `~/.dsh/taskwatch-ticket.key`
  （都已存在则不写），以及学到公网域名时写 `.public-url`（失败就只记在内存）。
  不建数据库、不写日志文件、不缓存响应。
- **发网络请求**：只向 `RELAY_UPSTREAM` 发（默认 `http://127.0.0.1:3080`），路径限于白名单。
- **无遥测**、不上报使用情况、不带账号信息。
- **状态全在内存**：配对码、失败计数、已兑换 nonce、老格式换路凭据都在进程里，重启即清空。
- `lan.ps1` 是独立的操作脚本：它会创建/删除 `.lan`、可能调用 `node server.mjs` 重启中继、
  在需要时以管理员权限加防火墙入站规则。它不参与运行时的请求处理。

## 已知限制（都是设计取舍，不是 bug——但你应该知道）

1. **没有 TLS**：中继是 `node:http`。局域网直连是明文 HTTP，同网段能抓包的人看得到对话内容
   和 cookie；TLS 只能由你自己的 nginx（公网方案）提供。
2. **单一共享令牌，没有按设备吊销**：cookie 是 30 天且滑动续期，换设备只能改令牌
   （删 `.token` 重启或换 `RELAY_TOKEN`），一改所有设备一起掉线；没有设备清单、没有审计日志。
3. **令牌会出现在 URL 里**：首次登录的 `?k=<token>` 会进浏览器历史/截图；中继用 302 立即
   换成 cookie 就是为了缩小这个窗口，但那一跳仍然存在。
4. **6 位配对码的强度依赖本机生成**：`isLocal()` 用「有没有代理头」判断本机，这个判断假定
   你的反向代理**一定**会加 `X-Forwarded-For`。如果前面的代理把该头剥掉，判断会退化成
   「看起来很本机」。nginx 默认会加，自定义配置需要自己确认。
5. **没有失败限速以外的防护**：令牌校验没有按 IP 限速，SSE 长连接没有并发上限；配对码有
   （20 次/10 分钟），普通请求没有。
6. **白名单是静态的**：上游插件新增路由必须改 `server.mjs` 才对外可见；这是能力边界，也是
   升级时的维护点。1.2.0 起它覆盖完整控制面，每次扩充都要重新评估「这条路由能改变什么」。
7. **Windows 上没有 POSIX 权限位**：`.token` 与 `~/.dsh/taskwatch-ticket.key` 的 0600 在
   Windows 上不生效；密钥文件生成时用 `icacls /inheritance:r /grant:r <user>:F` 收紧，失败会
   如实标成 `icacls-failed` 打在启动日志里（只打状态，不打密钥）。
8. **公网入口靠 Host 头学习**：`learnPublicUrl()` 只认域名形态且忽略内网/回环地址，但它仍然
   来自请求头；配 `RELAY_PUBLIC_URL` 可以避免这个不确定性。
9. **没有 CSRF token 之外的写保护**：cookie 是 `SameSite=Lax`，跨站 POST 默认不带 cookie，
   但同站的其他页面（例如同域名下的其他服务）在浏览器里仍可发请求。
10. **换路票据的一次性只在单进程内**：nonce 记在内存里，重启即清空；中继与插件宿主之间不共享
    已用记录。受众绑定（`aud`）不受此限，它写在签名覆盖的票面里。轮换票据密钥也不是吊销手段 ——
    已发的 30 天 `tw` cookie 仍然有效。

## 明确不算漏洞的

- `/healthz` 免鉴权返回 `ok`（看门狗探活，不回显任何状态）；
- `/taskwatch/lan.json` 免鉴权列出本机局域网地址与步骤（**不含令牌**，且内网 IP 本来就能在
  同网段被发现）；
- 用 `?k=` 首次登录（没有它，手机端没法完成首次认证；中继会立刻换成 cookie）；
- 局域网模式下同网段的人能看到配对页（他们仍然需要那 6 位码，而码只在电脑上显示）；
- 拿到令牌的人可以发消息/取消任务/上传附件（这是产品功能，不是越权——令牌就是这个产品的
  全部权限模型；不想给这个能力就不要把端口暴露出去）；
- 上游 DSH 的 3080 端口本身没有认证——中继不改变这一点，也不负责保护它；直接暴露 3080
  造成的后果与中继无关；
- 明文局域网流量被同网段嗅探（见「已知限制」第 1 条）。

## 报告漏洞

用 GitHub 的私密渠道：<https://github.com/dingchenhui0618-arch/dsh-in-hand-relay/security/advisories/new>

这是一个人维护的项目，**我不承诺响应时限**；但我会读、会修。请不要把还在生效的问题直接发到
公开 issue 里。修完会在 commit 说明里写清影响范围；这个仓库没有发版流程，不承诺版本号。

## 支持范围

只维护 `master` 上的最新提交。没有 npm 包、没有 tag、没有 LTS 分支；旧提交不回补。
