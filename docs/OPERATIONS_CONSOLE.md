# 团播联动台运营管理后台

2026-10-13。管理服务和静态页面已部署到现有腾讯云上海服务器，**公网 DNS、HTTPS 和访问边界检查通过，首个负责人已完成开通并成功登录**。管理地址为 `https://admin.tuanbo-link.jinhefilm.com`，DNS 指向腾讯云且关闭代理。本次没有真实收款、退款、发码，也没有 commit/push。最新部署证据见文末。

## 已实现范围

React 管理页面：工作台、订单、授权及绑定设备、交付异常、售后、财务记录、操作日志、人员管理、安全设置。电脑表格和手机卡片使用同一套经 Zod 校验的 DTO。权限由服务器检查，按钮显隐仅改善使用体验。

| 操作 | 负责人 | 运营 | 财务 | 只读 |
|---|---|---|---|---|
| 脱敏订单、授权、状态查询 | 是 | 是 | 是 | 是 |
| 创建线下待核款订单 | 是 | 是 | 否 | 否 |
| 人工核款发码 | 是 | 否 | 是 | 否 |
| 查单、补发、领取凭据、完整码查看 | 是 | 是 | 否 | 否 |
| 撤销、符合等待规则的换机 | 是 | 是 | 否 | 否 |
| 内测与赠送授权 | 是 | 否 | 否 | 否 |
| 人工退款、开票记录、财务导出 | 是 | 否 | 是 | 否 |
| 支付宝原路退款（2026-10-14） | 是 | 否 | 是 | 否 |
| 处理渠道退款：撤销或保留授权（2026-10-14） | 是 | 是 | 否 | 否 |
| 创建、处理售后工单 | 是 | 是 | 是 | 否 |
| 人员管理、全局操作日志 | 是 | 否 | 否 | 否 |

### 授权与财务规则

- 线上订单沿用原渠道验签和核款，不能改成人工付款；已收款但未交付列为异常，不要求客户重新购买。
- 线下订单填写实际金额和截止时间，由管理员或财务确认真实流水后发码。收款事实先保存；交付失败不会撤销已确认的收款记录。
- 内测、赠送仅管理员可发，数量 1–100，期限必填，一码一机。独立 `test/gift` 来源、订单金额零、没有付款流水或收款记录。许可证仍为兼容旧客户端的期限授权，不启用 `trial` 或客户端绕过开关。
- 续费列表展示原码和原订单延长的期限。没有直接改写付费期限、批量清除绑定或删除订单入口。
- 撤销阻止新的激活和启动验证，不会强停已经开始的演出。换机须先撤销并等待最后签发凭证到期及五分钟容差；新码生成后旧码永久失效，旧领取凭据撤销。
- “绑定”不是设备在线状态；没有在线心跳。历史没有记录的时间显示未采集。
- 开票为**人工记录**，不生成税务票据。2026-10-14 起支付宝订单可在订单详情“支付宝原路退款”，规则见 [商业接口：退款规则](COMMERCIAL_API.md#退款规则2026-10-14-确定)：全额原路退款自动撤销本订单授权，部分退款、续费订单退款及支付宝后台直接退款进入“交付异常”，由运营“处理渠道退款”撤销或保留授权。其他退款仍人工办理后登记，累计不能超过已确认收款；关闭工单必须填写授权处理结论。
- 发票进度采用追加处理记录；已开票必须有发票编号，不允许重复登记同一已开票编号。
- 财务 CSV 最多一万条，按筛选条件导出，不含客户名称、激活码和机器码；金额为整数分，有表格公式注入和长流水号保护。超过上限需缩小日期范围。

## 认证与接口

账号密码＋TOTP；密码随机盐 scrypt，TOTP 使用独立管理密钥 AES-256-GCM 加密，恢复码单次使用、仅存摘要。每个账号必须完成验证器绑定，没有默认账号密码和公开注册。

Cookie 为 `__Host-tblink-console`，具有 `Secure/HttpOnly/SameSite=Strict/Path=/`；服务端会话空闲 30 分钟、最长 8 小时失效。修改人员角色、禁用或重置认证会撤销该账号会话，最后一个已开通管理员不能被降级、禁用或在线重置。

核款、完整码查看、特殊授权、领取凭据签发、撤销、换机和权限变更要求最近五分钟内二次验证。验证码有时间窗及重放防护；验证器和恢复码均不可重复使用。身份类接口按来源和账号限制尝试次数。写请求检查精确 Origin 和 CSRF，管理 API 还检查 Host。后台令牌不进入浏览器。

旧 `/admin/*` 仍仅供本机或运维隧道使用。管理域名仅公开以下 `/console-api/*`；购买站和原 API 站不代理它们。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/login`、`/enrollment-info`、`/enroll` | 登录、一次性凭据开通与验证器绑定 |
| GET | `/session` | 当前人员、角色、CSRF、最近二次验证时间 |
| POST | `/verify`、`/logout` | 重新验证、退出并撤销会话 |
| GET | `/overview` | 工作台与真实维护回执；缺回执明确显示未知 |
| GET | `/orders`、`/licenses`、`/exceptions`、`/tickets`、`/finance`、`/audit`、`/users` | 分页查询及角色限制 |
| GET | `/orders/:id`、`/licenses/:id`、`/tickets/:id` | 脱敏详情、关联记录；运营仅看自己成功处理对象的历史 |
| POST | `/commands` | `{operationId,input}`，input 为共享契约中的判别联合 |
| GET | `/operations/:id` | 当前人员查询自己原操作结果，不恢复敏感凭据 |
| GET | `/export` | 管理员／财务导出脱敏 CSV |

上述路径均以 `/console-api` 为前缀。共享契约位于 `apps/licensing-server/src/console-contract.ts`。列表最多每页 50 条；筛选参数 `q,state,channel,from,to,page`，订单日期按上海自然日包含起止日。

写操作以 UUID 作为幂等编号。同编号不同请求拒绝；重复提交不重新发码。同编号的完成结果恢复不会再次暴露完整凭据。浏览器遇到未知结果先查询原编号，不自动重试；因断电保留的 `pending` 操作需核对对象和审计，不能直接当作未执行。查单本身不扣款，已付款交付仍使用原服务的幂等规则。

操作日志包括人员、对象、原因、结果、请求编号。完整码默认不显示；受保护查看会审计。敏感结果只保存在加密幂等结果中，浏览器显示 60 秒后隐藏。日志不记录登录请求正文、密码、TOTP、Cookie 或完整激活码。操作原因里的常见激活码、领取凭据和长十六进制秘密进行脱敏。

## 构建与隔离验收

在 Windows 原生 PowerShell 的仓库根目录运行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @tb/licensing-server typecheck
pnpm exec eslint apps/licensing-server scripts/verify-console.mjs
pnpm exec vitest run apps/licensing-server apps/desktop/src/main/link/license-service.test.ts apps/desktop/src/main/link/license-access.test.ts apps/desktop/src/main/link/purchase-service.test.ts
pnpm --filter @tb/licensing-server build
pnpm --filter @tb/licensing-server build:web
pnpm --filter @tb/licensing-server build:console
$env:TBLINK_TEST_BROWSER_CHANNEL = 'msedge'
node scripts/verify-console.mjs
python -m unittest discover -s apps/licensing-server/deploy -p test_console_deployment.py
```

CI 安装 Playwright Chromium 后运行同一个浏览器脚本，不设置浏览器渠道。脚本创建临时独立数据库、随机测试密钥，在浏览器测试上下文拦截管理站请求并转发本机服务；不连接生产管理站，不使用真实支付。截图输出到 `apps/licensing-server/dist/console-review/`，不进入版本控制。

产物：`dist/index.js`、`dist/console-bootstrap.js`、`dist/console/{index.html,console.js,console.css,manifest.json}`。源码测试夹具不作为生产入口。网站构建路径现使用 `fileURLToPath`，支持 Windows 中文目录。

## 首次生产安装

以下为首次安装完整流程。2026-10-13 已完成服务、页面、公网入口及首个负责人开通；异地备份仍待完成，公网可访问不代表真实交易验收通过。

1. 通过已核实的 SSH 主机配置连接现有服务器，确认服务账号、当前版本、磁盘容量和备份。所有本机命令使用原生 Windows；服务器维护脚本在既有 Linux 服务主机运行，不使用 WSL 代替 Windows 验收。
2. 为管理域名配置正确的 DNS 和独立 TLS 证书。安装 `console-site.conf` 为 `/etc/nginx/sites-available/tblink-console.conf`，检查并启用。不要将 `/admin/*` 暴露到公网。保持官网/API/更新站配置独立。
3. 服务器内部生成独立 32 字节随机管理密钥，base64 保存至 `/etc/tblink-licensing/console-key.txt`，服务账号可读、权限 0600；不可复用后台 Bearer 令牌或下载密钥到本地。`service.env` 新增 `CONSOLE_ORIGIN=https://admin.tuanbo-link.jinhefilm.com` 与 `CONSOLE_KEY_FILE`。两个配置必须同时提供，否则管理功能保持关闭或配置错误时拒绝启动。
4. 完成 SQLite 一致性备份、既有密钥备份与隔离恢复核验，然后安装新服务。管理表采用版本化增量事务迁移，不改写旧订单、旧码、公钥和领取凭据。
5. 在服务器显式安装本次 `publish-console.py` 和更新后的 `receive-release.py`、`deploy-from-ci.py` 对应接收契约；更新受限部署政策中的 `nginxSha256` 和新增 `consoleNginxSha256`，两者分别绑定已核验的业务站和管理站配置。旧接收器会拒绝新增产物，不能直接以一次普通自动部署跳过此次运维升级。
6. CI 产物增加独立 `console/` 和引导程序。发布工具验证外层归档摘要与管理站内部文件清单，只切换 `/srv/tblink-console` 的受管版本符号链接，不覆盖购买站。安装引导程序到 `/opt/tblink-licensing/dist/console-bootstrap.js`。
7. 在服务器以服务账号运行引导程序，并提供环境变量 `LICENSE_DATABASE`、`CONSOLE_KEY_FILE`、`CONSOLE_BOOTSTRAP_USERNAME`、`CONSOLE_BOOTSTRAP_OUTPUT`。输出路径必须全新且位于受限目录；凭据不写 stdout、不作为命令行参数。首个管理员在网页“使用开通凭据设置账号”中设置密码、绑定验证器并保存恢复码。
8. 首个账号未完成开通且凭据过期时，可用同一个用户名和新的输出路径再次运行本地引导；旧邀请立即失效。已经开通的管理员不能通过该工具重置。建议立即开通第二名管理员，避免验证器和恢复码同时丢失导致无法恢复。
9. 检查管理站 HTTPS、未认证 401、错误来源与 CSRF 403、旧 `/admin/*` 公网 404、四类角色权限、退出及会话撤销。再核对原官网目录、购买恢复、激活和更新源。

域名、身份、密钥、接收器政策、异地存储均属于实际部署输入，不能以示例值声称配置完成。

## 加密备份、回滚与维护

新增 `backup-console.py` 使用 SQLite backup API 包含 WAL 中已提交内容；将数据库及服务密钥打包，用 **age 公钥加密** 后才写入持久备份和异地卷。解密私钥只保留在离线恢复端。生产主机需安装 age。

服务器 `/etc/tblink-licensing/backup.json` 的配置格式：

```json
{
  "ageRecipient": "填入离线生成的真实 age 公钥",
  "offsiteMount": "/mnt/tblink-offsite",
  "offsiteDirectory": "/mnt/tblink-offsite/licensing"
}
```

异地卷必须已经显式挂载，且不是本地备份所在文件系统；应由运维确保该挂载实际位于异地，文件系统检查本身不能证明物理位置。本地与异地加密文件逐一校验摘要，成功后才按严格文件名规则清理超过 30 天的本项目备份。恢复任务状态数据库也随备份保存。任何加密、复制或校验失败均报错并记录失败状态，不自动重试、不谎报成功。

安装 backup service/timer 后先手动执行一次并核验，再启用每日北京时间 03:15 的定时任务。安装 health service/timer 后每五分钟采集既有交付恢复服务的实际运行结果。后台分别显示最近备份尝试、最近成功备份和恢复任务回执；尚未运行时显示未知。

离线恢复演练：在持有 age 解密身份的隔离主机运行 `verify-console-backup.py <加密归档> --identity <离线身份文件>`。脚本校验成员路径和摘要、SQLite 完整性及外键，输出对象计数；不会恢复覆盖生产。另须在隔离授权服务中验证旧码、续费和领取凭据，才能完成运维交接。

部署接收器在运行时升级前开启 `/srv/tblink-console-maintenance`，暂停已安装的后台备份／健康定时任务，并记录原先运行的 timer。全部产物核对成功后解除维护并恢复 timer；失败保留维护标记、日志和暂停清单，等待运维核实，不能自动恢复不一致的界面。

回滚按接收器留下的 runtime、website、console 回执恢复程序与静态版本，不覆盖数据库。首次发行后若已签发零金额特殊授权，不能回退到不认识特殊授权的旧服务；应使用支持此 schema 的版本或向前修复。禁止恢复旧数据库抹掉上线后的收款、发码和审计。

## 本次验收结果与待办

- 授权、支付、购买及客户端许可专项：147 项通过，包含管理服务和真实 HTTP 权限测试。
- 全仓 `pnpm typecheck`、授权服务及管理端定向 ESLint、服务／官网／管理端构建通过。
- 浏览器：隔离真实服务的开通／TOTP／登录、创建线下订单、核款发码、完整码查看、运营关闭工单、财务退款与开票登记、四类角色及 390px 手机无横向溢出通过；桌面和手机截图已人工检查。
- 新发布与备份工具：5 项测试通过，覆盖清单摘要、异常成员、SQLite WAL 备份恢复、保留策略及异地挂载检查。
- 台账导出套件在 Windows UTF-8 模式下存在 POSIX `0600` 权限断言失败；保留原断言，不改成 Windows 假通过。新增特殊授权不计历史收款缺口用例。依赖 `fcntl/systemd` 的 Linux 发布套件需在既有 Linux CI 执行。
- 原验收时尚未完成生产部署；2026-10-13 的实际部署和剩余事项以文末为准。age 加密归档的实际离线解密演练、真实异地备份、生产升级回退演练、真人付款→发码→Windows 激活→续费仍未完成。

自动开票、渠道与银行对账、微信生产开通、设备 TPM 证明、Windows 发行签名及多产品管理不在本期实现范围。

## 单码到期时间调整（2026-10-06）

管理员在「激活码与设备 → 查看详情 → 调整到期时间」中按北京时间设置单个码的截止时间，必填原因，并要求最近五分钟二次验证。支持延长和缩短；永久码设置日期后变为期限授权。已撤销的码不可修改，截止时间必须在未来；立即撤销请走撤销入口。

`set-expiry` 命令包含 `id`、`useUntil`（UTC ISO 日期）和 `reason`，沿用幂等操作编号。独立 `license_term_overrides` 表保存单码期限，不改原订单金额、更新权益及同订单其他码。后续付费续费从当前有效期限计算并更新单码期限。审计记录原期限、新期限和原因。

修改在后续服务端激活/验证时使用；不会使已签发的离线凭证立即失效，也不强制结束已运行会话。客户端运行期远程停用不在本次实现内。

验证：授权服务类型检查、17 项服务及管理操作测试、前端构建通过；浏览器已确认负责人详情页按钮和北京时间编辑表单。

## 2026-10-13 腾讯云生产部署

继续使用腾讯云上海 `123.206.229.200`，2 核 / 2GB。SSH 实测根分区余量约 35GB，登录时内存使用约 26%。授权 API 域名直接解析到该 IPv4，客户 HTTPS 请求由服务器 Nginx 接收；本次没有启用 Cloudflare HTTP 代理或迁移授权服务。

### 验证和安装结果

- Windows 本地授权服务类型检查、服务构建和管理端构建通过。授权、支付、机器码及桌面购买专项完整复跑 151 项通过；首次运行有一项续费拒绝测试收到连接异常，单文件及完整复跑均通过，尚未确认该偶发失败的根因。
- 隔离浏览器验收通过：账号开通、TOTP 登录、人工核款交付、受保护查看、售后、财务记录、四类角色与手机布局。使用测试数据库和密钥，没有生产交易。
- 部署包 `console-rollout-20261013.tar` SHA256：`aef0451499dd320ff55511d8ff5cce660ec3e2d9fe2acf57b4183724b7a5f407`。上传至服务器 `/home/ubuntu/tblink-console-rollout-20261013.tar` 并验证摘要，在同名目录解包。服务器隔离运行管理部署 5 项、运行时部署 17 项、受限接收器 8 项测试，全部通过。
- 授权 bundle 更新至源码 `fbf2c92f851db6239d6e037529248a5be0ac420a`，SHA256：`e9315732170b50927e71a5be5d17217f07041ceae3bbecbeddf5d577abbba6df`。服务和管理端输入无本轮源码修改；工作区其他桌面修改没有打入本次服务产物。
- 使用既有 `activate-release.py` 完成维护切换、SQLite 一致备份、独立副本恢复和旧表内容核对。回执确认既有数据与商品目录保留，原 Nginx 配置摘要保持不变。运行时备份：`/var/lib/tblink-licensing/backups/20261013T114206Z`；服务器受限配置备份：`/var/lib/tblink-licensing/backups/console-preflight-20261013T114205Z`。这些是同机备份，不代表异地灾备。
- 管理静态页面发布至 `/srv/tblink-console-releases/e860e0193c45449f97278c333a7c6096`，`/srv/tblink-console` 为受管符号链接；引导程序安装到 `/opt/tblink-licensing/dist/console-bootstrap.js`。管理发布归档 SHA256：`359c1ab61347f19215695b7e09e6f77f3fecc1a6739cb42868405a9536457837`。
- 服务器生成独立管理加密密钥，文件仅服务账号可读，未返回本机或日志。环境新增 `CONSOLE_ORIGIN` 和 `CONSOLE_KEY_FILE`，保留原支付、许可签名和数据密钥设置。管理启用备份与回执：`/var/lib/tblink-licensing/backups/console-enable-20261013T114504Z`。
- 回环访问 `/console-api/session` 并使用正确管理 Host，未登录返回 401。授权服务、Nginx、交付恢复 timer、金河分镜和无忧排班均为 active。
- 安装管理发布、备份、恢复核验和健康采集脚本。健康采集 service 手动执行成功，已启用每五分钟运行的 `tblink-console-health.timer`；备份 timer 尚未启用。
- Cloudflare 已保存 A 记录 `admin.tuanbo-link → 123.206.229.200`，仅 DNS、TTL 自动。管理请求直连腾讯云，不经 Cloudflare HTTP 代理；既有记录未修改。
- 管理域名独立证书签发成功，有效至 2027-01-11；`certbot renew --cert-name admin.tuanbo-link.jinhefilm.com --dry-run` 成功，`certbot.timer` active。已安装独立续期 Nginx 重载钩子并手动执行通过。
- 安装独立管理 Nginx 站点，SHA256 `3f7dab37c50f6b304532fc6ba5e1db2808c667f27e7067032906b97793088c38`。公网 HTML/JS/CSS 返回 200、未认证会话 401、错误 Origin POST 403；管理域名旧 `/admin/orders` 和静态清单 404，官网/API 域名的 `/console-api/session` 为 404。带真实登录会话的 CSRF 公网验收尚未执行。
- 发布工具与接收器已升级至本次部署源码，受限政策新增管理 Nginx 摘要且保留原业务站摘要。升级持有部署锁并备份旧工具及政策至 `/var/lib/tblink-licensing/backups/console-tools-20261013T121938Z`。补充官网发布和 CI 上传 11 项隔离测试通过，本轮服务器隔离部署测试合计 41 项；没有触发真实 CI 发布。
- 首个负责人 `flacier` 已由本人完成密码及验证器设置并成功登录。生产浏览器确认角色为负责人，既有未付款验证订单详情与激活码列表可正常加载，激活码列表为空。开通凭据不再用于用户名或日常登录；未在文档或日志记录 token、密码、验证器密钥或恢复码，恢复码由本人保管。
- 收尾公网核验：授权 `/health` 为 200，支付宝商品目录仍开放且保持月付 800 元、年付 8,000 元；Windows 更新清单仍为 0.4.29。授权服务、Nginx、健康采集及证书 timer 均 active。

### 仍需完成

1. 生产开通、登录和页面读取已验证；生产退出、会话撤销及带真实会话的 CSRF 拒绝尚未专项验收，相关流程的隔离测试已通过。
2. 接收器已更新，但尚未触发包含管理端的完整 CI 实际发布或生产回退演练。
3. age 已安装，临时数据真实加密恢复测试已通过（见文末）；仍没有已配置的异地挂载或离线恢复公钥，生产加密异地备份和实际恢复演练未完成。
4. 部署阶段未创建订单或授权；随后用户本人在后台创建了 10 枚一天期限的测试激活码，浏览器已确认列表出现。这只能证明手工测试发码可用，不能当成真实付款交付通过。真实付款、Windows 激活、跨机拒绝、续费、撤销及换机验收仍未完成。
5. 正式 Windows 下载仍为 0.4.29，本次仅部署授权服务和管理端文件，没有发布桌面安装包。

### 2026-10-13 恢复核验补充

离线核验工具已收紧跨平台归档路径检查，并对附带的恢复任务数据库执行 SQLite 完整性及外键检查。Windows 与生产服务器隔离测试各 4 项通过、1 项真实 age 用例跳过。核验工具更新于 `20261013T152641Z`，安装摘要为 `1abbfbe8d6b364cbc88c33394dfb22b459ca0a16fe67589be9fab0239e0fd4a4`；原工具备份于 `/var/lib/tblink-licensing/backups/restore-verifier-20261013T152641Z`，未改运行数据库或重启服务。

随后只读核对生产：订单 2、授权 10、支付回执 0、管理用户 1；age 未安装、备份配置不存在、备份 timer 未安装。此结果仍不能证明真实付款闭环或异地灾备完成。详细证据见 `artifacts/functional-acceptance-20261013`。

之后已从 Ubuntu 软件源安装 age 1.2.1-1build1，仅新增 age 包，未升级其他包或重启服务。Windows 官方 age 1.3.2 下载及摘要核验也已完成。两端恢复套件各 5 项全部通过，包括真实加密/解密、错误身份拒绝及损坏密文拒绝；服务器测试脚本与已安装核验工具摘要一致。测试仅涉及临时数据库及临时密钥，不是生产加密归档恢复。生产备份仍缺实际异地存储与离线恢复公钥；未配置备份任务、未生成生产恢复身份。证据为 `restore-age-windows.txt` 与 `restore-age-linux.txt`。
