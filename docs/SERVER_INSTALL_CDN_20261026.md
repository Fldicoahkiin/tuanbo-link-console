# 服务器安装：更新下载走腾讯云 CDN（2026-11-04，已安装）

用户 2026-10-26 在调研后选择「腾讯云 CDN + 用量封顶」。现在官网下载和软件内更新都直连腾讯云上海服务器，固定 4Mbps（实测约 470 KB/s，988 MB 完整包约 35 分钟）；Cloudflare 只做 DNS。

这次要做的：

- `updates.tuanbo-link.jinhefilm.com` 改为经腾讯云 CDN 下载。域名不变，已装的客户端和官网链接自动走 CDN。
- 源站完全不变：Nginx、发布脚本、更新源目录、后台「回滚到上一版」照旧。Nginx 配置不改，所以 CI 部署的配置摘要不受影响。
- 给 `updates.` 单独签一张 Let's Encrypt 证书，只给 CDN 用。CDN 要用我们域名的 HTTPS，就必须把一张证书连同私钥交给腾讯云；单独签发后，交出去的私钥只对 `updates.` 有效，API 和官网共用的那张证书私钥不离开服务器。服务器上 Nginx 仍用原来的共用证书。
- 新增 `push-cdn-certificate.py` 和每天一次的 `tblink-cdn-certificate.timer`：certbot 续期这张专用证书后，自动部署到 CDN；同时检查共用证书没有快到期（它的续期也要经过 CDN），结果显示在后台「运行与维护」（`cdn-certificate` 一行）。为此 `console-health.py` 多读一个状态文件。
- `api.`、官网、后台三个域名不动。

谁来做：

| 事项 | 谁 |
| --- | --- |
| 腾讯云开通 CDN、改配置、建子账号、付款 | 用户本人 |
| 把子账号密钥填进服务器 | 用户本人（不在聊天里发，也不让会话读） |
| 服务器命令 | 主会话或用户，用 `ssh -F ~/.config/tblink-remote/ssh_config tblink-server` |
| Cloudflare 改 DNS 记录 | 用户本人 |

前提：用户确认这份说明，且由主会话转达原话。第 1 到第 6 步都不影响现有用户，DNS 在第 7 步才切；第 6 步测试不通过就停在那里。

<a id="费用"></a>
## 费用与封顶

- 价格（[腾讯云 CDN 基础服务计费](https://cloud.tencent.com/document/product/228/75562)）：中国境内按流量 0.21 元/GB（每月 0–2 TB 档），小时结算。一次完整下载约 1 GB，约 2 毛；软件内差分更新一般几 MB。HTTPS 请求每月前 300 万次免费。CDN 回源到我们服务器不另收 CDN 费用，服务器出口仍是原来的固定带宽。
- 估算：每月 20 台新装约 20 GB，约 4 元。不需要买流量包。
- 用量封顶（[文档](https://cloud.tencent.com/document/product/228/41733)）：超过阈值后这个域名在 CDN 上返回 404、自动下线，账单因此有上限。生效有约 10 分钟延迟，期间的用量照常计费；攻击产生的费用腾讯云不减免，所以封顶必须开。建议值如下，可以改：

| 规则 | 阈值 | 触发后 |
| --- | --- | --- |
| 瞬时带宽（每 5 分钟统计） | 1 Gbps | 60 分钟后自动恢复 |
| 累计流量，自然天 | 50 GB | 24 小时后自动恢复 |
| 累计流量，自然月 | 200 GB | 不自动恢复，人工上线 |
| 累计 HTTPS 请求，自然月 | 300 万次 | 不自动恢复，人工上线 |

  按这组阈值，一个月最多约 200 GB × 0.21 = 42 元，加上触发延迟期间的超出部分。告警阈值设 50%，推送到用户手机和邮箱。

- 封顶触发的影响：只影响 `updates.` 域名。软件里「检查更新」报网络错误、官网下载失败；激活、官网页面、后台不受影响。需要马上恢复时，最快的办法是第 [9](#9-回退) 步把 DNS 切回服务器。

<a id="0-只读检查"></a>
## 0. 只读检查

服务器上：

```bash
sudo certbot certificates
systemctl is-active certbot.timer nginx tblink-console-health.timer
sudo ls -l /srv/tblink-updates/windows/x64/
sudo ls -ld /var/www/tblink-acme
sudo stat -c '%U:%G %a' /opt/tblink-licensing/console-health.py
python3 --version
```

- 验证：
  - 共用证书 `tuanbo-link.jinhefilm.com` 的 Domains 里有 `updates.tuanbo-link.jinhefilm.com`，记下到期时间（2026-09-28 签发，到期 2026-12-26，certbot 会在剩 30 天时续期）。
  - 还没有名为 `updates.tuanbo-link.jinhefilm.com` 的证书；列表里其他站点的证书不动。
  - 三个单元都是 `active`；更新目录里是当前版本的安装包、blockmap 和 `latest.yml`。
  - `console-health.py` 是 `root:root 644`（第 4 步按这个安装；不一样就先停下核对）。
  - Python 3.10 或更高。
- 回退：只读，不需要。

<a id="1-开通并添加域名"></a>
## 1. 腾讯云：开通 CDN，添加域名（用户）

在 [CDN 控制台](https://console.cloud.tencent.com/cdn) 开通（计费方式选「按流量计费」），然后添加域名：

| 项 | 值 |
| --- | --- |
| 加速区域 | 中国境内 |
| 加速域名 | `updates.tuanbo-link.jinhefilm.com` |
| 加速类型 | 下载大文件 |
| 源站类型 | 自有源 |
| 回源协议 | 协议跟随 |
| 源站地址 | `123.206.229.200` |
| 回源 Host | 默认（与加速域名相同） |

- `jinhefilm.com` 已备案并接入腾讯云（见[部署交接](COMMERCIAL_DEPLOYMENT.md)），满足境内 CDN 的备案要求。如果控制台要求验证域名归属，按提示在 Cloudflare 加一条 TXT 记录，验证通过后可以删掉。
- 「回源协议」必须是「协议跟随」：Let's Encrypt 续期证书时用 HTTP 访问 `/.well-known/acme-challenge/`，要原样回源到服务器 80 端口的验证目录。选成 HTTPS 回源会让续期失败，而这张证书同时覆盖 `api.` 和官网。
- 记下控制台给的 CNAME（形如 `updates.tuanbo-link.jinhefilm.com.cdn.dnsv1.com`），后面写作 `<CNAME>`；命令里先执行 `cname=<CNAME>` 再用 `$cname`。
- 验证：域名状态为「已启动」或「部署中」，CNAME 状态显示「未配置」（DNS 还没切，正常）。
- 回退：在控制台关闭并删除这个域名。DNS 还没切，用户不受影响。

<a id="2-cdn-配置"></a>
## 2. 腾讯云：缓存、回源和防护配置（用户）

在这个域名的配置页逐项设置：

1. **节点缓存过期配置**（最后一条「全部文件」必须是优先级最低的一条，控制台里可调整顺序）：

   | 类型 | 内容 | 行为 |
   | --- | --- | --- |
   | 全部文件 | `*` | 不缓存 |
   | 文件类型 | `exe;blockmap` | 缓存 365 天 |
   | 文件路径 | `/windows/x64/latest.yml` | 不缓存 |
   | 文件夹 | `/.well-known/` | 不缓存 |

   - 带版本号的安装包和 blockmap 内容永不改变（同一版本号不会第二次发布），可以长期缓存。
   - `latest.yml` 不能缓存：发版、回滚都靠它立即生效，搬运脚本也要读到最新的那份。
2. **缓存键规则**：`exe;blockmap` 忽略全部参数，防止有人加随机参数绕过缓存、反复回源占满服务器出口。
3. **状态码缓存**：4xx、5xx 都不缓存（删掉默认的 404 缓存规则，或改为 0 秒）。
4. **分片回源**：开启（下载大文件类型默认开启）。CDN 按段向服务器取文件，软件内差分更新只回源需要的那几段。
5. **回源跟随 301/302**：关闭。
6. **HTTPS 配置**：证书由第 5 步的脚本部署，现在不用上传。证书部署后检查：HTTP2 开启，「强制跳转」关闭（HTTP 到 HTTPS 的跳转由服务器自己做，并且要给证书验证留出 HTTP），HSTS 关闭。
7. **IP 访问限频**：开启，单 IP 每秒 10 次。被限频拒绝的请求不计费。
8. **用量封顶配置**：按[上表](#费用)添加四条规则并打开总开关；告警阈值 50%。

- 验证：每项保存后控制台显示「部署成功」。
- 回退：同第 1 步。

<a id="3-子账号与密钥"></a>
## 3. 腾讯云：给证书同步建子账号（用户）

在 [访问管理](https://console.cloud.tencent.com/cam) 新建子用户 `tblink-cdn-certificate`：只开「编程访问」，不开控制台登录。授权一条自定义策略：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["ssl:UploadCertificate", "ssl:DeployCertificateInstance"],
      "resource": ["*"]
    }
  ]
}
```

这个密钥只能上传证书、把证书部署到云资源，不能改 CDN 其他配置、不能动服务器和账单。如果第 5 步报权限不足，报错会写缺哪一项，只补那一项。

建好后在子用户详情的「权限」页确认这条策略已关联（2026-11-03 安装时创建流程没有关联上，第 5 步报 `AuthFailure.UnauthorizedOperation`，补关联后才通过）。

账号里第一次用「把 SSL 证书部署到云资源」时，还要由主账号给 SSL 证书服务授权一次服务角色：在 [角色授权页](https://console.cloud.tencent.com/cam/role/grant?roleName=SSL_QCSLinkedRoleInReplaceLoadCertificate) 点「同意授权」，创建 `SSL_QCSLinkedRoleInReplaceLoadCertificate`，关联预设策略 `QcloudAccessForSSLLinkedRoleInReplaceLoadCertificate`。没授权时第 5 步上传能成功，部署报 `FailedOperation.RoleNotFoundAuthorization`。以后自动续期部署也靠这个角色，不要删。

然后用户本人在服务器上填写密钥（编辑器里写成 `{"secretId": "…", "secretKey": "…"}`，保存退出）：

```bash
sudo install -d -o root -g root -m 0700 /etc/tblink-cdn
sudo install -o root -g root -m 0600 /dev/null /etc/tblink-cdn/credentials.json
sudoedit /etc/tblink-cdn/credentials.json
sudo python3 -c 'import json; print(sorted(json.load(open("/etc/tblink-cdn/credentials.json"))))'
sudo stat -c '%U %a' /etc/tblink-cdn /etc/tblink-cdn/credentials.json
```

- 验证：只打印键名 `['secretId', 'secretKey']`；属主和权限是 `root 700`、`root 600`。会话不读取、不打印密钥内容。
- 回退：在访问管理里禁用或删除这个子用户的密钥；服务器上的文件移进备份目录。

<a id="4-安装脚本"></a>
## 4. 服务器：签发专用证书，安装证书同步脚本、定时任务和健康项

管理员电脑上，`<提交>` 是加入本文的那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-cdn"; mkdir -p "$out"
for f in push-cdn-certificate.py console-health.py tblink-cdn-certificate.service tblink-cdn-certificate.timer; do
  git show "${c}:apps/licensing-server/deploy/$f" > "$out/$f"
done
(cd "$out" && shasum -a 256 * | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上（第 4、5、6、8 步的服务器命令在同一个 SSH 会话里执行，后面要用 `$stamp`）：

```bash
cd ~/tblink-install-cdn && sha256sum -c SHA256SUMS
sudo certbot certonly --webroot -w /var/www/tblink-acme -d updates.tuanbo-link.jinhefilm.com --cert-name updates.tuanbo-link.jinhefilm.com --non-interactive
sudo certbot certificates --cert-name updates.tuanbo-link.jinhefilm.com
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /opt/tblink-licensing/console-health.py "/var/backups/tblink/install-$stamp/"
sudo install -o root -g root -m 0644 push-cdn-certificate.py console-health.py /opt/tblink-licensing/
sudo install -o root -g root -m 0644 tblink-cdn-certificate.service tblink-cdn-certificate.timer /etc/systemd/system/
sudo install -d -o root -g root -m 0755 /var/lib/tblink-cdn
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/tblink-cdn-certificate.service /etc/systemd/system/tblink-cdn-certificate.timer
sudo sha256sum /opt/tblink-licensing/push-cdn-certificate.py /opt/tblink-licensing/console-health.py "/var/backups/tblink/install-$stamp/console-health.py"
sudo python3 /opt/tblink-licensing/push-cdn-certificate.py --check; echo "exit=$?"
sudo systemctl start tblink-console-health.service
systemctl show tblink-console-health.service --property=Result,ExecMainStatus
```

- 专用证书沿用服务器现有的 ACME 账户和验证目录（certbot 提示有多个账户时，加上 `--account`，取值用 `sudo grep '^account' /etc/letsencrypt/renewal/tuanbo-link.jinhefilm.com.conf` 里的那个）；DNS 还没切，这次验证直接到服务器。服务器上的续期钩子 `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx` 对每张证书续期都会先 `nginx -t` 再平滑重载，所以专用证书续期时 Nginx 也会多重载一次，没有影响；专用证书不被 Nginx 使用，不需要另加钩子。
- 这一步不启用定时器：DNS 还没切，定时检查没有意义。
- 验证：
  - certbot 显示 `updates.tuanbo-link.jinhefilm.com` 证书，只有这一个域名，有效期约 90 天。
  - 摘要与 `SHA256SUMS` 一致；`systemd-analyze verify` 没有输出错误。
  - `--check` 输出「updates.tuanbo-link.jinhefilm.com 现在直接解析到服务器，没有经过 CDN…」，`exit=1`。说明脚本能运行，并且认得出 DNS 还没切。
  - 健康采集 `Result=success`、`ExecMainStatus=0`；还没有状态文件，后台不会多出一行。
- 回退（专用证书不被任何站点使用，留着只会按时续期；要停掉续期，由用户决定后执行 `sudo certbot delete --cert-name updates.tuanbo-link.jinhefilm.com`）：
  ```bash
  sudo install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/console-health.py" /opt/tblink-licensing/console-health.py
  sudo mv /opt/tblink-licensing/push-cdn-certificate.py /etc/systemd/system/tblink-cdn-certificate.service /etc/systemd/system/tblink-cdn-certificate.timer "/var/backups/tblink/install-$stamp/"
  sudo systemctl daemon-reload
  ```

<a id="5-首次部署证书"></a>
## 5. 服务器：第一次把证书部署到 CDN

DNS 还没切，所以用 `--edge` 直接连 CDN 的 CNAME：

```bash
cname=<CNAME>
sudo python3 /opt/tblink-licensing/push-cdn-certificate.py --edge "$cname"; echo "exit=$?"
sudo cat /var/lib/tblink-cdn/certificate-status.json; echo
sudo openssl x509 -in /etc/letsencrypt/live/updates.tuanbo-link.jinhefilm.com/fullchain.pem -noout -fingerprint -sha256 -enddate
openssl s_client -connect "$cname:443" -servername updates.tuanbo-link.jinhefilm.com </dev/null 2>/dev/null | openssl x509 -noout -fingerprint -sha256 -enddate
```

- 脚本做的事：比较 CDN 现在给出的证书和服务器上的专用证书；不同（或 CDN 还没有证书）就把专用证书上传到腾讯云 SSL 证书、部署到这个 CDN 域名（HTTPS 计费开关 `on`，关了 CDN 会对 HTTPS 返回 514），每 30 秒检查一次，最多等 20 分钟，直到 CDN 给出的就是这张证书。
- 验证：
  - 输出含「已部署服务器证书 …」和「服务器共用证书到期 …」，`exit=0`；状态文件 `state` 为 `success`。
  - 两条 `openssl` 的指纹和到期时间相同。
  - CDN 控制台「HTTPS 配置」显示这张证书，按第 2 步第 6 项检查 HTTP2、强制跳转和 HSTS。
  - 状态文件会出现在后台「运行与维护」。如果第 5 步之后隔了两天以上才切 DNS，这一行会先显示「超过两天没有新的 CDN 证书检查」，第 8 步之后恢复。
- 回退：DNS 还没切，用户不受影响。需要时在 CDN 控制台关闭 HTTPS，在 SSL 证书控制台删除上传的证书。

<a id="6-切换前测试"></a>
## 6. 切换前测试（经 CNAME 访问 CDN，DNS 还没切）

管理员电脑上。`--connect-to` 让请求连到 CDN，但域名、证书校验都和正式访问一样；不带它的请求仍直连服务器，作对照：

```bash
base=https://updates.tuanbo-link.jinhefilm.com/windows/x64
cname=<CNAME>
via=(--connect-to "updates.tuanbo-link.jinhefilm.com:443:$cname:443")
t=$(mktemp -d)

# a. latest.yml：与源站逐字节相同，且不被缓存
curl -sS "${via[@]}" -D "$t/cdn.h" -o "$t/cdn.yml" "$base/latest.yml"
curl -sS -o "$t/origin.yml" "$base/latest.yml"
cmp "$t/cdn.yml" "$t/origin.yml" && echo latest-same
curl -sS "${via[@]}" -D - -o /dev/null "$base/latest.yml" | grep -i -E '^(cache-control|x-cache-lookup):'

# b. 安装包：大小与 latest.yml 一致，支持 Range
exe=$(awk '/^path:/{print $2}' "$t/cdn.yml"); size=$(awk '/^ *size:/{print $2; exit}' "$t/cdn.yml"); echo "$exe $size"
curl -sS "${via[@]}" -I "$base/$exe" | grep -i -E '^(HTTP|content-length|accept-ranges)'

# c. 单段 Range：与源站同一段相同
curl -sS "${via[@]}" -r 1048576-2097151 -o "$t/cdn.part" -w '%{http_code} %{size_download}\n' "$base/$exe"
curl -sS -r 1048576-2097151 -o "$t/origin.part" "$base/$exe"
cmp "$t/cdn.part" "$t/origin.part" && echo range-same

# d. 多段 Range：软件内差分更新一次请求取多段
curl -sS "${via[@]}" -H 'Range: bytes=0-99,1048576-1048675,5242880-5242979' -D "$t/multi.h" -o "$t/multi.body" "$base/$exe"
head -1 "$t/multi.h"; grep -i '^content-type' "$t/multi.h"; grep -a -c -i '^content-range: bytes' "$t/multi.body"

# e. 白名单以外仍是 404
curl -sS "${via[@]}" -o /dev/null -w '%{http_code}\n' "$base/not-a-release.exe"

# f. 速度：取前 200 MB 两次（第一次可能要回源，第二次应命中缓存）
for i in 1 2; do curl -sS "${via[@]}" -r 0-209715199 -o /dev/null -w "%{http_code} %{speed_download} B/s\n" "$base/$exe"; done
```

再在服务器上验证证书续期要走的 HTTP 路径（测试文件放进备份目录收尾）：

```bash
sudo install -d -o root -g root -m 0755 /var/www/tblink-acme/.well-known/acme-challenge
echo "tblink-cdn-$stamp" | sudo tee /var/www/tblink-acme/.well-known/acme-challenge/tblink-cdn-test >/dev/null
curl -sS --connect-to "updates.tuanbo-link.jinhefilm.com:80:$cname:80" http://updates.tuanbo-link.jinhefilm.com/.well-known/acme-challenge/tblink-cdn-test
sudo mv /var/www/tblink-acme/.well-known/acme-challenge/tblink-cdn-test "/var/backups/tblink/install-$stamp/"
```

- 验证：
  - a：打印 `latest-same`；`Cache-Control: no-store`，`X-Cache-Lookup` 不是命中缓存（不含 `Hit`）。
  - b：`HTTP/2 200`（或 `HTTP/1.1 200`），`content-length` 等于 `$size`，`accept-ranges: bytes`。
  - c：`206 1048576`，打印 `range-same`。
  - d：`206`，`content-type: multipart/byteranges; boundary=…`，计数为 `3`。
  - e：`404`。
  - f：第二次明显快于 470 KB/s。第一次要从服务器回源，可能要几分钟（每次约 200 MB 流量，约 4 分钱）。
  - ACME：打印出 `tblink-cdn-<stamp>`。
- **d 不通过时停在这里，不切 DNS。** 软件内差分更新会自动改为下载完整安装包（约 1 GB），速度变快但每次约 2 毛，也不再是几秒更新完。处理办法是下一版客户端在更新源配置里加 `useMultipleRangeRequest: false`（改为逐段请求），已装的 0.5.x 仍会整包下载；这需要用户决定，回到主会话。
- ACME 不通过时也停在这里：检查第 1 步的「协议跟随」、第 2 步的 `/.well-known/` 不缓存和「强制跳转」关闭。
- 回退：只读，不需要（测试文件已移走）。

<a id="7-切换-dns"></a>
## 7. Cloudflare：切换 DNS（用户）

1. 先截图或记下 `updates.tuanbo-link` 现在的记录：A、`123.206.229.200`、仅 DNS、TTL Auto 和 Comment。这就是备份。
2. 把这条记录改为 CNAME，内容 `<CNAME>`，仍为仅 DNS（灰云），TTL Auto。Comment 改为：`团播联动台：Windows x64 更新清单与正式安装包出口；腾讯云 CDN（中国境内）回源 jinhe-cloud（腾讯云上海）；仅 DNS。`
3. 不动其他记录。

管理员电脑和服务器上各查一次：

```bash
dig +short updates.tuanbo-link.jinhefilm.com
curl -sS -D - -o /dev/null https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml | grep -i -E '^(HTTP|x-cache-lookup|server):'
```

- 验证：`dig` 先出现 `<CNAME>`，后面是 CDN 节点地址，不再是 `123.206.229.200`；响应头带 `X-Cache-Lookup`。各地 DNS 缓存最长约 5 分钟。
- 回退：见第 [9](#9-回退) 步。

<a id="8-切换后核对"></a>
## 8. 切换后核对，启用定时检查

服务器上：

```bash
sudo systemctl start tblink-cdn-certificate.service
systemctl show tblink-cdn-certificate.service --property=Result,ExecMainStatus
sudo journalctl -u tblink-cdn-certificate.service -n 5 --no-pager
sudo systemctl enable --now tblink-cdn-certificate.timer
systemctl list-timers tblink-cdn-certificate.timer --no-pager
sudo certbot renew --cert-name updates.tuanbo-link.jinhefilm.com --dry-run --no-random-sleep-on-renew
sudo certbot renew --cert-name tuanbo-link.jinhefilm.com --dry-run --no-random-sleep-on-renew
```

- 验证：
  - 服务 `Result=success`，日志是「CDN 证书与服务器一致，到期 …（剩 N 天）」。
  - 定时器已启用，列出下一次运行时间。
  - 两次 certbot 演练都通过：专用证书和共用证书里 `updates.` 的 HTTP 验证都是经 CDN 回源完成的。
  - 5 分钟内后台「运行与维护」出现 `cdn-certificate`，状态「成功」。
- 用户在自己电脑和直播间电脑上：官网下载安装包看速度；软件里「设置 › 外观与更新 › 软件更新」点检查更新，能正常显示当前状态。
- 下一次发版时多看一眼：老版本客户端更新时，面板里的下载总量应是几 MB，而不是约 1 GB。几 MB 说明差分更新经 CDN 正常。
- 回退：见第 [9](#9-回退) 步。

<a id="9-回退"></a>
## 9. 回退

任何时候需要撤回 CDN（封顶触发后急需恢复、CDN 故障、续期失败）：

1. 用户在 Cloudflare 把 `updates.tuanbo-link` 改回第 7 步备份的 A 记录 `123.206.229.200`（仅 DNS），Comment 改回原文。约 5 分钟后所有人重新直连服务器，和这次安装前完全一样。
2. 服务器上停用定时检查（否则它每天会报「现在直接解析到服务器」）：
   ```bash
   sudo systemctl disable --now tblink-cdn-certificate.timer
   ```
3. 用户在 CDN 控制台关闭这个域名，停止计费。
4. 后台的 `cdn-certificate` 一行会停在最后一次的结果，两天后显示「超过两天没有新的 CDN 证书检查」，可以忽略。要彻底撤掉，按第 4 步的回退恢复 `console-health.py`，再把 `/var/lib/tblink-cdn/certificate-status.json` 移进备份目录。

源站在整个过程中没有变化，回退不需要动 Nginx、证书或更新源。

<a id="以后的发版"></a>
## 以后的发版

- 发版、搬运、自动上线、后台回滚的流程都不变。`latest.yml` 不缓存，新版本或回滚在 CDN 上立即生效。
- 每个新版本第一次被下载时，CDN 要从服务器取文件，这一段仍受 4Mbps 限制；同一段被取过之后，后面的人都从 CDN 拿。不预热也能用。
- 撤下的版本：它的安装包仍在 CDN 缓存里，知道地址的人还能下载（软件不会再去下，因为 `latest.yml` 不再指向它）。需要彻底撤下时，在 CDN 控制台「刷新预热」里刷新那个 URL。
- CDN 证书由定时检查维护：certbot 在专用证书剩 30 天时续期，脚本当天或第二天部署到 CDN；CDN 上的证书或服务器共用证书剩 14 天还没续上时，后台这一行显示失败。SSL 证书控制台里也能看到 CDN 证书的到期时间。腾讯云 SSL 证书列表会随续期逐张增加旧证书，过期的可以在控制台删除。

<a id="10-记录"></a>
## 10. 记录

在本文末尾补一节「安装结果」：实际安装的提交号、`$stamp`、各文件摘要、`<CNAME>`、用量封顶的实际阈值、第 6 步每项的输出（特别是 d 和 f）、第 8 步两次 certbot 演练的结果。装完同步更新 [软件更新](SOFTWARE_UPDATES.md#当前链路)、[部署交接](COMMERCIAL_DEPLOYMENT.md) 和 [完整链路核查](RELEASE_CHAIN.md) 里关于下载出口的描述。

<a id="安装结果"></a>
## 安装结果

2026-10-27 至 2026-11-04 由主会话经用户 Mac 上的会话执行。用户 10-27 回复「确认安装」，11-01「cdn那个帮我处理」，11-04 对切 DNS 和后续步骤回复「确认啊，都确认，后面都确认」。腾讯云开通、建子用户、关联策略、服务角色授权、填写密钥由用户本人点击和输入；Cloudflare 记录经用户授权的 Cloudflare API 连接器修改。

- 安装的字节：提交 3c890d9（分支 `claude/project-thread-bgi1y0`）。`push-cdn-certificate.py` `c11c1b838a2b49a30a3130f527a9c6ba017542b5d32bb3c974623e702de78789`；`console-health.py` `1e5a6d4f51e1dae139c9ac7c435b9c32390b81f86654482b7e9cb3c5f12601e1`（旧版 `f12cdbd9…` 在备份目录）；`tblink-cdn-certificate.service` `32ddfac337fbb9269007cb591d29ce04d3ccd538751843e8ac1c5d30c82dfe2a`；`tblink-cdn-certificate.timer` `7be6a49d1639e9095c89ab0b65614f255303ae78a8581228e9b54cccc309a602`。
- `$stamp`：`20261027T051254Z`，备份在 `/var/backups/tblink/install-20261027T051254Z/`。
- 第 1 步：中国境内、下载大文件、自有源 `123.206.229.200`、回源协议跟随、回源 Host 为加速域名。域名归属用 `_cdnauth` TXT 验证（API 添加，仅 DNS），验证通过后已删掉。`<CNAME>` 是 `updates.tuanbo-link.jinhefilm.com.cdn.dnsv1.com`。
- 第 2 步：缓存规则四条按表设置（`/.well-known` 文件夹在控制台里不能以 `/` 结尾），控制台自带的 `php;jsp;asp;aspx` 不缓存规则保留；缓存键 `exe;blockmap` 忽略全部参数；删掉默认的 404 缓存 10 秒，状态码缓存为空；分片回源开（原为关）；回源跟随 301/302 关；IP 访问限频单 IP 每秒 10 次。用量封顶总开关开，超出都返回 404、告警 50%：带宽 1 Gbps（每 5 分钟统计，60 分钟后解封）、流量 50 GB/天（24 小时后解封）、流量 200 GB/自然月（不自动解封）、HTTPS 请求 300 万次/自然月（不自动解封）。
- 第 3 步：子用户 `tblink-cdn-certificate` 11-03 建好；创建流程没有关联上策略，第 5 步报 `AuthFailure.UnauthorizedOperation`（`ssl:UploadCertificate`），用户补关联后通过。部署时又报 `FailedOperation.RoleNotFoundAuthorization`，用户用主账号授权服务角色 `SSL_QCSLinkedRoleInReplaceLoadCertificate`（预设策略 `QcloudAccessForSSLLinkedRoleInReplaceLoadCertificate`，11-03 16:47:26 北京时间）。两项都已补进第 3 步。密钥文件只核对了键名 `['secretId', 'secretKey']` 和权限 `root 700`、`root 600`。子用户的访问方式目前多开了「控制台访问」，建议用户在用户详情里关掉，不影响证书同步。
- 第 4 步：专用证书只含 `updates.tuanbo-link.jinhefilm.com`；摘要一致，`systemd-analyze verify` 无输出；`--check` 认出 DNS 未切，`exit=1`；健康采集 `Result=success`。
- 第 5 步：`exit=0`，状态文件 `success`；腾讯云证书 `c4zrK1IN`（部署任务 273558）。服务器和 CDN 两边指纹都是 `60:F2:1F:CF:1C:A6:2A:7C:D1:10:CE:E3:99:5E:07:76:35:B2:A8:D1:9A:94:A0:A2:37:61:A7:8D:8D:C8:80:96`，到期 2027-01-25 04:14:00 GMT。HTTP2 开，强制跳转关，HSTS 关。
- 第 6 步（在服务器上执行，Mac 本机的代理会干扰 DNS 和出口）：
  - a：`latest-same`；`cache-control: no-store`；`x-cache-lookup: Cache Miss`。
  - b：`Tuanbo-Link-Console-0.5.5-x64.exe`，`HTTP/2 200`，`content-length: 981519178`（与 `latest.yml` 一致），`accept-ranges: bytes`。
  - c：`206 1048576`，`range-same`。
  - d：`HTTP/2 206`，`content-type: multipart/byteranges; boundary=00000000000000000001nws_multipart_boundary`，计数 `3`。
  - e：`404`。
  - f：第一次 483,332 B/s（434 秒，回源），第二次 12,399,417 B/s（约 11.8 MB/s，16.9 秒）。
  - ACME 路径：打印 `tblink-cdn-20261027T051254Z`，测试文件已移进备份目录。
- 第 7 步（2026-11-04 01:01:45 UTC，切 DNS 前再次核对域名「已启动」、限频和四条封顶）：同一条记录（id `3689d0f7…`）从 A `123.206.229.200`、仅 DNS、TTL Auto、注释「团播联动台：Windows x64 更新清单与正式安装包出口；源站 jinhe-cloud（腾讯云上海）；仅 DNS，源站 Nginx 提供 HTTPS。」改为 CNAME `updates.tuanbo-link.jinhefilm.com.cdn.dnsv1.com`、`proxied=false`、TTL Auto、注释按第 7 步；读回核对一致，其他记录没动。服务器默认解析、`119.29.29.29`、`1.1.1.1` 都先返回 CNAME，再到 `826ag3fd.sched.vodtylego.tdnsvod1.cn.`，最后是 CDN 节点（国内 `43.171.80.33/34/38`、`43.141.156.172`；`1.1.1.1` 给 `123.139.193.50`、`221.204.73.91`）。`latest.yml` 经节点 `43.171.80.38` 返回 `HTTP/2 200`、`x-cache-lookup: Cache Miss`。
- 第 8 步：服务 `Result=success`、`ExecMainStatus=0`，日志「CDN 证书与服务器一致，到期 2027-01-25（剩 82 天）；服务器共用证书到期 2026-12-27（剩 52 天）」；定时器已启用，下次 2026-11-05 00:20:44 北京时间；后台 `cdn-certificate` 一行 `success`。两次 `certbot renew --dry-run` 都失败：服务器连 Let's Encrypt 演练服务器 `acme-staging-v02.api.letsencrypt.org:443` 约 20 秒后被重置（连了 4 次都一样），还没走到 HTTP 验证；正式服务器 `acme-v02` 返回 200（0.9 秒）。改为两项验证：经切换后的真实 DNS 访问 `/.well-known/acme-challenge/` 测试文件，国内节点 `43.171.80.38` 和境外解析到的 `123.139.193.50` 都返回 200、内容正确；强制续期专用证书来端到端验证的命令被 Mac 会话的权限审查拦下，没有执行，证书没变。共用证书剩 30 天时（约 2026-11-27）会经 CDN 自动续期，到时核对一次；续不上时后台 `cdn-certificate` 一行在剩 14 天时报失败，也可以先按第 9 步把 DNS 切回服务器再续。
