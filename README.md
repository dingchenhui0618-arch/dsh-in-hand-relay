# dsh-in-hand-relay

**把 DSH 的任务状态和手机端界面安全地送到你手机上的一层只读中继** —— 手机 → 公网 HTTPS → 你的 nginx → SSH 反向隧道 → 本机中继 → DSH，或者干脆手机和电脑同一个 Wi-Fi 直连。不需要公网 IP、不需要端口映射、不需要把 DSH 的 GUI 暴露出去。

> 面向的读者：已经在自己电脑上跑 DSH，想用手机看任务/对话，但不想把「一个默认 `danger-full-access` 的终端」挂到公网上的人。照着本文从头做，大约 15 分钟能跑通局域网那条路。

- 中继本身是一个**零依赖**的 Node 脚本（`server.mjs`，只用 Node 内置模块）。
- 鉴权是**共享令牌** + **6 位配对码换 30 天 cookie**；令牌首次运行自动生成，不用向谁申请。
- 暴露面是**硬编码白名单**：只有 `/taskwatch/*` 下面明确列出的路径能被转发，其余一律 404。
- 界面外壳（PWA）由中继本地提供，来自 [dsh-in-hand](https://github.com/dingchenhui0618-arch/dsh-in-hand) 插件仓库（Apache-2.0，见 `NOTICE`）；用上游插件的那份也可以。

---

## 两种方式，先选一条

中继只做一件事，但**怎么把它接到手机上**有两条完全不同的路。两者不互斥，可以同时开着；先按你的条件选一条。

|  | **方案一：局域网直连** | **方案二：公网访问** |
|---|---|---|
| 需要域名 | 不需要 | **需要**（DNS 里加一条 A 记录） |
| 需要公网服务器 | 不需要 | **需要**（一台有公网 IP 的机器跑 nginx） |
| 手机在哪些网络下能用 | **只有同一个 Wi-Fi** | **任何网络**（4G/5G、公司、别人家） |
| 手机打开的地址 | `http://<内网IP>:<端口>/taskwatch` | `https://<你的域名>/taskwatch` |
| TLS / PWA / 离线外壳 | ✗ `http://` 不是安全上下文：装不成 PWA、没有 service worker（页面本身照常能用） | ✓ 真证书，PWA 与离线外壳都能用 |
| 谁能连上来 | 同网段的人（仍需令牌或 6 位配对码） | 整个互联网都能看到配对页（靠令牌与限流挡） |
| 维护成本 | 几乎没有；内网 IP 变了要重新看一眼 | 域名续费、证书续期、nginx、SSH 隧道与它的保活 |
| 典型故障 | 换了 Wi-Fi；路由器开了客户端隔离 | 隧道断（服务器 nginx 返回 502）；上游 DSH 挂了（中继返回 502） |
| 适合 | 自己家、朋友家这类你信得过的网络 | 想在任何地方用，或要给对方一条稳定入口 |

一句话选：

- **只在同一个 Wi-Fi 里用，或者不想买域名** → 走**方案一**，15 分钟能跑通，不用碰路由器。见 [方案一：局域网直连](#方案一局域网直连不需要域名同一个-wi-fi-内用)。
- **要在外面（4G、公司）也能用** → 走**方案二**，多一台服务器与一个域名。见 [方案二：公网访问](#方案二公网访问需要域名--一台有公网-ip-的服务器)。
- **两条都要** → 都开：中继同时监听回环地址与局域网地址，公网那条由 SSH 反向隧道接进来，两者互不影响。中继会把知道的入口告诉页面，手机端界面右上角的胶囊可以在两条路之间切换。

> 方案二的完整细节（DNS、nginx、隧道、服务端保活）在下面「方案二」一节；两种方式共用的部分（生成令牌、配对、配置表、实现路径、故障排查、安全模型）在各自章节里都会指回来。

---

## 目录

- [两种方式，先选一条](#两种方式先选一条)
- [它解决什么问题](#它解决什么问题)
- [架构](#架构)
- [方案一：局域网直连（不需要域名，同一个 Wi-Fi 内用）](#方案一局域网直连不需要域名同一个-wi-fi-内用)
- [方案二：公网访问（需要域名 + 一台有公网 IP 的服务器）](#方案二公网访问需要域名--一台有公网-ip-的服务器)
- [完整配置表](#完整配置表)
- [实现路径](#实现路径)
- [故障排查](#故障排查)
- [安全模型](#安全模型)
- [已知限制](#已知限制)
- [文件说明](#文件说明)
- [许可](#许可)

---

## 它解决什么问题

DSH 的 web GUI **没有任何认证**，而本机默认权限常常是 `danger-full-access`。把这个 GUI 暴露到公网 = 把整台机器的控制权挂出去：任何人打开那个地址就能执行任意命令、读写任意文件。

但「在外边看看任务跑到哪了 / 在手机上回一句话」只需要**一组固定的窄接口**。所以这里换了个做法：**不动 GUI，另开一个端口**，在那个端口上按白名单重发：

| 类别 | 内容 |
|---|---|
| 读 | `/taskwatch`（页面）、`/taskwatch/data`（全部状态）、`/taskwatch/session`（单会话对话）、`/taskwatch/chat/*` 里的会话/模型/用量/工作区/标题/分页/交付文件 |
| 写（**4 条**，逐条在白名单里显式放行） | `/taskwatch/chat/send`、`/create`、`/cancel`、`/model`（另加附件上传 `/taskwatch/chat/upload`） |
| 中继自己的 | `/healthz`、`/taskwatch/pair*`、`/taskwatch/lan*`、`/taskwatch/entries`、`/taskwatch/ticket`、`/taskwatch/upstream-health` |

GUI 本体（`/api`、工具、文件、会话操作）**永远不出回环**；白名单之外的一切路径都是 404。

---

## 架构

**第一条路：公网 HTTPS（有域名、有服务器）**

```
  手机 (4G/5G/Wi-Fi)
    │  https://dsh.example.com/taskwatch?t=<一次性 ticket>
    ▼
  你的服务器  nginx（443，TLS 终点）
    │  proxy_pass http://127.0.0.1:3099
    │  ▲ 反方向：nginx 主动连的这个端口，其实是 ssh 在那台服务器上开出来的本地监听
    ▼
  SSH 反向隧道：ssh -N -R 127.0.0.1:3099:127.0.0.1:3099 you@<server>
    │  （隧道是从你家这台电脑主动拨出去的，所以家里不需要公网 IP，也不用做端口映射）
    ▼
  本机中继  node server.mjs   ← 只听 127.0.0.1:3099
    │  令牌鉴权（?k= / cookie / Bearer）→ 白名单路由
    ▼
  DSH 上游  http://127.0.0.1:3080   （DSH 的 web 服务；插件 dsh-in-hand 提供 /taskwatch/* 数据）
```

**第二条路：局域网直连（同一个 Wi-Fi，什么都不用搭）**

```
  手机  ──同一 Wi-Fi──►  本机中继  http://192.168.1.20:3099/taskwatch
                             │  同一套装置：6 位配对码 + 30 天 cookie，令牌一次都不用抄
                             ▼
                        DSH 上游  http://127.0.0.1:3080
```

两条路共用**同一份**中继、同一套鉴权。区别只在入口，以及 HTTPS 带来的安全上下文（PWA / service worker / 摄像头 / 剪贴板）。

---

## 方案一：局域网直连（不需要域名，同一个 Wi-Fi 内用）

> 这条路**什么都不用申请**：不买域名、不租服务器、不动路由器。手机和电脑连同一个 Wi-Fi，直接访问中继。

### 0. 前置

- **Node ≥ 18**（`node --version`）。中继零依赖，不用 `npm install`。
- 电脑上跑着 **DSH 的 web 服务**，默认地址 `http://127.0.0.1:3080`（这是 `dsh web` 常见的监听端口；不是的话见下）。
- 手机上装了 **[dsh-in-hand](https://github.com/dingchenhui0618-arch/dsh-in-hand) 插件**（提供 `/taskwatch/*` 数据接口）—— 没有它中继照样能起，只是取不到数据，页面会告诉你上游不可达。
- 手机和电脑连**同一个 Wi-Fi**。

装插件（在 DSH 里）：

```sh
dsh plugin --profile web add dsh-in-hand
# 装完要重启 dsh web：插件行来自 profile 的 bundle 图
```

### 1. 确认 DSH 上游端口，必要时改掉

默认上游是 `http://127.0.0.1:3080`。如果你的 DSH 监听别处：

```powershell
# 永久改：写进同目录 .env（.gitignore 已排除）
"RELAY_UPSTREAM=http://127.0.0.1:3123" | Out-File -Encoding ascii .env
# 或临时改：
$env:RELAY_UPSTREAM='http://127.0.0.1:3123'
```

### 2. 第一次运行：令牌自己生成

```powershell
cd <这个仓库的目录>            # 例：D:\tools\dsh-in-hand-relay
node server.mjs
```

第一次运行会在同目录生成 `.token`（**256 位随机值**，权限 0600），并把它连同登录地址一起打印出来：

```
dsh-in-hand-relay 已启动
  监听      http://127.0.0.1:3099
  上游      http://127.0.0.1:3080
  访问地址  http://127.0.0.1:3099/taskwatch?k=<你的令牌>
  令牌文件  <这个仓库的目录>\.token
  令牌来源  <这个仓库的目录>\.token（本次新建）

  ⚠ 首次运行：已自动生成一个 256 位随机令牌并写进上面那个文件（权限 0600）。
    在这台电脑上打开下面这个地址即可登录，登录后浏览器记 30 天：
      http://127.0.0.1:3099/taskwatch?k=<你的令牌>
    换令牌 = 删掉 .token 再重启；也可以直接用 RELAY_TOKEN 环境变量覆盖。
```

把那个 `?k=` 地址在**这台电脑**的浏览器里打开一次：令牌会被换成 `HttpOnly` cookie，地址栏里的 `k` 随即被 302 去掉（免得留在历史记录/Referer 里）。也可以完全不用令牌，直接在电脑上打开 `http://127.0.0.1:3099/` —— 它会把你送到配对页。

> `?k=` 这条路适合脚本（`curl -H "Authorization: Bearer <token>"` 也一样）。手机日常用下面的配对码。

### 3. 开局域网模式

默认只监听 `127.0.0.1`（连局域网都到不了）。开局域网模式有两种等价方式：

```powershell
# 方式 A：本项目带的脚本（自提权，顺手加防火墙规则、重启中继、探测一遍）
powershell -ExecutionPolicy Bypass -File .\lan.ps1 on
powershell -ExecutionPolicy Bypass -File .\lan.ps1 status
powershell -ExecutionPolicy Bypass -File .\lan.ps1 off
```

```powershell
# 方式 B：手动，等价于 A 的核心
New-Item -ItemType File .lan          # 建标记文件
# 然后重启中继；防火墙需要放行 3099（私有网络）
```

或者用环境变量：`$env:RELAY_LAN='1'`。

开关的含义：**存在 `.lan` 标记文件（或 `RELAY_LAN=1`）就绑 `0.0.0.0`，否则只绑 `127.0.0.1`**。它只是「谁能连到这个端口」，不改变任何鉴权逻辑。

中继启动时会把手机入口直接打出来：

```
  局域网模式 已开启（标记文件 <这个仓库的目录>\.lan）
    手机入口  http://192.168.1.20:3099/taskwatch
    配对码页  http://127.0.0.1:3099/taskwatch/pair
    说明页    http://127.0.0.1:3099/taskwatch/lan
```

也可以用浏览器看说明页：`http://127.0.0.1:3099/taskwatch/lan`（或 JSON 版 `/taskwatch/lan.json`）。

### 4. 手机配对：6 位码从哪来

1. 在**这台电脑**上打开 `http://127.0.0.1:3099/taskwatch/pair`。页面上会出现一个 **6 位码**，带倒计时。
2. 手机上打开 `http://192.168.1.20:3099/taskwatch`（把你的实际局域网 IP 换掉），会跳到配对页。
3. 输入那 6 位码 → 换到一个 **30 天、会滑动续期**的 cookie。之后 30 天不用再输。
4. 手机浏览器「添加到主屏幕」即可当 App 用（**只有 HTTPS 那条路能装**，见[已知限制](#已知限制)）。

关于这个码的边界（都是故意的）：

- **只有从 `127.0.0.1` 直连才生成/显示码**。判断依据不是 `remoteAddress`（经隧道进来的公网请求看着也是 `127.0.0.1`），而是**有没有代理头**（`X-Forwarded-For` / `X-Real-IP` / `Forwarded`）。见到代理头就一律不算本机 —— 失败即关闭。
- 2 分钟有效、最多试 5 次、用掉或过期立刻作废、同时只有一个码。
- 单个来源连续失败 20 次封 10 分钟。
- 猜中概率 5/1000000 量级，而且**不能离线爆破**（每次尝试都要打公网）。

---

## 方案二：公网访问（需要域名 + 一台有公网 IP 的服务器）

> 这条路让你在**任何网络**下都能用手机连回这台电脑：一台有公网 IP 的服务器负责终止 HTTPS，你本机主动建立 **SSH 反向隧道**把端口搬上去 —— 所以你自己这台电脑**不需要公网 IP、不需要端口映射、不需要动路由器**。

目标：出门在外用 4G 也能打开 `https://dsh.example.com/taskwatch`。前提是你**有一台有公网 IP 的服务器**和一个域名（下面用占位符 `dsh.example.com` / `<server-ip>` / `192.168.1.20`，全部替换成你自己的）。

### 1. DNS

| 类型 | 主机记录 | 记录值 |
|---|---|---|
| A | `dsh` | `<server-ip>` |

### 2. 服务器上的 nginx

```nginx
# /etc/nginx/conf.d/dsh.conf
server {
    listen 80;
    server_name dsh.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name dsh.example.com;

    ssl_certificate     /etc/letsencrypt/live/dsh.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dsh.example.com/privkey.pem;

    # 手机端是单页应用 + SSE，别让请求体太小
    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3099;      # 这个端口由下面的 ssh -R 开出来
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;   # 中继靠它区分"是不是本机"
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;

        # SSE / 流式对话必须关缓冲，否则"逐字输出"会变成"转圈到最后一起出来"
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

两个容易踩的点：

- **`X-Forwarded-For` 必须带上**。中继用它判断「这不是本机直连」，从而不在公网暴露配对码。
- **`proxy_buffering off` 必须带上**。中继已经发了 `x-accel-buffering: no`，但 nginx 的 `proxy_buffering` 是更硬的一层。

### 3. 从你自己电脑建立反向隧道

```sh
ssh -N \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -o TCPKeepAlive=yes \
    -R 127.0.0.1:3099:127.0.0.1:3099 \
    you@<server-ip>
```

要点：

- `-R 127.0.0.1:3099:127.0.0.1:3099` 的**前半段显式写 `127.0.0.1`**：让服务器上只在回环监听。别用 `-R 3099:...`（默认可能绑到 `0.0.0.0`，等于绕过 nginx 直接把这层暴露出去，而那层只有 HTTP）。
- `ExitOnForwardFailure=yes`：远程端口被占时**立刻失败退出**，而不是留一个"连上了但没转发"的假隧道。
- `ServerAliveInterval/CountMax`：让 SSH 自己发心跳，网络闪断后能发现死连接。

想让它常驻，用 systemd（Linux/WSL）或任务计划程序（Windows）拉起上面这条命令并配 `Restart=always`。

### 4. 服务器 sshd 的保活（很重要）

`/etc/ssh/sshd_config`：

```
ClientAliveInterval 30
ClientAliveCountMax 3
```

**为什么重要**：反向隧道的端口是 sshd 在**服务器进程**里开的。如果服务器侧不主动探活，一条已经死掉的连接（比如家里宽带换 IP、路由器 NAT 表过期、电脑睡眠）会**继续占着 3099**，而 nginx 打过去只会得到一个没人应答的 socket。现象就是：

- nginx 侧 502 / 504，而且**重启 nginx 没用、重连隧道时 ssh 报 "remote port forwarding failed for listen port 3099"**（端口被那条僵尸连接占着）；
- 直到 sshd 自己超时回收（默认可能几小时甚至更久）。

`ClientAliveInterval 30` + `ClientAliveCountMax 3` = 服务器 30 秒探测一次、连续 3 次没回应（约 90 秒）就断开并**释放端口**。改完 `systemctl reload sshd`。

### 5. 告诉中继你的公网入口（可选）

中继不需要你手填：nginx 转发的请求带着 `Host: dsh.example.com`，中继第一次见到就记住（并写进 `.public-url`），"换路"按钮靠它。也可以显式配置：

```powershell
$env:RELAY_PUBLIC_URL='https://dsh.example.com'
```

---

## 完整配置表

**环境变量（全部可选）**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `RELAY_PORT` | `3099` | 监听端口 |
| `RELAY_BIND` | `127.0.0.1`（开局域网模式则是 `0.0.0.0`） | 监听地址 |
| `RELAY_UPSTREAM` | `http://127.0.0.1:3080` | DSH 上游地址（末尾斜杠会被去掉） |
| `RELAY_TOKEN` | 读同目录 `.token`，没有就生成 | 直接指定令牌，优先级最高，不落盘 |
| `RELAY_LAN` | 关 | `1` / `true` = 开局域网模式（等价于 `.lan` 标记文件） |
| `RELAY_LAN_ALL` | 关 | `1` = 局域网地址清单里也列出虚拟网卡（WSL / Hyper-V / VMware / docker…） |
| `RELAY_PUBLIC_URL` | 自动学 | 公网入口，如 `https://dsh.example.com`；不填就从 `Host` 头学 |
| `RELAY_PAGE_FILE` | `public/page.html` | 覆盖页面外壳文件路径 |
| `RELAY_SW_FILE` | `public/sw.js` | 覆盖 service worker 文件路径 |

**文件**

| 文件 | 作用 |
|---|---|
| `.token` | 令牌；首次运行自动生成（256 位）。删掉再重启 = 换令牌 = 所有设备重新配对 |
| `.lan` | 局域网模式标记文件；`touch` 即开，`rm` 即关（重启生效） |
| `.public-url` | 学到的公网入口，如 `https://dsh.example.com` |
| `.env` | 本地覆盖，仅 `lan.ps1` 读它取 `RELAY_PORT`（供不想设环境变量的人用） |

**命令行（`lan.ps1`）**

```powershell
powershell -ExecutionPolicy Bypass -File .\lan.ps1 on|off|status [-Port 3099] [-Watchdog <path>] [-Node <path>]
```

- `-Port`：默认取 `RELAY_PORT` → `.env` → `3099`。
- `-Watchdog`：管着中继的守护脚本（掉了会把它拉起来）。默认取 `RELAY_WATCHDOG` 环境变量，或 `%USERPROFILE%\.dsh\autostart\services-watchdog.ps1`（**仅当这个文件存在时**才用，那是 DSH 自己的服务看门狗）。没有可用守护脚本时，脚本自己 `node server.mjs` 把中继拉起来。
- `-Node`：默认取 `RELAY_NODE` 或 PATH 里的 `node`。

---

## 实现路径

### 为什么是 SSH 反向隧道，而不是端口映射 / frp / 内网穿透

反向隧道把「哪台机器主动连出去」这件事反过来：**是你家这台电脑去连服务器**。因此：

- 家里**不需要公网 IP、不需要在路由器上做端口映射、不需要动运营商**（很多宽带根本没有可用公网 IPv4）。
- 不需要额外装任何第三方内网穿透客户端；`ssh` 到处都是。
- 服务器上只多一个**回环监听**的端口，公网唯一入口是 nginx 的 443。

代价是：隧道断了没人帮你重连，且服务器侧要有保活设置（见上面 `ClientAliveInterval`）。

### 令牌和配对码分别解决什么问题

| | 令牌（256 位） | 6 位配对码 |
|---|---|---|
| 解决 | **长期凭据**：`?k=` / cookie / `Bearer`，三种携带方式任一通过即可 | **授权动作**：把「这台手机现在被允许」这件事，用一次性的短期凭据表达出来 |
| 生命周期 | 直到你删 `.token` | 120 秒、一次有效 |
| 谁能拿到 | 能读那台电脑上 `.token` 文件的人 | 能操作那台电脑的人（取码端点只认 `127.0.0.1` 直连） |
| 典型用法 | 脚本 / curl / 应急 | 手机上第一次登录、换设备、给家人朋友临时开一下 |

**为什么不把令牌直接拼进 URL 发给手机**：那条路径会被浏览历史、Referer、截图、剪贴板、聊天记录带走 —— 而「截图发给我看看」恰恰是最常发生的事。配对码是一次性的，截图泄了也基本没用（2 分钟 + 一次有效 + 5 次机会）。所以配对码是**变强**，不是变弱。

比较都是定长比较（`timingSafeEqual`），不给时间侧信道；令牌**绝不转发给上游**（转发前会把 `?k=` 删掉）。

### 为什么会话经隧道后来源都是 127.0.0.1

这是架构本身决定的，不是 bug：公网流量走的是**你家电脑自己拨出去的那条 SSH 隧道**，在隧道里它就是本机流量；nginx 再往 `127.0.0.1:3099` 转发，中继看到的 `remoteAddress` 自然全是 `127.0.0.1`。

由此带来两个必须记住的结论：

1. **中继无法判断手机在哪个网络**（4G？家里 Wi-Fi？公司 Wi-Fi？看起来一模一样）。所以：
   - 「判断是不是本机」不能只看 `remoteAddress`，必须看**有没有代理头**（见配对码那节）；
   - 手机端也不能自己探测局域网地址（https 页面禁止访问 `http://` 的混合内容），只能靠「当前这条路失败了吗」来推 → 这就是下面那个「换路」机制存在的原因。
2. 所有公网请求在日志里都是 `127.0.0.1`。要区分真实来源得看 nginx 的 `access.log`，中继这边看不到。

### 一次性换路 ticket 怎么工作

页面同时知道「公网入口」和「局域网入口」（来自 `/taskwatch/entries`），但手机**不能**自动探测该走哪条。所以中继提供一套「免输配对码换路」的凭据：

```
1. 页面在 A 这条路已经登录（有 cookie）
2. POST /taskwatch/ticket  {to: "lan"}            ← 要令牌
3. 中继回 {url: "http://192.168.1.20:3099/taskwatch?t=<ticket>", expiresInMs: 60000}
4. 手机打开那条 url；中继校验 ticket → 种 cookie → 302 到 /taskwatch
5. ticket 立刻作废：重放无效，60 秒过期，只作用于 /taskwatch 这一个路径
```

ticket 是 18 字节随机值、存在内存里、兑换即删。它的作用范围被刻意压到最小：**只换鉴权，不做别的**，也不允许通过它访问其他路由。

同理，`POST /taskwatch/ticket {to:"remote"}` 会给你公网入口的 ticket；还不知道公网入口时回 409。

### 四个诊断接口各自的作用

| 接口 | 免鉴权? | 作用 |
|---|---|---|
| `/taskwatch/lan` · `/taskwatch/lan.json` | 是 | 局域网入口说明页 / 同一份数据的 JSON：当前是否开局域网模式、绑在哪、有哪些局域网地址、配对页在哪。**不含任何凭据**（所以给同网段的人看也无妨），永远不显示配对码本身 |
| `/taskwatch/entries` | 否 | 「我该从哪条路进来」：公网入口、局域网入口清单、你现在是从哪条路进来的（`remote` / `lan` / `local` / `unknown`）、局域网模式开没开。页面上的"换路"按钮靠它 |
| `/taskwatch/upstream-health` | 否 | 上游体检：对 DSH 发一次 4 秒超时的探测，回 `{ok, status, ms, upstream}`。用来把「手机连不上」区分成「中继/隧道坏了」还是「DSH 没在跑」 |
| `/taskwatch/ticket` | 否（POST） | 发一张一次性换路凭据，见上 |

另外 `/healthz` 免鉴权、只回 `ok`、不回显任何状态 —— 给看门狗/负载均衡探活用。

### 页面外壳和 PWA 为什么由中继本地提供

中继本来就是"对外的门面"，外壳属于门面的一部分：这样它自包含，不随「上游挂的是哪个插件版本」而变。中继读不到 `public/page.html` 时会退化成**内建兜底页**（也是 `server.mjs` 里自带的），而不是 500 —— 一个缺失的静态文件不该让整条链路变成错误页。

service worker 和页面外壳**必须同版本**：这两个文件曾经各有一份、行为不同（一份不删旧缓存、也不认 `/taskwatch/session`），到底拿到哪个取决于请求先命中谁。所以启动时只认一次，且两者都优先跟随同一个来源。

---

## 故障排查

### 三种 502，怎么一眼分清

| 现象 | 断在哪 | 判据 |
|---|---|---|
| nginx 的 502（HTML 错误页，通常带 `nginx/1.xx` 字样） | **隧道断在服务器那一段**（或隧道进程根本没起来） | 响应里**没有** `x-taskwatch-hop`；服务器 `error.log` 里是 `connect() failed (111: Connection refused) while connecting to upstream` |
| 中继的 502（纯文本，且**带 `x-taskwatch-hop: relay`**） | **本机中继正常，是 DSH 上游不可达** | 正文会自解释：`中继正常，是 DSH 上游不可达。` + 原因 + 上游地址；还带 `retry-after: 5` |
| 手机端"缓存了旧 502" | **哪都没断，是 service worker 的离线外壳在给旧响应** | 同一个地址：电脑上正常、手机上一直 502；或断网后打开也显示 502。清理该站点数据 / 换无痕窗口即可立刻验证 |

`x-taskwatch-hop` 就是为这件事加的：**它只由中继自己发的那条 502 带上**。所以：

```powershell
curl.exe -s -i https://dsh.example.com/taskwatch/data | Select-Object -First 12
```

- 有 `x-taskwatch-hop: relay` → 看 DSH：`curl.exe -s -i http://127.0.0.1:3080/taskwatch/data`，以及中继内建的 `/taskwatch/upstream-health`。
- 没有这个头、状态还是 502 → 看隧道和 nginx（下一节）。

### 隧道断了怎么定位

```sh
# 1. 带 -v 看握手和转发是否真的建立
ssh -v -N -o ExitOnForwardFailure=yes -R 127.0.0.1:3099:127.0.0.1:3099 you@<server-ip>
#    关注这几行：
#      debug1: remote forward success for: listen 127.0.0.1:3099, connect 127.0.0.1:3099
#      Warning: remote port forwarding failed for listen port 3099   ← 服务器上端口被占
```

| 症状 | 含义 | 处理 |
|---|---|---|
| `Warning: remote port forwarding failed for listen port 3099` 且 ssh 立刻退出 | 服务器上 3099 已被另一条连接占着（常见于**上一次隧道已经死了但 sshd 还没回收**） | 服务器上 `ss -ltnp \| grep 3099` 找出占用的 sshd/进程；`pkill -f 'sshd.*3099'` 或等保活超时。然后把 `ClientAliveInterval` 配上（见上），下次就只等 90 秒 |
| 隧道看着在，nginx 仍 502 **且没有中继头** | 服务器端口没人应答：要么中继在本机没跑，要么 ssh 转发目标写错了（`::1` vs `127.0.0.1`） | 本机 `curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3099/healthz` 必须 200；转发目标显式写 `127.0.0.1` |
| 白天好的、隔夜就断 | 家里 IP 变了 / 路由器 NAT 超时 / 电脑睡眠 | 客户端加 `ServerAliveInterval=30 ServerAliveCountMax=3`；服务器加 `ClientAliveInterval`；用服务管理器配 `Restart=always` |
| 手机 4G 打不开、家里 Wi-Fi 可以 | 要么 DNS 没生效，要么服务器 443 没放行，要么就是**该换到局域网那条路**（页面上的"换路"按钮） | `nslookup dsh.example.com`；服务器 `ufw status`；局域网路见 `/taskwatch/lan` |

### 中继自己起不来

```powershell
node --check server.mjs                     # 语法
netstat -ano | Select-String 'LISTENING' | Select-String ':3099'   # 端口被占？
node server.mjs                             # 前台跑，直接看报错
```

`EADDRINUSE` = 已经有一个中继在跑（或别的程序占了 3099）。`EACCES` = 端口 <1024 或权限问题。

### Windows 控制台中文乱码

Node 输出是 UTF-8，而 Windows 控制台（PowerShell 5.1）默认按 GBK 解码，于是日志里的中文变成乱码。两种处理：

```powershell
[Console]::OutputEncoding = [Text.Encoding]::UTF8   # 当前会话
chcp 65001                                          # 或切代码页
```

乱码只影响**看日志**，不影响功能与文件内容。

---

## 安全模型

一句话：**拿到令牌（或配对码）≈ 拿到你机器上的一个终端。**

- 白名单里有 **4 条写接口**（`chat/send`、`chat/create`、`chat/cancel`、`chat/model`）+ 附件上传。能打开页面的人就能**驱动 agent**；如果 DSH 的 preset 是 `danger-full-access`（默认常见如此），那 agent 能做的都等于他能做的：读写任意文件、执行任意命令。
- 所以请把「谁能打开这个页面」当成「谁能用你的电脑」，按这个标准决定：
  - 家里自己的 Wi-Fi：可以开。
  - 公司 / 咖啡厅 / 酒店 / 公共 Wi-Fi：**不要开局域网模式**。同一网段的人只要拿到地址 + 一个 6 位码（2 分钟内）就进去了；有些公共 Wi-Fi 还会做客户端互访。
  - 公网那条路：**必须有 TLS**（否则令牌和 cookie 在明文里裸奔），并且建议再加一层（只允许你自己的 IP、或换成 Tailscale/Cloudflare 具名隧道）。
- 公网暴露面到底是哪些：只有 nginx 的 443 这一个入口，转发到服务器回环上的 3099。**不要**用 `-R 3099:...` 让 sshd 把端口开到 `0.0.0.0` —— 那等于绕过 nginx 直接暴露一个纯 HTTP 的中继。
- 配了 HTTPS 之后，"手机到 nginx"这一段是加密的；"nginx 到中继"这一段在服务器回环内、"中继到 DSH"这一段在本机回环内，都不出网卡。
- 令牌误泄了怎么办：删 `.token` 重启（所有设备重新配对），或者先 `RELAY_TOKEN=<新值>` 顶掉。
- 建议的收尾习惯：不用时 `.lan` 删掉、隧道停掉 —— 减少暴露面比任何加固都有效。

**不要**给这一层加 HTTP Basic auth。这条是实测踩出来的：iOS Safari 在发起 service worker 脚本请求（`/taskwatch/sw.js`）时**不附凭据**，于是那个请求 401、新 SW 永远装不上、手机一直停在旧页面 —— 而服务端一切正常，从外部完全查不出异常。（所以正路是"中继自己发一个有时效的 cookie"：6 位配对码换 30 天、随请求滑动续期。）Basic auth 也是三层里**最弱**的一层：一个可共享的静态口令，改一次要在所有设备上重输。

---

## 已知限制

- **局域网直连是 `http://`，不是安全上下文** → 装不成 PWA（"添加到主屏幕"只是书签）、没有 service worker 离线外壳、摄像头/麦克风、剪贴板 API 都用不了。页面本身照常能用。要这些就必须走 HTTPS（公网隧道，或 Tailscale / Cloudflare 具名隧道）。
- **局域网 IP 会随 DHCP 变**。地址变了手机上的书签就失效 —— 重新看 `/taskwatch/lan`，或在路由器上给它固定 IP。
- **开了客户端隔离（AP isolation）的 Wi-Fi 连不上**，即使同一个 SSID。公司/酒店 Wi-Fi 常见。
- **中继看不出手机在哪个网络**（经隧道后来源都是 127.0.0.1），所以"自动选路"做不到，只能靠页面上的手动换路。
- **配对码只在 127.0.0.1 的页面上显示**。如果你的中继跑在另一台机器上、你只能远程 SSH 进去，就需要端口转发（`ssh -L 3099:127.0.0.1:3099 ...`）后在本地浏览器打开配对页。
- **中继只做转发，不做 DSH 的事**：上游插件（dsh-in-hand）不装，就只能看到一个"上游不可达"的兜底页。
- 中继没有多用户概念、没有审计日志、没有速率限制（只有配对失败计数）。它是**个人工具**，不是面向多租户的服务。

---

## 文件说明

```
dsh-in-hand-relay/
├─ server.mjs                      中继本体（零依赖，Node ≥ 18）
├─ lan.ps1                         Windows 局域网开关（纯 ASCII，自提权）
├─ package.json                    npm start / engines
├─ README.md                       本文件
├─ LICENSE                         MIT（public/ 下的界面文件来自 Apache-2.0 项目，见 NOTICE）
├─ NOTICE                          第三方来源声明
├─ .gitignore                      排除 .token / .lan / .public-url / .env / 日志 / _verify
├─ docs/
│  └─ DESIGN.md                    设计说明：为什么这么写（不含任何部署信息）
└─ public/
   ├─ page.html                    手机端页面外壳（来自 dsh-in-hand，Apache-2.0）
   ├─ sw.js                        service worker
   ├─ manifest.webmanifest         PWA manifest
   ├─ icon-192.png, icon-512.png   图标
```

运行时会自己生成（已被 `.gitignore` 排除）：`.token`、`.lan`、`.public-url`。

---

## 许可

MIT，版权署名 `dsh-in-hand contributors`，见 [LICENSE](LICENSE)。

`public/` 下的界面文件（`page.html` / `sw.js` / `manifest.webmanifest` / 两个图标）来自 [dsh-in-hand](https://github.com/dingchenhui0618-arch/dsh-in-hand) 项目（Apache-2.0），原样再分发，见 [NOTICE](NOTICE)。
