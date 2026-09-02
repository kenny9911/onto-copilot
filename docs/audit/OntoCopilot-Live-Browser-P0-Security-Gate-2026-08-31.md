# OntoCopilot Live Browser Runtime：P0 安全门禁与验收矩阵

日期：2026-08-31  
范围：Sidebar 中的匿名、临时、可视化 Live Browser。本文不把既有 Reader/iframe 当成浏览器，也不覆盖未来登录态、上传、下载、支付或企业内网页面。

## 结论

P0 可以上线的形态是“匿名、只读优先、按 Onto 会话隔离的远端浏览器画面”。浏览器进程必须位于受限运行时中；前端只接收同源截图/画面和受约束的导航、滚动、点击输入命令。任何一个子资源可以绕过公网校验、浏览器继承了 Onto/宿主机凭证，或者浏览器实例不能按 owner 与 session 绑定时，P0 都不得标记为可用。

既有 `WebPreviewService` 的 DNS 检查、重定向检查和 IP pin 只保护 Reader 自己发出的主文档请求。Chromium 加载的 CSS、脚本、图片、字体、XHR/fetch、worker 和 WebSocket 不经过该 transport，因此不能以“Reader 已防 SSRF”推导 Live Browser 已防 SSRF。

## 2026-08-31 实现复审结果

当前实现已达到“本地/受控部署、匿名 Live Browser”的代码级 P0 合同，复审未发现仍可利用的代码级 P0 绕过：

- 顶层导航和 Chromium 每个 request 都执行协议、端口、DNS 全量公网校验；本机、内网、metadata、保留网段与混合 DNS 失败关闭。
- Chromium 强制经过仅监听 `127.0.0.1` 的 forward proxy；proxy 对普通 HTTP 和 HTTPS `CONNECT` 再解析并 pin 到已验证 IP，防止校验后的 DNS rebinding。
- `CONNECT` 双向合计上限 64 MB/2 分钟；page 与最多 8 个 Dedicated Worker 共享 96 MB、512 request 配额，另有 viewport、导航时限与全局/会话 runtime 配额。
- 每个 tab 使用新的 ephemeral browser context；不加载系统 Chrome profile，不继承 Onto cookie/Authorization。
- 为提高公开 SPA 兼容性，P0 允许 EventSource、Dedicated Worker、同源 `data:`/`blob:` 子资源，以及不超过 256 KB 的当前页面 exact-origin XHR/fetch POST；POST 缺少可核验长度时失败关闭，跨站 POST 不会成为 relay。
- P0 仍阻断导航 POST、PUT/PATCH/DELETE、Authorization、WebSocket/WebTransport/WebRTC、SharedWorker/Service Worker、原生表单提交、Enter/组合键、密码框、download、file chooser、popup、clipboard、登录/支付 API 和浏览器权限提示。
- runtime id 同时受 Onto `sid` 作用域约束；每个 route 重新检查 session owner。session 删除使用 tombstone、generation 与 pending-open 等待，关闭删除竞态；client abort、TTL、close 与 shutdown 都释放 context。
- UI 只接受精确绑定当前 `sid + browserSessionId + seq` 的同源 PNG frame URL；frame 禁止缓存、嗅探和跨源读取，图片请求不发送 referrer。
- mutation 默认要求精确同源 `Origin`，并拒绝 cross-site Fetch Metadata；无 `Origin` 只保留给显式 `Sec-Fetch-Site: none` 的本地/原生调用，普通缺失来源请求失败关闭。

自动化状态：后端 Live Browser、安全合同、session deletion 与 wiring 共 94 项 focused tests 通过，其中独立安全套件 14 项；连同 UI focused tests 共 108 项通过，TypeScript 检查通过。UI 另覆盖同源 frame 绑定和第三方 frame 注入。真正的生产 Gate D 仍是条件项：多租户或公网部署必须再加容器/microVM、OS sandbox 和独立 egress policy，并运行真实 Chromium 的恶意 redirect/subresource/WebSocket/Service Worker/崩溃清理集成集。在完成 Gate D 前，不应宣称为支持登录、支付、上传/下载的通用浏览器。

## P0 产品边界

- 允许：匿名公网 HTTP/HTTPS 页面；地址栏导航；前进、后退、刷新；滚动；查看实时渲染画面；受限点击和普通文本框输入；EventSource；最多 8 个 Dedicated Worker；exact-origin、有界、非导航的渲染 POST。
- 默认关闭：站点登录、复用宿主机/用户浏览器 cookie、密码输入、Enter/组合键、原生表单提交、跨站 POST、文件上传、下载、支付、弹窗、权限请求、剪贴板、WebSocket、SharedWorker、Service Worker 和后台页面。
- AI 翻译、总结、引用仍读取独立 Reader snapshot；Live 画面不得被静默写入材料记忆，也不得直接进入模型上下文。
- 未来能力必须逐项加审批门和独立威胁模型，不能通过放宽 P0 通用开关一次性开启。

## 审计起点的安全基线与缺口（实现前）

下表记录本轮改造开始时的差距；上方“实现复审结果”是当前状态。

| 项目 | 已有基线 | Live Browser 缺口 |
|---|---|---|
| 会话归属 | 鉴权中间件及 Web Preview route 对 `/api/sessions/:sid/...` 执行 owner 检查，越权与不存在均返回 404 | browser runtime id 还必须再次绑定 `ownerId + sid`，不能只凭不可猜 id |
| Cookie | Onto 登录 cookie 为 `HttpOnly`、`SameSite=Lax` | 还没有显式 CSRF/Origin 门；Live 的 POST/DELETE 命令不可只依赖 SameSite/CORS |
| Reader SSRF | 主导航每跳解析 DNS，混入非公网地址整跳拒绝，连接 pin 到已验证 IP | Chromium 子资源、worker、WebSocket 不受 Reader transport 保护 |
| Reader 凭证 | 不转发 Cookie、Authorization、Referer | Live context 必须是新建匿名 context，不能使用系统 Chrome profile，也不能持久化站点 cookie |
| PDF 同源交付 | digest 校验、同源 URL、`nosniff`、`CORP: same-origin` | Live frame 还需 `Cache-Control: no-store`、尺寸/速率/字节上限与 owner 检查 |
| 旧 iframe | sandbox 隔离第三方 origin | 仍允许 forms、popups、scripts；它不是可控浏览器，也不能作为 P0 Live Runtime 的回退实现 |

## 强制实现合同

### 1. URL 与网络边界

1. 顶层导航只接受无用户名密码的 `http:`/`https:` URL；拒绝 `file:`、`data:`、`javascript:`、`blob:`、`about:`、`chrome:`、`devtools:`、`view-source:`、`ftp:`、`ws:` 与 `wss:`。
2. 每次请求（document、stylesheet、script、image、font、media、XHR、fetch、manifest、worker）都在连接前执行同一套公网校验。
3. 域名解析结果只要混入一个私网、loopback、link-local、ULA、CGNAT、multicast、documentation 或其它保留地址，整次请求拒绝。
4. 实际 TCP/TLS 连接必须 pin 到刚刚通过校验的 IP，同时保留原始 Host/SNI；校验后不得让 Chromium 自己再次解析该 hostname。
5. HTTP redirect 的每一跳重新执行协议、端口、域名、DNS 与 IP pin；限制跳数与总 wall-clock deadline。
6. P0 阻断 WebSocket/WebTransport；阻断 Service Worker 注册与已经存在的 worker/cache 路径。
7. 拒绝 localhost、单标签内网名、`.local/.internal/.lan/.home/.localhost`，以及所有非默认端口，除非未来有独立 allowlist。
8. 浏览器 worker 必须经过独立 egress policy；仅依靠 Node/Playwright 的 route callback 不是充分的生产隔离，因为浏览器协议缺陷、预连接、DNS 与新资源类型可能绕过应用层代码。

### 2. 浏览器隔离

1. 每个 Onto `ownerId + sid` 使用独立 ephemeral browser context；禁止 persistent context 与宿主机 Chrome 用户目录。
2. user-data-dir 位于 0700 临时目录；退出、崩溃、idle TTL 与 session 删除后递归清理。
3. 禁止 `--disable-web-security`；生产环境不得用 `--no-sandbox` 作为安全设计。若运行平台必须关闭 Chromium sandbox，则外层必须是无宿主挂载、非 root、只读根文件系统、受限 syscall/capability 的容器或 microVM。
4. DevTools/CDP 端口不得绑定公网或局域网；优先 Unix socket/pipe。任何控制 token 都不得写日志或返回前端。
5. context 启动时 cookie/storage/cache 为空；运行中站点写入的数据只活在该 context，绝不跨 sid、owner 或进程重启恢复。

### 3. 外部副作用与设备权限

1. P0 默认只允许 GET/HEAD/OPTIONS。兼容公开 SPA 时，仅额外允许当前顶层页面 exact-origin、非导航、XHR/fetch 且请求体不超过 256 KB 的 POST；未知请求体长度、跨站 POST、导航 POST、PUT/PATCH/DELETE 均阻断。
2. 所有 download 事件立即取消；不得写入 workspace、Downloads 或 `/tmp` 的共享目录。
3. 所有 file chooser 立即取消；前端不得提供任意宿主路径。
4. 所有 popup/new page 事件立即关闭，或将其 URL 作为经过完整校验的新顶层导航处理；P0 不允许后台页继续运行。
5. 默认拒绝 camera、microphone、geolocation、notifications、MIDI、USB、serial、Bluetooth、screen capture、payment handler、idle detection、sensors、clipboard-read/write。
6. 不暴露剪贴板；不允许页面通过浏览器自动下载、打印、打开外部应用或自定义协议。

### 4. Onto 会话所有权、CSRF 与命令校验

1. create/navigate/frame/input/close 都必须先按当前请求用户验证 Onto `sid` 归属，再验证 browser runtime 属于同一 `ownerId + sid`；越权统一 404。
2. 所有状态变更请求执行 same-origin gate：`Origin` 必须等于服务 public origin；同时拒绝 `Sec-Fetch-Site: cross-site`。无 Origin 的程序客户端需要显式 CSRF token，不能默认放行。
3. CORS 只允许精确 origin；CORS 不是 CSRF 防护，不能替代上一条。
4. 命令 body 严格 schema：拒绝未知 action；URL 最长 4096；坐标必须是有限数且位于当前 viewport；文本输入 P0 禁用；未来启用时设置字符上限且不落日志。
5. 每个 runtime 使用不可猜 id，但 id 只作为定位符，不作为授权凭证。
6. 并发导航使用单调 command sequence 或 per-runtime lock；过期 frame/导航结果不能覆盖新页面状态。

### 5. Frame、截图与 AI 数据边界

1. frame endpoint 只返回当前 owner/sid 的 raster frame 或受控流，不返回第三方 HTML/JS。
2. 响应至少带：`Cache-Control: private, no-store`、`Cross-Origin-Resource-Policy: same-origin`、`X-Content-Type-Options: nosniff`；内容类型固定为允许的图片格式。
3. 限制 viewport、单帧字节、帧率、总带宽、并发截图与截图 wall-clock；超限返回 413/429，而不是无限分配内存。
4. frame/screenshot 不写普通请求日志、session state、事件 observation、AssetMemory 或模型 prompt；“存为材料”必须是用户显式动作并产生审计事件。
5. 浏览器 console、DOM、accessibility tree、network header/body 默认不出网；未来给 AI 使用时必须独立脱敏、限长、标记 untrusted 并绑定 URL/digest/time。

### 6. 容量与清理

1. 配置 per-owner、per-session、global runtime 上限；超过返回 429/503 和稳定错误码。
2. 配置创建超时、导航超时、空闲 TTL、绝对 TTL、最大请求数/字节数/CPU/内存。
3. close 幂等；浏览器断连、页面崩溃、HTTP client 断开、Onto session 删除、登出、服务 SIGTERM 都触发 context/page/process 清理。
4. server shutdown 必须等待有界 grace period，随后强制终止子进程；测试结束不得留下 Chromium、CDP socket 或临时目录。
5. 审计日志只记录 runtime id 摘要、owner/sid、目标 origin、动作种类、状态码、时延与字节数；不记录 cookie、header、表单值、剪贴板、完整截图或用户键入文本。

## 可自动化验收矩阵

以下 ID 应直接映射到 Vitest；不具备真实 Chromium 的单元环境使用 fake runtime/transport，另保留一个有 Chromium 的隔离集成任务。

| ID | 层级 | 场景 | 期望 |
|---|---|---|---|
| NET-01 | unit | `file/data/javascript/blob/about/chrome/ws/wss` 顶层 URL | 创建/导航在启动网络前 422/blocked |
| NET-02 | unit | `localhost`、127/8、0/8、RFC1918、169.254/16、CGNAT、IPv6 loopback/ULA/link-local/mapped private | 全部拒绝 |
| NET-03 | unit | DNS 同时返回公网与私网 IP | 整次请求拒绝，不尝试公网项 |
| NET-04 | integration | DNS 第一次公网、第二次私网 | 连接只使用第一次校验后 pin 的公网 IP，或请求被拒绝；不得重新解析后直连私网 |
| NET-05 | integration | 公网页面 30x 到 metadata/localhost | redirect 在访问目标前被拒绝 |
| NET-06 | integration | HTML 引用 private CSS/img/script/font/XHR/fetch/worker | 每一种均在连接前被拒绝 |
| NET-07 | integration | 页面建立 ws/wss/WebTransport | P0 全部拒绝，无 upgrade/socket |
| NET-08 | integration | 页面注册 Service Worker 并尝试 cache fetch | 注册/请求被拒绝，context close 后无 cache |
| ISO-01 | unit | 两个 sid 各创建 runtime | context/storage/cookies/runtime id 均不同 |
| ISO-02 | integration | runtime A 写 cookie/localStorage，关闭后新建 A2/B | A2/B 均读不到 A 数据 |
| ISO-03 | static | launch options | 无 persistent host profile、无 `--disable-web-security`；CDP 不监听非 loopback |
| ISO-04 | integration | context 崩溃/idle/close/SIGTERM | page/context/process/temp dir/socket 全部清理 |
| AUTH-01 | route | user A 访问 user B 的 sid | create/list 全部 404，provider 未调用 |
| AUTH-02 | route | user A 用自己的 sid 请求属于 sid B 的 runtime id | navigate/frame/input/close 全部 404 |
| AUTH-03 | route | 带合法 auth cookie 但 `Origin: https://evil.example` 的 POST | 403，provider 未调用 |
| AUTH-04 | route | `Sec-Fetch-Site: cross-site` 或无 Origin/无 CSRF token | 状态变更拒绝 |
| AUTH-05 | route | 同源 Origin + 正确 owner/sid | 允许；响应不暴露 owner、CDP endpoint/token |
| CRED-01 | integration | Onto cookie/Authorization 存在于 API 请求 | 第三方首个请求不含它们 |
| CRED-02 | integration | sid A 站点设置 cookie，sid B 打开同域名 | B 首个请求无 A cookie |
| SIDE-01 | integration | 页面发导航 POST、跨站 POST、超限/未知长度 POST、PUT/PATCH/DELETE | P0 阻断，页面状态返回受限提示 |
| SIDE-01A | unit | 当前页面 exact-origin XHR/fetch POST，body ≤ 256 KB | 允许；page 与 Worker 走同一合同 |
| SIDE-01B | unit | Dedicated Worker/EventSource 访问 private/mixed DNS，或 page+worker 超 512 requests/96 MB/8 workers | 阻断并停止新增请求/Worker |
| SIDE-02 | integration | attachment/JS download | 取消；磁盘无文件 |
| SIDE-03 | integration | `<input type=file>`/file chooser | 取消；页面拿不到路径或字节 |
| SIDE-04 | integration | `window.open`/target=_blank | popup 被关闭或 URL 经顶层导航门禁；无后台 page |
| SIDE-05 | integration | camera/mic/location/notification/clipboard 等权限请求 | 全部 denied |
| FRAME-01 | route | owner 读取最新 frame | 固定图片 MIME，`no-store`、CORP、nosniff，尺寸/字节在限额内 |
| FRAME-02 | route | 非 owner/错误 sid/已关闭 runtime 读取 frame | 404/410，无 frame 泄漏 |
| FRAME-03 | unit | 超大 viewport、NaN/Infinity/负坐标、超长 URL/body | 422；provider 未调用 |
| FRAME-04 | load | 超帧率/并发/带宽 | 429/413；进程内存保持有界 |
| DATA-01 | unit | 浏览器错误含 Cookie/header/键入内容 | API 与日志经过脱敏，不回传敏感值 |
| DATA-02 | route | 截图后读取 session state/AssetMemory | 未显式保存时不存在 screenshot/base64/DOM |
| LIFE-01 | unit | 同一 runtime 重复 close | 204/幂等；provider close 只发生一次 |
| LIFE-02 | unit | 达到 per-session/per-user/global cap | 稳定 429/503；不会先启动再丢弃浏览器 |
| LIFE-03 | integration | client 断开/导航超时/page crash | 租约释放，可再次创建；无 orphan Chromium |
| RACE-01 | unit | 慢导航 A 后快速导航 B | 最终 URL/frame 只能是 B；A 的迟到结果被丢弃 |

## 上线 Gate

- Gate A：NET-01 至 NET-08、AUTH-01 至 AUTH-05、CRED-01/02 全绿。
- Gate B：ISO-01 至 ISO-04、SIDE-01 至 SIDE-05、LIFE-01 至 LIFE-03 全绿。
- Gate C：FRAME/DATA/RACE 全绿；真实 Chromium 的端到端测试至少覆盖一个静态站、一个重脚本站和一个 redirect-to-private 攻击站。
- Gate D：生产部署使用容器/microVM egress policy；若当前仅有应用层 Playwright interception，则 UI 必须标“本地实验功能”，不得标“生产安全浏览器”。

## 后续阶段

- P1 可加入滚动、受限点击和地址栏历史，但不改变匿名、无持久凭证边界。
- P2 若要登录、输入、上传或下载，必须引入逐动作用户确认、独立密钥/文件代理、DLP/恶意文件扫描、审计与站点级 allowlist；不能沿用 P0 的隐式授权。
- 企业内网页面需要单独的 network policy 和管理员 allowlist，不能通过关闭 SSRF 门禁实现。
