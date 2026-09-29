# 公司域名与服务器部署交接

2026-09-28。目标为现有腾讯云上海 `jinhe-cloud`，2 核 / 2GB / 4Mbps；授权服务已部署至回环地址，Cloudflare DNS 与公网 HTTPS 已启用。主域名 `jinhefilm.com`，项目层采用 `tuanbo-link`。本文件不保存服务器口令、SSH 私钥或商户秘密。

## Cloudflare 已配置的记录

已在 `jinhefilm.com` 的 DNS 页面添加以下记录，内容均填写腾讯云控制台这台实例的**公网 IPv4**，不能填写 Tailscale 的 `100.x` 地址。无需给 `tuanbo-link` 建 NS 委派，也不需要通配记录。

| 类型 | 名称 | 内容 | 代理 | TTL | 用途 |
| --- | --- | --- | --- | --- | --- |
| A | `api.tuanbo-link` | 服务器公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 激活、未来支付 |
| A | `updates.tuanbo-link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 安装包与更新清单 |
| A | `tuanbo-link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 团播产品官网，已上线；商品销售关闭 |

先检查是否已有同名 A/AAAA/CNAME，确认后改记录，不能覆盖其他业务。暂不添加 AAAA：有 IPv6 地址不代表公网路由、云防火墙和 Nginx 的 IPv6 链路已验收。如果暂不添加网站记录，也暂不启用反向代理模板的 `tuanbo-link.jinhefilm.com` 站点块。

三条记录已在 Cloudflare 的 Comment 字段填写以下用途，后续修改应保留既有备注；填写备注不代表对应接口已经上线：

| 名称 | Comment |
| --- | --- |
| `api.tuanbo-link` | 团播联动台：机器授权激活、商品订单与支付宝通知 API；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS；管理员接口仅回环或运维隧道访问。 |
| `updates.tuanbo-link` | 团播联动台：Windows x64 更新清单与正式安装包出口；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS。 |
| `tuanbo-link` | 团播联动台：产品官网、演示视频与付费购买入口；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS；可售套餐由授权服务控制。 |

2026-09-29 已在已登录 Cloudflare 页面更新官网与 API 注释，并从保存后的记录重新读取确认；三条 A 记录仍为 `123.206.229.200`、仅 DNS、自动 TTL。更新出口的原注释保留。备注描述用途，是否实际可购买或下载仍以对应服务的部署记录为准。

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

本服务器使用 [Nginx 配置](../apps/licensing-server/deploy/nginx.conf)、[systemd unit](../apps/licensing-server/deploy/tblink-licensing.service)、[环境示例](../apps/licensing-server/deploy/service.env.example)。将本项目配置作为独立站点启用，不覆盖其他站点。[Caddyfile](../apps/licensing-server/deploy/Caddyfile) 仅供以后全新环境使用，不在本机与 Nginx 同时绑定 80/443。线上反向代理已开放健康、激活、指定 UUID 的客户领取与支付宝通知精确路径；服务未完整配置支付宝时通知仍返回 404。不得放开全部 `/v1/*` 或 `/admin/*`。

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
# 预期 200，产品官网已上线；商品销售关闭
curl --fail --max-time 15 -I https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml
# 发布后 200，Cache-Control: no-store；尚未发布为 404
```

对实际版本安装包检查 HEAD 的长度、Range 请求的 206 响应、本地 SHA-512 与 `latest.yml` 相符、Windows Authenticode 发布者和签名状态正确；测试未列入白名单路径返回 404、跨机激活拒绝、并发激活不多占席位、支付未实现路径不存在。必须完成检查→完整下载→停止联动→保存→确认安装→原目录自动重启，全程不停止 OBS/P1。

生产已启用 `LICENSE_PROXY_MODE=loopback`：仅在监听回环地址时启用，只信任来自回环连接的单一有效 `X-Tblink-Client-IP`。Nginx 在六条公开 API 路径覆盖该头为 `$remote_addr`；默认模式忽略所有转发来源头。等价 IPv6/IPv4 映射地址归一计数，拒绝列表、重复值、端口与作用域。下单每客户 10 次/分钟，支付宝通知、客户领取和其余请求各 120 次/分钟；激活仍叠加 Nginx 30 次/分钟、burst 5。

当前 Cloudflare 为仅 DNS，此方案直接使用源站看到的客户连接地址；若以后开启 Cloudflare 代理，必须另行核实可信代理网段和来源配置，不能直接信任外部 `X-Forwarded-For` 或 `CF-Connecting-IP`。隔离测试已证明不同客户独立计数及伪造头不可绕过默认模式，真实并发容量仍需验收。

## 恢复和回退

备份 SQLite 使用在线备份或停服快照，包含一致的 WAL 状态；恢复演练必须连同数据密钥、签名 keyId 及旧公钥验证。单机故障恢复后，旧订单、码、绑定及最大签发租约不能丢失。服务器时钟同步也属于恢复验收。

本次授权服务升级使用版本化脚本 `apps/licensing-server/deploy/activate-release.py`，在公司服务器由 root 执行：

```sh
python3 activate-release.py RELEASE.tar ARCHIVE_SHA256 CURRENT_BUNDLE_SHA256 CURRENT_NGINX_SHA256 CURRENT_ENV_SHA256
```

发布包仅包含 `dist/index.js`、`revision.txt`（源提交完整 SHA）、`nginx.previous.conf`（已核实的旧配置）和 `nginx.next.conf`（本次配置）。先完成类型检查、授权/交付/支付回归及服务构建，生成包摘要；脚本同时核对包、线上旧 bundle、旧 Nginx 和旧环境文件摘要，任何漂移均停止。环境内容不进入发布包或日志。

最终配置限定只改团播 API server 段，更新源站、ACME 与官网段必须逐字保持；七条代理路径均须固定上游、限制请求方法、覆盖来源头。停服前独立检查候选 Nginx 配置。版本切换期间 API 和官网两个主机暂时返回 503，避免官网订单代理绕过维护；更新文件下载保持不变。同时暂停本项目的补交付 timer 和任务，再停止团播授权服务，保留旧代码、旧代理、旧环境与一致 SQLite 备份；用 backup API 恢复到独立副本并核对表数据摘要、完整性和外键。环境只修改代理模式，保留收款开关、未知字段、顺序、注释和文件属主/权限。

新代码启动后核对既有表数据不变、领取/购买/续费/收款表存在，并要求完整商品目录与切换前完全相同，再开放新代理路径。关闭销售或开启销售均按原状态保留，不用部署隐式改价。失败恢复旧代码、环境和代理，并检查旧服务健康；只允许新增表等兼容迁移，不用旧数据库覆盖可能已提交的数据。成功回执包含源 SHA、bundle/代理/环境摘要、代理模式、目录保留与备份恢复验证结果。成功或完成回退后，只恢复原本处于 active 的补交付 timer；人工停用的 timer 不会被启用。此脚本要求既有补交付 systemd 单元已安装，timer 状态异常时在切换前停止。

数据库副本恢复验证不等于整机灾备；私钥和数据密钥未复制到本地或发布包，异地加密备份与丢失主机后的完整恢复仍需另行完成。

更新文件先备份清单再发布；有问题时可以撤回最新清单到上一个可信版本，阻止新用户继续下载，但已经安装新版的机器不会自动降级。应发布更高版本修复或走经确认的人工恢复。不同版本文件不可覆盖；保留旧资产供已经读到旧清单的客户端完成下载。

### 开售后的部署工具与 Git 校验（2026-09-29）

部署工具来源 `b766f7da98fb86a26fa53afd8bff7318239e3245`，已安装到服务器 `/opt/tblink-licensing/activate-release.py`，SHA-256 为 `3315ae49a5667a78011b18a2404f332dbea078ba6c77dd9ade344a38eec98b69`。服务器临时目录内 17 项隔离回归通过后才安装，备份记录位于 `/var/lib/tblink-licensing/backups/deploy-tool-20260929T043110Z-3861bf84`。本地部署／运维套件 54 项通过；旧实现对开售环境保留和双域名维护用例失败。仅更新运维工具，授权 bundle、Nginx、环境文件与产品 RELEASE 的摘要前后不变；团播、分镜、无忧排班、Nginx 及补交付 timer 均保持 active。尚未用这版工具进行真实生产版本切换，因此隔离回退测试不代表生产回退演练完成。

[Verify Licensing Server](../.github/workflows/verify-licensing-server.yml) 在服务、共享契约及构建配置变更的 master 推送和 PR 上执行类型检查、授权／支付测试、服务与网站构建，以及 Python 部署／回退／补交付集成测试。CI 使用与生产记录一致的 Node 22.22.1，权限只读，不接触商户密钥、不连接生产服务器。GitHub 自动验证与服务器自动部署分别管理；当前仍按上述摘要校验流程显式发布，尚未建立 GitHub 到腾讯云的自动部署凭据和触发器。

## 初次部署记录（以下旧摘要由后续升级取代）

- 已通过用户授权的 ubuntu 密码登录，原有 Nginx、金河分镜和无忧排班保持 active，未修改其配置。
- 已从 Ubuntu 官方签名仓库安装 Node 22.22.1。服务器 `/tmp` 内存盘满，安装使用 `TMPDIR=/var/tmp`，未删除现有文件，未关闭软件包签名校验。此存量问题仍需后续单独排查。
- `tblink-licensing.service` 已启用并运行；`127.0.0.1:8787/health` 为 200，未认证后台请求为 401，只绑定回环地址。服务账号 `tblink-license`。
- 生产 Ed25519 私钥、数据密钥和后台令牌仅在服务器生成，密钥目录 0700、文件 0600。公钥已编入客户端。尚无生产订单、发码、支付或开票；异地加密备份/恢复演练待完成。
- 本地与远端服务 JS 的 SHA-256 一致：`f0b70d0590326bfff04ed6dc553eb60fe99878e54a3f865dfa02695400bac63a`。
- 独立站点 `/etc/nginx/sites-available/tblink-licensing.conf` 已链接至 sites-enabled，先通过 HTTP webroot 申请证书，再加载完整 HTTPS 配置。`nginx -t` 通过，既有两个业务服务保持 active，金河分镜公网返回 200。旧站点的 http2 弃用提示及共享 443 的 protocol options 提示仍存在；未修改旧站点。
- 三个新域名 DNS 已配置，Let’s Encrypt 证书覆盖三个 SAN，有效期至 2026-12-26（UTC）；使用服务器现有 ACME 账户，无新增付费证书。`certbot.timer` 已启用，项目专用 reload hook 已安装并执行成功。限定本证书的 `certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew` 演练通过，部署钩子执行完成。
- 公网普通 HTTPS 请求：健康检查 200；空激活请求 400 `INVALID_REQUEST`；后台路径 404；未实现的支付宝通知路径 404；更新清单 404 且带 `Cache-Control: no-store`；更新目录与预留网站 404。尚未上传正式 Windows 安装包，尚未完成真实机器的生产激活和自动更新验收。
- 后台令牌、私钥及登录密码未下载到本地或写入仓库。回环健康通过不等于公众可激活、收款或自动开票。

## 支付宝回调启用前置

服务代码和 Nginx 已增加精确路径 `/v1/payments/alipay/notify`。应用身份与官方验签公钥已于 2026-09-28 配置，生产只读查单响应验签通过，详见文末记录；这不替代真实小额付款与交付验收。回调验签启用不等于商品可售，销售仍由独立的 `ALIPAY_CHECKOUT_ENABLED` 与商品目录控制。

## 客户领取接口部署记录（2026-09-28）

- 部署源提交：`374ea715b3ff4c1a73ca77413f71ca494a1de981`，为本地已提交版本；本仓尚未推送，不能称为已通过 GitHub CI 或自动部署。
- 新 bundle SHA-256：`734893485d99f1842bfabe39d31a12f6f9c4e70641129f1f5517664396bf73b4`。服务端 `/opt/tblink-licensing/RELEASE` 记录源提交。
- 部署前备份目录：`/var/lib/tblink-licensing/backups/20260928T012230Z`，仅服务器受限访问。旧代码、旧代理、SQLite 备份、独立恢复副本和不含秘密的 manifest 保留在此。
- 在停止团播写入期间使用 SQLite backup API 备份和恢复，核对每张既有表的行数与数据摘要，并检查完整性和外键；新版启动后再次确认既有数据未改变，追加 `order_delivery_access` 表。未下载生产数据库或密钥。
- Nginx 原配置只插入 GET `/v1/orders/<UUID>` 和支付宝通知精确路径，其他内容保留；新配置 SHA-256 为 `d41f83d3a97ea066919b4f596ba9888021c5f445940227adc58f057a2ad8eedd`。`nginx -t` 通过后重载。
- 团播、金河分镜、无忧排班和 Nginx 服务均 active，团播回环健康检查正常。公网健康 200、无凭据领取 401 `INVALID_DELIVERY_ACCESS` 且带 `no-store` / `no-referrer`、管理员路径 404、未配置支付宝通知 404；分镜健康接口仍为 200。更新清单和预留网站仍为 404，未发布安装包。此处部署证明不替代真实发码、支付或 Windows 实机验收。
- 客户凭据仅通过 Authorization 提交，代理不开放 `/admin/*`；既有订单不会自动获得领取权限。仅有订单编号无法领码，领码页和公开商品下单仍待实现。
- 本地授权、支付通知、交付、客户端授权及更新管理六个文件共 48 项专项测试通过；授权服务类型检查、构建通过。部署脚本的副本恢复与原子替换辅助逻辑也用隔离文件验证。

本次升级不改变收费开关、不创建生产订单，不上传 Windows 安装包。异地加密备份、完整灾备和客户购买链路仍需继续完成。

## 后续授权服务升级

按上节的四成员发布包、包路径及四项摘要参数执行。已上线配置必须等于经核实的旧配置或候选配置；部分修改、路径变化或其他站点段变化均停止。每次绑定完整 Git SHA，只支持兼容迁移，涉及删除字段或改数据格式需另做迁移与恢复方案。

脚本回归：`PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning -m unittest discover -s apps/licensing-server/deploy -p 'test_*.py'`。10 项隔离测试覆盖配置漂移、代理限制、环境保留、成功部署、目录意外开放和最终 Nginx 校验失败的回退。SQLite 使用实际临时数据库；systemd/Nginx 为模拟边界，不能代替源站验证。

## 付款链接与主动查单部署记录（2026-09-28）

- 源提交 `8b428e24caee7d3495405f7824f2d208af441d11`；含 `daba30d` 付款链接、`e298563` 主动查单及重复升级脚本，均为本地提交，未 push 或触发 GitHub CI。
- bundle SHA-256：`def20e1d9b153c6142ced1f97daa3a71520b2714e38e021bc7b59564cf237c4e`，`RELEASE` 与上述源提交一致。备份位于 `/var/lib/tblink-licensing/backups/20260928T014836Z`；数据库副本恢复与既有表数据摘要核对通过，新增付款绑定表。
- 回执 `proxyChanged: false`；Nginx 摘要保持 `d41f83d3a97ea066919b4f596ba9888021c5f445940227adc58f057a2ad8eedd`，未改代理或重载 Nginx。团播、分镜、无忧排班、Nginx 均 active。
- 服务端检查确认 `ALIPAY_CHECKOUT_ENABLED` 为 false、未配置支付宝应用身份；使用服务器内部管理员凭据请求虚构订单的 `/payment-link` 和 `/reconcile` 均返回 503 `PAYMENTS_UNAVAILABLE`。后台令牌仅在服务器进程内使用，未输出或下载到本地；未创建订单或请求支付渠道。
- 公网验证：健康 200、无凭据领取 401，管理员和查单路径 404，未配置支付通知 404；更新清单仍 404，分镜健康 200。账户产品已开通，但服务应用/密钥、正式价格和受控真实交易尚未验收。
- 本地查单专项 14 项、既有授权/支付/交付 30 项分批通过，授权服务类型检查、相关 ESLint、bundle 构建通过；部署路由回归 4 项通过。未进行 Windows 安装、签名或真实更新验收。

## 商品目录与自助下单

新增可选 `LICENSE_CATALOG_FILE` 和 `purchase_requests` 表，契约见 [COMMERCIAL_API.md](COMMERCIAL_API.md)。没有商品文件或未启用支付宝收款时不创建新单；不要将测试商品、金额或期限复制到生产。正式目录需先确认含税价格、使用/升级天数、单笔金额与机器数限制、截止时间，并给价格/条款变更分配新版本号。

服务与公网代理已部署，源提交为下节 `e032891`，开放 `GET /v1/catalog` 和 `POST /v1/orders`，但商品与商户配置仍关闭。客户端购买与本机安全保存/恢复凭据已接入源码，尚未发布安装包。可信来源限流已通过本地隔离测试和公网伪造来源头测试；真实容量与商业开放仍需验收。此次未修改 Cloudflare。

桌面读取关闭的商品目录会明确显示服务未开放，不生成本地商品替代。部署顺序为：备份恢复核对 → 授权服务与受控代理路由 → 不配置商品时的关闭验证 → 确认商品和商户配置 → Windows 桌面预发布验收 → 受控真实交易 → 正式开放。新增共享购买契约须随服务端 bundle 和桌面 preload 一起更新；开发时必须完全退出旧 Electron 实例并重新启动，不能只热更新 renderer。


## 商品接口与代理来源部署记录（2026-09-28）

- 源提交 `e032891a10d1f41124e850a83a238e5ea40def45`，本地已提交，未 push 或触发 GitHub CI。线上 `RELEASE` 一致；bundle SHA-256 为 `65beb96bc12968684039b41c27e25f0b6a6e2615f0742eaba6a3d4554b683605`。
- Nginx 配置 SHA-256 为 `33985f5de5a928d4ef3b25008292f0f145e1ab991c99b1477e1f448a923b6058`。新增目录和下单路径，六条 API 代理均覆盖客户来源头；只改 API server 段，更新/ACME/预留网站段保持原样。候选与完整 `nginx -t` 通过，维护阶段及完成后各 reload 一次。
- 备份目录 `/var/lib/tblink-licensing/backups/20260928T030128Z`，保留旧代码、代理、环境、SQLite 备份与独立恢复副本。备份恢复、既有表数据摘要及外键检查通过；新增 `purchase_requests`。环境文件仍为 0600，仅追加 `LICENSE_PROXY_MODE=loopback`，监听仍为 `127.0.0.1`。
- 公网关闭状态验证：目录 200 且 `available:false,offers:[]`；合法形状的虚构商品购买请求返回 503 `PAYMENTS_UNAVAILABLE`；无凭据领取 401，后台及主动查单路径 404，未配置支付宝通知 404。目录 POST、下单 GET 均返回 403。探测后再次核对所有既有表数据未变化，购买记录为 0，未请求支付渠道。
- 公网伪造 `X-Tblink-Client-IP` 和 `X-Forwarded-For` 不改变来源：同源连续第 11 次下单请求返回 429，不能通过每次更换头绕过；无效伪造来源头的健康请求仍返回 200，证明 Nginx 覆盖该头。不同真实客户独立计数已用本地 HTTP 边界测试验证，尚非多地区公网容量测试。
- 团播、分镜、无忧排班和 Nginx 均 active；分镜公网 `/api/health` 返回 200。更新清单仍为 404 且 `no-store`，预留网站仍为 404。尚未上传 Windows 安装包。
- 本轮授权服务六个测试文件与桌面购买适配器合计 71 项通过；Python 部署回归 10 项通过，ResourceWarning 作为错误时无失败。授权服务类型检查、变更 TS 的 ESLint 与服务 bundle 已通过。上述均不替代 Windows 安装/更新、正式商品、实商户交易、退款或开票验收。

## 2026-09-28 支付宝身份与回调验签接入

- 用户在官方开放平台完成 AppID `2021007101657826` 的 RSA2 公钥登记；应用公钥与服务器私钥导出的 SPKI 指纹一致。官方页面返回的支付宝公钥已归档，见 [公钥及指纹](../apps/licensing-server/deploy/public-keys/README.md)。服务器私钥始终未导出。
- 使用服务器私钥向固定生产网关 `https://openapi.alipay.com/gateway.do` 发起一次随机不存在订单的 `alipay.trade.query`。HTTP 200，业务码 `40004 / ACQ.TRADE_NOT_EXIST`，原始响应正文 RSA2 验签通过。此操作只核实接口认证，不创建交易或授权。
- 配置变更前备份至 `/var/lib/tblink-licensing/backups/20260928T093701Z-alipay-config`；包含原 `service.env` 与 SQLite 在线备份，备份完整性、外键检查和逻辑数据摘要核对通过。
- 在既有 `service.env` 追加应用、收款方、官方验签公钥和私钥路径，保留其他字段及注释。支付宝公钥文件 `/etc/tblink-licensing/alipay-public.pem` 归服务用户所有、权限 0600。配置文件 SHA-256 为 `7fe2f3df138e69beb0cdbf9b39b99155c705807ceffedf95e9181e8b61321ee6`；本次未改服务 bundle、Nginx 或 Cloudflare。
- 重启团播服务后健康正常，数据库逻辑摘要未变化；团播、金河分镜、无忧排班与 Nginx 均 active。销售仍为 `ALIPAY_CHECKOUT_ENABLED=false`，未配置 `LICENSE_CATALOG_FILE`，目录不展示商品。
- 公网实测：团播健康 200；目录 200 且 `available:false,offers:[]`；后台路径 404；空通知 400 `INVALID_REQUEST`，完整形状的伪造签名通知 401 `INVALID_PAYMENT_SIGNATURE`；分镜健康 200。未创建真实订单或请求付款。
- 本次部署时月付／年付价格仍为讨论稿；2026-09-29 后续定价见 [首发销售方案](COMMERCIAL_ONBOARDING.md#首发销售方案价格已更新未开售)。网站经营内容补件、真实支付、发码及机器激活、退款、发票和 Windows 更新验收均未完成。

## 2026-09-28 原机器订阅续费部署

- 源码提交 `4c064d58663fc89cf5c50bab4d42f0fbf78c77ac`，服务 bundle SHA-256 `bb13e5886255ce42a7213fb0897068c0a4fe9c41a2c84feeaa3c9f202d6b7413`；独立 SSH 检查确认线上 `RELEASE` 与 bundle 均匹配。
- 新增 `license_renewals` 表及授权索引，原订单和激活码不迁移、不重写。备份路径 `/var/lib/tblink-licensing/backups/20260928T095908Z`，独立恢复校验和既有表逻辑摘要核对通过。部署脚本要求续费表存在，否则恢复旧代码、环境及代理。
- Nginx 与支付宝环境配置哈希保持上节值，未修改 Cloudflare。部署时临时维护 API，完成后恢复既有代理；团播、分镜、无忧排班及 Nginx 均 active，`nginx -t` 通过。授权服务仍只监听 `127.0.0.1:8787`。
- 公网健康 200；目录返回 `available:false,offers:[]`；合法形状的虚构续费购买返回 503 `PAYMENTS_UNAVAILABLE`；后台路径 404；空支付宝通知 400；分镜健康 200。检查后服务器购买与续费行数均为 0，既有表数据未变化，未创建真实交易或授权。
- 本地授权服务与桌面购买／授权／安全存储回归共 97 项通过；部署及回滚 Python 回归 11 项通过。严格 TypeScript、变更文件 ESLint、服务端 bundle 与 Electron Vite main/preload/renderer 构建通过。回归曾发现未续费授权的日期格式被重写，已修复并重新验证。
- 本地 Chrome 使用模拟 IPC 数据走通到期订阅、单机续费、查询交付和联网验证更新期限，检查客户名称及机器数量不可改、仅显示订阅商品、已交付续费不显示新码。界面测试不连接支付宝；实际服务端适配器另以本地 HTTP 与测试签名通知验证，不替代真实支付。
- 桌面续费入口尚未发布 Windows 安装包，也未完成 Windows safeStorage、真实商户续费、退款或开票验收。完整 Windows 原生构建／安装验收仍须在 Windows PowerShell 执行；本轮 macOS Electron Vite 构建不能代替它。正式价格、每份套餐机器数与网站提额材料仍待确定。

## 2026-09-28 团播官网上线

官网 `https://tuanbo-link.jinhefilm.com/` 已从 404 预留站点切换为静态产品网站，来源 `886fef87cde2844b885d999ed022b347e82b70e0`。公开页面/JS/CSS 摘要与构建一致，购买目录关闭，下单返回 503，管理员及内部文件路径保持 404。授权 bundle、支付环境配置及其他站点未修改。发布备份 `/var/lib/tblink-licensing/backups/20260928T130630Z-website`。详细验证、首次回滚和修复记录见 [官网发布结果](PURCHASE_WEBSITE.md)。

已在 Cloudflare 将 `tuanbo-link.jinhefilm.com` 的备注更新为“团播联动台：产品官网、操作演示与授权购买入口；官网已上线，当前销售关闭；源站 jinhe-cloud（腾讯云上海）；仅 DNS”，保存后重新展开记录核对。A 记录仍为 `123.206.229.200`、仅 DNS、自动 TTL；没有修改解析值或其他记录。

## 2026-09-28 客户查单补交付上线

- 授权服务与官网均升级至来源 `a3809183dd65165273730fa5d9ef680d14588d15`，新增客户持原领取凭据主动查单的 POST 路由。授权 bundle SHA-256：`f26c32332c6065fee19653066909d71ba0ce53964e1a138be3dacc28f053ade5`；官网 purchase.js：`b0a54c5adaafac3f30b1d72ee0cc5d997e39af4f2448ce103580b5b22ec96e64`。
- API 发布备份：`/var/lib/tblink-licensing/backups/20260928T132409Z`；官网备份：`/var/lib/tblink-licensing/backups/20260928T132412Z-website`。数据库完整性、副本恢复及原表内容一致性验证通过。环境文件摘要未变，销售开关仍关闭。
- 官网目录：`/srv/tblink-purchase-releases/a3809183dd65165273730fa5d9ef680d14588d15-2b1108d1`；最终 Nginx 摘要：`3837b02c31464a4fe46e253d771e18e2bbecf16d28538ce6e0e3a06295b03d99`。先只升级 API block，再只升级官网 block，其他站点配置保留。
- 公网官网与 JS 为 200，JS 摘要与构建一致；官网和 API 域名的客户查单路由对无凭据请求均返回 401 INVALID_DELIVERY_ACCESS，管理员路径均为 404。目录 available=false、offers=[]；授权 API 与金河分镜健康接口为 200。四项既有服务均 active。
- 九个服务/网页/桌面购买测试文件共 92 项通过，部署工具回归 18 项通过；随后为请求体读取期间凭据变化增加再次校验，相关查单 19 项重新通过。服务与桌面类型检查、变更文件 ESLint、服务与网页构建通过。
- 浏览器在隔离本地服务验证“通知缺失 → 持原凭据点击查询 → 测试 RSA2 签名查单 → 原单发码”，重复点击原码与期限不变，测试渠道调用一次。未连接实际支付，不替代实商户付款/退款/开票验收；桌面代码尚未发布 Windows 安装包。

官网随后独立发布付款完成提示修正 `aa34ff0e4ca4177fb0ea15365f971679acce96e6`，备份 `/var/lib/tblink-licensing/backups/20260928T132717Z-website`。最终 purchase.js SHA-256：`1ac218f9957a468f6c0c44b5815d5a21546f6393209b96967969337f15daf7e9`，公网摘要已核对。授权 bundle、Nginx 和环境摘要不变，销售保持关闭。


## 2026-09-28 收款持久化与交付异常上线

- 授权服务与官网来源均为 `c17fd6124f6219b8d0cef7e9eba4ec33ca6b4bf4`。bundle SHA-256：`1145f4f1a5cc5f76ac1e0593aae540e4faee318693797a4385504d771a04ecea`；网页 purchase.js：`31e624bfd34b92cdef445a2364315edf0625faa9178c368c5834b1cf0be48f65`。公网 HTML、JS、CSS 均为 200，逐文件摘要与构建包一致；正式浏览器仍显示“暂未开放购买”。
- API 备份 `/var/lib/tblink-licensing/backups/20260928T135007Z`，官网备份 `/var/lib/tblink-licensing/backups/20260928T135011Z-website`；静态目录 `/srv/tblink-purchase-releases/c17fd6124f6219b8d0cef7e9eba4ec33ca6b4bf4-1ab35fb5`。SQLite 备份、副本恢复和既有表逻辑摘要核对通过，只新增 `payment_receipts`。发布工具现在检查收款表存在，否则恢复旧代码、环境及代理；相关缺表回归通过。
- 部署后独立 SSH 检查：RELEASE 一致、既有表未改变，订单 0 条、收款记录 0 条。没有为验收创建生产交易或授权。
- 运维命令已安装到 `/opt/tblink-licensing/payment-exceptions.py`，root 所有、0644，SHA-256 `f1f35e7a6a274d59749ee1566599c52bab7653d4c2fe35fcd82862263343f707`。服务器内部实际执行只读清单，返回 0 条且 nextCursor=null；未执行生产补发。源码、访问范围与操作说明见 [接口文档](COMMERCIAL_API.md#收款记录与交付异常)。
- Nginx 摘要仍为 `3837b02c31464a4fe46e253d771e18e2bbecf16d28538ce6e0e3a06295b03d99`；支付环境摘要仍为 `7fe2f3df138e69beb0cdbf9b39b99155c705807ceffedf95e9181e8b61321ee6`。没有修改 Cloudflare 或新增公网管理路由，销售开关保持关闭，正式商品目录仍未配置。
- 官网和 API 的 `/admin/payment-exceptions` 均为 404；无领取凭据的客户 POST 查单均为 401；两域名目录均 available=false、offers=[]。团播 API、分镜健康均为 200，团播、Nginx、分镜、无忧排班四项服务均 active，nginx -t 通过。
- 本地服务、网页客户端与桌面购买适配器共 97 项测试分批通过；Python 部署／回退／运维命令 22 项通过。服务和桌面类型检查、变更文件 ESLint、服务与网页构建通过。桌面新增测试初次因测试客户名称与原授权不一致被正确拒绝，修正测试资料后又校正关闭付款入口的预期提示，最终 17 项桌面购买测试通过。
- 浏览器官网故障测试使用本地 SQLite 发码失败注入与测试 RSA2 查单响应，页面显示已收款待处理并移除付款链接；桌面组件使用模拟 IPC 记录验证同状态文案和禁用付款按钮，主进程另以真实本地 HTTP 边界验证。均不连接真实支付渠道。
- 本轮只完成收款事实保留和显式补交付，不包含渠道退款、自动开票或后台定时重试。没有 Windows 原生安装包、真实支付／退款／开票验收；正式价格、真实演示视频和商户网站补件仍待完成。源提交已在本地保存，未 push 或触发 GitHub CI。

## 内部收款台账命令部署（2026-09-28）

- 本地源提交 `23f6accf6c83c69dce9822838a82c69eae9eace3`。安装 `/opt/tblink-licensing/export-payment-ledger.py`，root 所有、0644，SHA-256 `0205f10175d2631756331778ed67bdddb0251846706a8cb9b2c5d3055d4e6678`。调用方法、字段和范围见 [内部收款台账导出](COMMERCIAL_API.md#内部收款台账导出)。
- 在服务器实际导出上海日期 `[2026-09-01, 2026-10-01)`，完成目录 `/var/lib/tblink-licensing/payment-ledger-check-20260928T141354Z-acc86814`，目录 0700，JSONL、CSV 和汇总文件均 0600。生产订单 0、收款记录 0、缺少收款记录的历史已交付订单 0；这是空台账的部署验收，不是真实资金对账。
- API 源版本仍为 `c17fd6124f6219b8d0cef7e9eba4ec33ca6b4bf4`。安装前后 API bundle、RELEASE、服务环境文件、Nginx 配置及 SQLite 主数据库文件共五项摘要未变；没有重启服务、修改销售配置或开通新路由。团播、Nginx、金河分镜与无忧排班服务检查均 active。
- Python 部署／运维套件共 30 项通过，其中新增 8 项覆盖真实服务表结构、上海日期边界、整数金额、并发收款快照、敏感字段排除、CSV 公式及长数字保护、权限与拒绝覆盖、无效数据和限时失败。非空数据在隔离数据库验证，未向生产写入测试订单。
- 未 push GitHub。渠道账单下载、银行结算匹配、退款、自动开票和真实交易验收仍待完成；此命令不替代这些流程。

## 2026-09-29 实际发布与开售结果

- 产品来源：`3dcf91cafc56dcebf368160da2961648c330fdbe`，标签 `v0.4.29`；[正式 Release](https://github.com/JinHe9527/tuanbo-link-console/releases/tag/v0.4.29)。私有仓库无需公开，客户从公司更新域名下载安装包。
- [Windows 构建](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36461288338) 完成校验与直接草稿归档；下载后逐项验证 manifest、三个分发文件 SHA-256、清单版本／大小／SHA-512，再发布正式 Release。
- Manifest SHA-256：`ad37f80fde39ee760a2671214d799d58ec227ce768989983e6c57b2adb5811a9`。安装器保持未签名，未伪造 Authenticode 状态。
- 更新发布备份：`/var/lib/tblink-licensing/backups/20260928T181937Z-e217bc22-update-0.4.29`；公网清单与 blockmap 摘要一致，安装包 HEAD 大小一致、Range 返回 206 且片段一致。
- 官网来源 `3dcf91cafc56dcebf368160da2961648c330fdbe`，增加 Windows 0.4.29 下载入口；商品与金额从生产目录读取。
- 开售备份：`/var/lib/tblink-licensing/backups/20260928T182029Z-open-sales-bc3ae9fd`；目录 SHA-256：`07fd7553d5a5f11184eafb9f92282f10f06f026a01e1c879980d6adb02d14c6d`；启用后环境文件 SHA-256：`11a2c78ad6cd9ea54cfe1ed4c3bc47d047dcbc30f9cc146449435bf08f3437a5`。仅改变团播收款和目录设置。
- 公网未付款验证订单：`0f0a3434-f6ae-4925-99c8-99c7ad32468a`，800 元；同凭据重复创建返回同一订单，领取状态 pending、激活码数量 0；公司 app、支付方法及回调地址匹配，没有实际扣款。该凭据仅保留在本机受限文件，未入库文档。
- 自动开票、微信、真实支付／回调／激活／续费和 Windows 安装更新仍未验收。后续应按真实平台流水核对，不用伪造回调或手动改已付状态替代。
- 最终服务器复核：授权 bundle 与 Nginx 摘要保持不变，授权服务、Nginx、金河分镜、无忧排班均 active。官网 HTML／JS／CSS 的公网摘要与发布包一致，授权 health 为 200；官网与 API 的管理员路径及配置文件探测均为 404。
- 官网浏览器已验证 0.4.29 下载链接、月付 800 元／30 天与年付 8,000 元／365 天选项及对应合计；未勾选购买协议或执行浏览器付款。官网备份为 `/var/lib/tblink-licensing/backups/20260928T182005Z-website`。
- 本地上线脚本回归 38 项通过；最终 Windows 构建为 149 个测试文件、1,039 项通过，40 项跳过。Actionlint 与工作流 YAML 检查通过。

## 2026-09-29 已确认付款的交付恢复任务

- 运维来源 `2c83fe91fa7eb0fbcae02092ea81731b337e4974`，已推送 GitHub。只更新 `/opt/tblink-licensing/payment-exceptions.py` 并安装 systemd service/timer；授权服务 bundle 来源仍为 `c17fd6124f6219b8d0cef7e9eba4ec33ca6b4bf4`，桌面正式版本仍为 0.4.29，不改写它们的 RELEASE 记录。
- 备份及安装回执：`/var/lib/tblink-licensing/backups/20260928T193152Z-delivery-recovery-2c83fe9`。脚本 SHA256 `9bec4ec5782bc641f00b5e95e8353b90f052a880ccbfa46501a489dde78a8ebc`；service 为 `2ade8c3955ee4a2d21b142534f5c6e29a71889ec81a7535a2894618dc147c562`；timer 为 `0214639c75561480b94d8e4a3a481634d2bf6a5d8ef0a951004898f53195a674`。三项文件均 root 所有、0644。
- 安装前 `systemd-analyze verify` 通过。先手动执行一次成功，再启用 timer；独立 SSH 复核自动调度从北京时间 03:31:54 到 03:32:54 再次执行，InvocationID 改变，`Result=success`、`ExecMainStatus=0`，timer `enabled/active` 且已安排后续执行。
- 任务使用 `tblink-license` 身份，读取服务器内部管理员令牌，只访问回环接口；独立恢复状态库权限 0600。每批最多 5 单、每单最多 5 次，持久化退避，业务异常转人工。授权服务停机时不会由任务自动拉起。完整行为见 [接口文档](COMMERCIAL_API.md#收款记录与交付异常)。
- 本地 Python 部署／运维套件 49 项通过，其中恢复任务单测 13 项。真实本地 Node 服务与 SQLite 故障注入覆盖：测试签名回调核款成功但发码事务失败 → 收款事实保留 → 故障解除后定时逻辑补发一次 → 重复执行不再发码；同库未付款订单保持 pending。测试使用隔离密钥和本机服务，未连接真实支付宝。
- 生产每次任务均扫描 0、尝试 0、交付 0；数据库仍为 1 笔未付款测试订单、0 个授权、0 笔已付款待交付，完整性检查为 ok。没有用生产伪造付款检验任务。
- API bundle、支付环境文件和 Nginx 配置的 SHA256 与开售时一致；团播、Nginx、金河分镜、无忧排班四项服务均 active，无需重启它们。
- 该任务只恢复已保存可信收款事实的本地交付；未收到渠道通知的订单仍需渠道通知或主动查单。真实付款／激活／续费、微信、退款和自动开票仍未验收。Windows 授权拦截、正式安装器生命周期与真实更新下载器已通过专项 CI，但实际两版本安装更新重启仍待验收，见 [授权与更新验收](LICENSE_UPDATE_ACCEPTANCE.md)。
- 回退时仅停止并禁用 `tblink-delivery-recovery.timer`，等待当前 oneshot 结束，再从上述备份恢复旧脚本；保留恢复状态和审计记录。不得清空业务库、撤销已有授权或为重新尝试而直接清零次数。
