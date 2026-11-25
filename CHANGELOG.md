# Changelog

只写事实：每一版改了什么、验证过什么。

## 1.2.1

- 修正一个「页面 200 但界面是旧的」问题：`public/page.html` 停在 2026-10-12 的版本，
  远端手机拿到的就是那个旧外壳——插件 v1.10.0 的简洁模式、运行进度条、连接诊断
  在手机上一个都看不到。现在三件套（`page.html` / `sw.js` / `manifest.webmanifest`）
  同步为插件 v1.10.0 的同一份（页面 589,017 B，service worker `taskwatch-v42`）。
- 新增 `scripts/sync-shell.mjs <插件仓库>`：发版前把外壳三件套从插件 `lib/` 复制进
  `public/`，README 的「页面外壳」一节写明这一步属于发布流程。
- 路由与能力声明不变（35 条白名单、`capabilities` 仍是那 9 项），1.2.0 与 1.2.1
  可互换；验证：`/taskwatch` 公网返回 589,017 B 且含 `runbar` / `tw-simple`。

## 1.2.0

- 白名单补齐 **19 条**远端路由（按路径计；宿主 `lib/index.js` 里逐条对过注册与方法）。远端从
  「能看」变成**完整控制面**：`POST /taskwatch/approve`、`/answer`；`GET|HEAD /decisions`、
  `/devices`、`/chat/queue`；`POST /devices/revoke`、`/chat/queue/reorder`；通知 `/notify`
  （GET）与 `/notify/add|remove|test|toggle`（POST）；系统推送 `/push/state`（GET）与
  `/push/subscribe|test|unsubscribe`（POST）；点星 `/star/start|poll`（POST，宿主只认 POST）；
  以及 `GET /taskwatch/approvals/stream`。
- 审批事件流 `/taskwatch/approvals/stream` 以 `stream: true` 流式转发（`text/event-stream`）：
  和 `/taskwatch/chat/stream` 同一套处理，不再整段缓冲、不会等到超时才吐、也不会攒住内存。
- 能力声明：`/taskwatch/lan.json` 新增 `relayVersion: "1.2.0"` 与 `capabilities`
  （`approve,answer,queue,decisions,devices,notify,push,star,approvals-stream`，纯字符串、
  不含凭据）；`/healthz` 新增响应头 `x-taskwatch-capabilities`，原有的
  `x-taskwatch-ticket-versions` 不变。插件据此判断「远端能不能批准」，升级后老中继会被提示。
- `/taskwatch/lan` 页面新增「远端能做什么」一节，用人话列出这些能力。
- README 的白名单 / 安全模型 / `/healthz` 段落、SECURITY.md 的转发面说明同步更新：白名单
  现在是完整控制面，**持有配对 cookie 的人等于持有这台机器的终端**。
- `scripts/ci-smoke.mjs` 扩到 **16 项检查**：新增的 19 条控制面路由无令牌一律 401、
  `/healthz` 的 `x-taskwatch-capabilities`、`/taskwatch/lan.json` 的 `relayVersion` 与
  `capabilities`；`node scripts/ci-smoke.mjs` 全部通过，`node --check server.mjs` 通过。

## 1.1.0

- 换路票据升级到 **v3**：`v3.<expMs>.<nonce>.<aud>.<hmac>`，HMAC-SHA256，密钥与
  [`dsh-in-hand`](https://github.com/dingchenhui0618-arch/dsh-in-hand) 插件宿主共用
  （`TASKWATCH_TICKET_SECRET`，或 `~/.dsh/taskwatch-ticket.key`）。插件宿主签的票打到**跑在
  服务器上的**中继也能兑现，不再落到配对页。
- 中继只兑现 `aud=remote` 的 v3 票；`aud=lan` 的票回 401。v2 票在 2027-01-01 前继续接受。
- 一次性兑换改为 nonce 记账：查与写在同一个同步函数里，重放回 401；30 秒 `unref` 定时清理，
  容量上限 8192，记录全在进程内。
- `/healthz` 新增响应头 `x-taskwatch-ticket-versions: 3,2`；`/taskwatch/lan.json` 新增
  `ticketVersions: [3,2]` 与 `ticketAudience: "remote"`（都不含密钥）。启动日志打印票据密钥
  来源（env / 文件 + source + permission）与版本，不打印密钥值。
- 新增配置 `TASKWATCH_TICKET_SECRET`（≥32 字符）；不设则读 `~/.dsh/taskwatch-ticket.key`，
  都没有就生成并收紧权限。README 增加「中继跑在服务器上：让扫码也能用」的拷贝步骤。
- `scripts/ci-smoke.mjs` 扩到 **15 项检查**（新增 v3 兑换 / 重放 / 受众 / 错密钥 / 过期 /
  v2 过渡期 / 能力声明 / 中继自签票），`node scripts/ci-smoke.mjs` 通过。
