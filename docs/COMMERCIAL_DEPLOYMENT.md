# 公司域名与服务器部署交接

2026-09-28。目标为现有腾讯云上海 `jinhe-cloud`，2 核 / 2GB / 4Mbps；授权服务已部署至回环地址，Cloudflare DNS 与公网 HTTPS 已启用。主域名 `jinhefilm.com`，项目层采用 `tuanbo-link`。本文件不保存服务器口令、SSH 私钥或商户秘密。

## Cloudflare 已配置的记录

已在 `jinhefilm.com` 的 DNS 页面添加以下记录，内容均填写腾讯云控制台这台实例的**公网 IPv4**，不能填写 Tailscale 的 `100.x` 地址。无需给 `tuanbo-link` 建 NS 委派，也不需要通配记录。

| 类型 | 名称 | 内容 | 代理 | TTL | 用途 |
| --- | --- | --- | --- | --- | --- |
| A | `api.tuanbo-link` | 服务器公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 激活、未来支付 |
| A | `updates.tuanbo-link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 安装包与更新清单 |
| A | `tuanbo-link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 网站预留，当前返回 404 |

先检查是否已有同名 A/AAAA/CNAME，确认后改记录，不能覆盖其他业务。暂不添加 AAAA：有 IPv6 地址不代表公网路由、云防火墙和 Nginx 的 IPv6 链路已验收。如果暂不添加网站记录，也暂不启用反向代理模板的 `tuanbo-link.jinhefilm.com` 站点块。

三条记录已在 Cloudflare 的 Comment 字段填写以下用途，后续修改应保留既有备注；填写备注不代表对应接口已经上线：

| 名称 | Comment |
| --- | --- |
| `api.tuanbo-link` | 团播联动台：授权激活 API，后续支付回调预留；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS；管理员接口不对外。 |
| `updates.tuanbo-link` | 团播联动台：Windows x64 更新清单与正式安装包出口；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS。 |
| `tuanbo-link` | 团播联动台：未来产品网站预留；当前无网页，计划返回 404；源站 jinhe-cloud（腾讯云上海）；仅 DNS。 |

2026-09-28 已在 Cloudflare 管理页新增以上三条 A 记录，逐条核实公网 IPv4、仅 DNS、TTL Auto 和 Comment；原有记录未修改。服务器正常解析三个域名并通过 ACME 校验，本地一度存在 API 域名的负缓存，随后普通 HTTPS 请求也通过。

Cloudflare 全区接入下，普通 Universal SSL 通常仅覆盖根域和一级子域，`api.tuanbo-link.jinhefilm.com`、`updates.tuanbo-link.jinhefilm.com` 不在该范围内。初期使用仅 DNS，使用现有 Nginx + Certbot 申请和续期覆盖实际主机名的公网证书。以后启用代理，需要先配置确实覆盖这些主机名的边缘证书（例如适用的 Advanced Certificate / Total TLS 或自定义证书），并使用 Full (strict) 校验源站证书。不能把 Flexible 当作替代。

仅 DNS 不经过 Cloudflare HTTP 代理，因此没有 Cloudflare WAF/CDN 的访问保护与带宽卸载，下载流量全部由腾讯云承担。4Mbps 理论上限约 0.5MB/s，200MB 完整包单用户约需 7 分钟，多人会共享带宽，实际更慢。先保持同服务器出口；流量增长时可在保留域名的前提下迁移对象存储/CDN，仍需校验更新包。

依据：[DNS 记录操作](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)、[Universal SSL 覆盖限制](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)、[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。

## 服务器布局与端口

```text
公网 80/443 → 现有 Nginx（本项目独立站点已启用）
  api.tuanbo-link.jinhefilm.com/health       → 127.0.0.1:8787
  api.tuanbo-link.jinhefilm.com/v1/activate  → 127.0.0.1:8787
  api.tuanbo-link.jinhefilm.com/admin/*     → 404（不转发）
  updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml → 静态更新清单
  updates.tuanbo-link.jinhefilm.com/windows/x64/Tuanbo-Link-Console-X.Y.Z-x64.exe
  tuanbo-link.jinhefilm.com/*               → 404（网站尚未建设）

/opt/tblink-licensing/               服务代码和运行依赖
/etc/tblink-licensing/               仅服务账号可读的密钥、环境文件
/var/lib/tblink-licensing/           SQLite、WAL 和审计数据
/srv/tblink-updates/windows/x64/    仅已验收的正式公开文件
```

本服务器使用 [Nginx 配置](../apps/licensing-server/deploy/nginx.conf)、[systemd unit](../apps/licensing-server/deploy/tblink-licensing.service)、[环境示例](../apps/licensing-server/deploy/service.env.example)。将本项目配置作为独立站点启用，不覆盖其他站点。[Caddyfile](../apps/licensing-server/deploy/Caddyfile) 仅供以后全新环境使用，不在本机与 Nginx 同时绑定 80/443。线上反向代理目前只开放健康与激活路径。本地模板新增支付宝通知的精确路径代理，未同步生产；服务未完整配置支付宝时仍返回 404。不得放开全部 `/v1/*` 或 `/admin/*`。

腾讯云防火墙与系统防火墙允许公网 TCP 80/443，用于 HTTPS 和证书校验；8787、数据库和管理员 API 不开放公网。SSH 用户名已确认为 `ubuntu`，本轮公网 SSH 可用，Tailscale SSH 连接超时，尚未验收该运维通道。域名仅 DNS 的 HTTPS 请求来自用户公网网络，普通客户不需要加入 Tailscale。

本次已登录腾讯云核实主域名为公司主体、状态正常、已接入腾讯云并关联目标实例。顶级域名有效备案后，下级子域名通常无需逐个重新备案；若原接入商不是腾讯云，应办理腾讯云接入备案，新的业务内容还应核对是否需变更网站信息。详见 [办理执行单](COMMERCIAL_ONBOARDING.md)。支付商户审核可能要求可访问的产品介绍、服务条款与售后联系方式；当前 404 占位不等同满足进件材料。

## 部署顺序

1. 核实 SSH 用户名、备份、磁盘余量和已有服务。读取服务状态前也不应把用户口令放到脚本或仓库。实例内存有限，在本地或 CI 构建，生产只运行服务及既有 Nginx。
2. 安装支持 `node:sqlite` 的 Node 22.16+ LTS，建立 `tblink-license` 用户及上述目录。服务构建命令 `pnpm --filter @tb/licensing-server build`。当前构建已将锁定的 zod 打包进 `dist/index.js`；运行时只需 Node 内建模块。部署时保留 `package.json` 的 `type: module`，无需在生产安装 npm 依赖。
3. 离线生成生产 Ed25519 签名密钥、独立随机 32 字节数据密钥、至少 32 字符随机后台令牌。按环境示例使用受限文件注入。私钥和数据密钥必须加密离线备份。客户端只编入公钥，绝不分发私钥或后台令牌。
4. 核对 systemd 中 Node 路径，启动服务，确认回环 `/health`。数据库目录权限 0700、密钥文件权限 0600。运营通过 SSH 本地转发访问回环地址，仍须 Bearer 认证；后台响应含激活码，不保存原始终端输出。
5. 在 Cloudflare 添加上述 DNS；核实 DNS 和 CAA 不阻止证书签发。先启用模板中的 HTTP ACME challenge 站点，通过既有 Certbot 的 webroot 方式申请覆盖三个主机名的证书（cert-name 为 `tuanbo-link.jinhefilm.com`）；证书存在后再启用 HTTPS 块。执行 `nginx -t`，成功后 reload；核对续期任务及 Nginx reload hook。将 [证书部署钩子](../apps/licensing-server/deploy/certbot-deploy-hook.sh) 安装至 `/etc/letsencrypt/renewal-hooks/deploy/tblink-nginx-reload`，权限 0755；仅本项目证书续期后检查并重载 Nginx。不得为了签发证书停止已有站点。
6. 创建更新静态目录，Nginx 用户只读，发布用户可写。按[更新发布步骤](SOFTWARE_UPDATES.md)上传，目录中不放数据库、备份、密钥、内部构建清单或诊断日志。
7. 完成以下探测和 Windows 实机流程，再开放商业销售。生产域名已编入客户端，DNS 和 HTTPS 已通过本次探测；客户端配置及服务探测不能替代商户开通和端到端验收。

## 验收探测

```sh
curl --fail --max-time 15 https://api.tuanbo-link.jinhefilm.com/health
# 预期 200 JSON {"status":"ok"}
curl --max-time 15 -o /dev/null -w '%{http_code}\n' https://api.tuanbo-link.jinhefilm.com/admin/orders
# 预期 404；不得出现订单或认证业务响应
curl --max-time 15 -o /dev/null -w '%{http_code}\n' https://tuanbo-link.jinhefilm.com/
# 预期 404，当前没有网页
curl --fail --max-time 15 -I https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml
# 发布后 200，Cache-Control: no-store；尚未发布为 404
```

对实际版本安装包检查 HEAD 的长度、Range 请求的 206 响应、本地 SHA-512 与 `latest.yml` 相符、Windows Authenticode 发布者和签名状态正确；测试未列入白名单路径返回 404、跨机激活拒绝、并发激活不多占席位、支付未实现路径不存在。必须完成检查→完整下载→停止联动→保存→确认安装→原目录自动重启，全程不停止 OBS/P1。

当前授权进程限流为每 socket IP 120 次/分钟；Nginx 回环代理会共享该限额，这是当前上线容量限制。已准备 Nginx 真实连接 IP 的激活限流（每分钟 30 次、burst 5），仍需压测并处理进程共享总限额，不能盲信外部 `X-Forwarded-For`，也不能直接放大到无限制。本地新增支付宝通知、客户领取与其余请求的独立限流预算（各 120 次/分钟/连接来源）；未同步生产。仍须结合真实负载验收，避免反代共享限额影响渠道重发。

## 恢复和回退

备份 SQLite 使用在线备份或停服快照，包含一致的 WAL 状态；恢复演练必须连同数据密钥、签名 keyId 及旧公钥验证。单机故障恢复后，旧订单、码、绑定及最大签发租约不能丢失。服务器时钟同步也属于恢复验收。

本次授权服务升级使用版本化脚本 `apps/licensing-server/deploy/activate-release.py`，在公司服务器由 root 执行：

```sh
python3 activate-release.py RELEASE.tar ARCHIVE_SHA256 CURRENT_BUNDLE_SHA256 CURRENT_NGINX_SHA256
```

发布包仅包含 `dist/index.js`、`revision.txt`（源提交完整 SHA）和 `nginx-routes.conf`（待新增的精确路径）。先在本地完成类型检查、授权/交付/支付通知回归及服务构建，生成包摘要；脚本同时核对包、线上旧 bundle 和旧 Nginx 文件摘要，任何漂移均停止，不能绕过核对重新运行。

脚本只停止团播授权服务，在原服务器受限目录保留旧代码、旧代理和一致数据库备份，用 SQLite backup API 恢复到独立副本并核对表数据摘要、完整性和外键，再切换代码。新增代理块插入 API 站点原有默认 404 前，原文件其他内容保持不变。失败恢复旧代码与代理；新增领取表兼容旧代码，不用旧数据库覆盖可能已提交的数据。成功记录发布 SHA、bundle/代理摘要及备份路径。该脚本针对本次追加领取表及指定代理路径升级，已存在路径时拒绝重复插入，不是任意版本的通用迁移工具。

数据库副本恢复验证不等于整机灾备；私钥和数据密钥未复制到本地或发布包，异地加密备份与丢失主机后的完整恢复仍需另行完成。

更新文件先备份清单再发布；有问题时可以撤回最新清单到上一个可信版本，阻止新用户继续下载，但已经安装新版的机器不会自动降级。应发布更高版本修复或走经确认的人工恢复。不同版本文件不可覆盖；保留旧资产供已经读到旧清单的客户端完成下载。

## 当前部署记录

- 已通过用户授权的 ubuntu 密码登录，原有 Nginx、金河分镜和无忧排班保持 active，未修改其配置。
- 已从 Ubuntu 官方签名仓库安装 Node 22.22.1。服务器 `/tmp` 内存盘满，安装使用 `TMPDIR=/var/tmp`，未删除现有文件，未关闭软件包签名校验。此存量问题仍需后续单独排查。
- `tblink-licensing.service` 已启用并运行；`127.0.0.1:8787/health` 为 200，未认证后台请求为 401，只绑定回环地址。服务账号 `tblink-license`。
- 生产 Ed25519 私钥、数据密钥和后台令牌仅在服务器生成，密钥目录 0700、文件 0600。公钥已编入客户端。尚无生产订单、发码、支付或开票；异地加密备份/恢复演练待完成。
- 本地与远端服务 JS 的 SHA-256 一致：`f0b70d0590326bfff04ed6dc553eb60fe99878e54a3f865dfa02695400bac63a`。
- 独立站点 `/etc/nginx/sites-available/tblink-licensing.conf` 已链接至 sites-enabled，先通过 HTTP webroot 申请证书，再加载完整 HTTPS 配置。`nginx -t` 通过，既有两个业务服务保持 active，金河分镜公网返回 200。旧站点的 http2 弃用提示及共享 443 的 protocol options 提示仍存在；未修改旧站点。
- 三个新域名 DNS 已配置，Let’s Encrypt 证书覆盖三个 SAN，有效期至 2026-12-26（UTC）；使用服务器现有 ACME 账户，无新增付费证书。`certbot.timer` 已启用，项目专用 reload hook 已安装并执行成功。限定本证书的 `certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew` 演练通过，部署钩子执行完成。
- 公网普通 HTTPS 请求：健康检查 200；空激活请求 400 `INVALID_REQUEST`；后台路径 404；未实现的支付宝通知路径 404；更新清单 404 且带 `Cache-Control: no-store`；更新目录与预留网站 404。尚未上传正式 Windows 安装包，尚未完成真实机器的生产激活和自动更新验收。
- 后台令牌、私钥及登录密码未下载到本地或写入仓库。回环健康通过不等于公众可激活、收款或自动开票。

## 支付宝回调部署前置（本轮未部署）

本地代码和 Nginx/Caddy 模板已增加精确路径 `/v1/payments/alipay/notify`。先完成商户和应用产品审核、获取并核对官方验签公钥，然后按环境示例设置三项配置；先在测试环境验证，再随已批准的真实小额验收上线。必须备份 SQLite 后上传新 bundle、校验摘要、检查 Nginx 配置并重载；不能只打开代理而继续运行旧 bundle。当前服务器仍运行此前构建，未变更配置、未填写商户身份、未接收真实付款。

## 客户领取接口部署前置（本轮未部署）

本地模板新增仅 GET 的 `/v1/orders/<UUID>` 精确格式代理，未开放 `/admin/*`。Node 在订单专属 Authorization 验证通过后才返回交付字段。不得将凭据改为 URL 参数；保留默认无请求头/响应体的访问日志。客户领取、支付宝通知与产品请求各使用独立限流预算，回环反代下每组仍共享每分钟 120 次的限额。

升级会新增 `order_delivery_access` 表，既有订单不会自动获得公开领取权限。部署前备份 SQLite（含一致 WAL 状态）并验证恢复；部署后用专门测试订单验证匿名、跨订单、过期及撤销拒绝，再验证支付后领取同批授权。只有页面与实际购买流程接入后才能宣称客户自动交付上线。本轮仅本地测试和提交，没有修改生产数据库、Nginx 或收款配置。
