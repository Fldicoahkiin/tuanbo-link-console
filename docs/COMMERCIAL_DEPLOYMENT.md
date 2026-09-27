# 公司域名与服务器部署交接

2026-09-28。目标为现有腾讯云上海 `jinhe-cloud`，2 核 / 2GB / 4Mbps；配置尚未部署。主域名 `jinhefilm.com`，项目层采用 `link`。本文件不保存服务器口令、SSH 私钥或商户秘密。

## Cloudflare 要添加的记录

在 `jinhefilm.com` 的 DNS 页面添加以下记录，内容均填写腾讯云控制台这台实例的**公网 IPv4**，不能填写 Tailscale 的 `100.x` 地址。无需给 `link` 建 NS 委派，也不需要通配记录。

| 类型 | 名称 | 内容 | 代理 | TTL | 用途 |
| --- | --- | --- | --- | --- | --- |
| A | `api.link` | 服务器公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 激活、未来支付 |
| A | `updates.link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 安装包与更新清单 |
| A | `link` | 同一公网 IPv4 | DNS only / 仅 DNS / 灰云 | Auto | 网站预留，当前返回 404 |

先检查是否已有同名 A/AAAA/CNAME，确认后改记录，不能覆盖其他业务。暂不添加 AAAA：有 IPv6 地址不代表公网路由、云防火墙和 Caddy 的 IPv6 链路已验收。如果暂不添加网站记录，也暂不启用 Caddy 模板的 `link.jinhefilm.com` 站点块。

Cloudflare 全区接入下，普通 Universal SSL 通常仅覆盖根域和一级子域，`api.link.jinhefilm.com`、`updates.link.jinhefilm.com` 不在该范围内。初期使用仅 DNS，让 Caddy 申请和续期覆盖实际主机名的公网证书。以后启用代理，需要先配置确实覆盖这些主机名的边缘证书（例如适用的 Advanced Certificate / Total TLS 或自定义证书），并使用 Full (strict) 校验源站证书。不能把 Flexible 当作替代。

仅 DNS 不经过 Cloudflare HTTP 代理，因此没有 Cloudflare WAF/CDN 的访问保护与带宽卸载，下载流量全部由腾讯云承担。4Mbps 理论上限约 0.5MB/s，200MB 完整包单用户约需 7 分钟，多人会共享带宽，实际更慢。先保持同服务器出口；流量增长时可在保留域名的前提下迁移对象存储/CDN，仍需校验更新包。

依据：[DNS 记录操作](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/)、[Universal SSL 覆盖限制](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)、[Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/)。

## 服务器布局与端口

```text
公网 80/443 → Caddy
  api.link.jinhefilm.com/health       → 127.0.0.1:8787
  api.link.jinhefilm.com/v1/activate  → 127.0.0.1:8787
  api.link.jinhefilm.com/admin/*     → 404（不转发）
  updates.link.jinhefilm.com/windows/x64/latest.yml → 静态更新清单
  updates.link.jinhefilm.com/windows/x64/Tuanbo-Link-Console-X.Y.Z-x64.exe
  link.jinhefilm.com/*               → 404（网站尚未建设）

/opt/tblink-licensing/               服务代码和运行依赖
/etc/tblink-licensing/               仅服务账号可读的密钥、环境文件
/var/lib/tblink-licensing/           SQLite、WAL 和审计数据
/srv/tblink-updates/windows/x64/    仅已验收的正式公开文件
```

使用 [Caddyfile](../apps/licensing-server/deploy/Caddyfile)、[systemd unit](../apps/licensing-server/deploy/tblink-licensing.service)、[环境示例](../apps/licensing-server/deploy/service.env.example)。把站点块合并入已有 Caddy 配置，不覆盖其他站点。反向代理只开放两个现有路径，支付接口尚未实现，不能通过放开全部 `/v1/*` 或 `/admin/*` 提前代替开发。

腾讯云防火墙与系统防火墙允许公网 TCP 80/443，用于 HTTPS 和证书校验；8787、数据库和管理员 API 不开放公网。运维通过现有 Tailscale 和 SSH，服务器用户名待确认。域名仅 DNS 的 HTTPS 请求来自用户公网网络，普通客户不需要加入 Tailscale。

部署前还需核实该主域名在腾讯云大陆实例上的备案/接入状态和实际业务材料要求。“暂时没有网页”不能直接推断 API、下载服务免备案。支付商户审核可能要求可访问的产品介绍、服务条款与售后联系方式；当前 404 占位不等同满足进件材料。

## 部署顺序

1. 核实 SSH 用户名、备份、磁盘余量和已有服务。读取服务状态前也不应把用户口令放到脚本或仓库。实例内存有限，在本地或 CI 构建，生产只运行服务和 Caddy。
2. 安装支持 `node:sqlite` 的 Node 22.16+ LTS，建立 `tblink-license` 用户及上述目录。服务构建命令 `pnpm --filter @tb/licensing-server build`。构建产物仍依赖锁定版本的 `zod`，按锁文件部署完整运行依赖；不要仅上传一个 JS。
3. 离线生成生产 Ed25519 签名密钥、独立随机 32 字节数据密钥、至少 32 字符随机后台令牌。按环境示例使用受限文件注入。私钥和数据密钥必须加密离线备份。客户端只编入公钥，绝不分发私钥或后台令牌。
4. 核对 systemd 中 Node 路径，启动服务，确认回环 `/health`。数据库目录权限 0700、密钥文件权限 0600。运营通过 SSH 本地转发访问回环地址，仍须 Bearer 认证；后台响应含激活码，不保存原始终端输出。
5. 在 Cloudflare 添加上述 DNS；核实 DNS 和 CAA 不阻止证书签发。执行 `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`，成功后 reload；确认三张主机名证书与自动续期。官方说明：[Caddy 静态服务](https://caddyserver.com/docs/caddyfile/directives/file_server)。本仓库未在目标机验证此模板。
6. 创建更新静态目录，Caddy 用户只读，发布用户可写。按[更新发布步骤](SOFTWARE_UPDATES.md)上传，目录中不放数据库、备份、密钥、内部构建清单或诊断日志。
7. 完成以下探测和 Windows 实机流程，再开放商业销售。生产域名已编入客户端；这表示配置完成，不表示域名解析、服务器或商户已上线。

## 验收探测

```sh
curl --fail --max-time 15 https://api.link.jinhefilm.com/health
# 预期 200 JSON {"status":"ok"}
curl --max-time 15 -o /dev/null -w '%{http_code}\n' https://api.link.jinhefilm.com/admin/orders
# 预期 404；不得出现订单或认证业务响应
curl --max-time 15 -o /dev/null -w '%{http_code}\n' https://link.jinhefilm.com/
# 预期 404，当前没有网页
curl --fail --max-time 15 -I https://updates.link.jinhefilm.com/windows/x64/latest.yml
# 发布后 200，Cache-Control: no-store；尚未发布为 404
```

对实际版本安装包检查 HEAD 的长度、Range 请求的 206 响应、本地 SHA-512 与 `latest.yml` 相符、Windows Authenticode 发布者和签名状态正确；测试未列入白名单路径返回 404、跨机激活拒绝、并发激活不多占席位、支付未实现路径不存在。必须完成检查→完整下载→停止联动→保存→确认安装→原目录自动重启，全程不停止 OBS/P1。

当前授权进程限流为每 socket IP 120 次/分钟；Caddy 回环代理会共享该限额，这是当前上线容量限制。需在上线前实现可信代理来源和独立业务限流、压测后调整，不能盲信外部 `X-Forwarded-For`，也不能直接放大到无限制。购买回调将来应有独立限流预算，避免激活流量挤占核款。

## 恢复和回退

备份 SQLite 使用在线备份或停服快照，包含一致的 WAL 状态；恢复演练必须连同数据密钥、签名 keyId 及旧公钥验证。单机故障恢复后，旧订单、码、绑定及最大签发租约不能丢失。服务器时钟同步也属于恢复验收。

更新文件先备份清单再发布；有问题时可以撤回最新清单到上一个可信版本，阻止新用户继续下载，但已经安装新版的机器不会自动降级。应发布更高版本修复或走经确认的人工恢复。不同版本文件不可覆盖；保留旧资产供已经读到旧清单的客户端完成下载。

本轮没有 SSH、DNS、证书、线上部署、生产发码或支付渠道操作。服务器访问凭证不在交付物中；若已通过聊天发送密码，部署前应轮换并改用受控的 SSH 密钥访问。
