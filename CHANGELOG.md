# Changelog

只写事实：每一版改了什么、验证过什么。

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
