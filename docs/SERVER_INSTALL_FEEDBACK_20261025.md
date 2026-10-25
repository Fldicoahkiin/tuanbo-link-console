# 服务器安装：问题反馈接口（待用户确认）

桌面端 0.5.3 的「设置 › 帮助与反馈 › 问题反馈」和激活页的反馈入口，会把现象说明和诊断包发到 `https://api.tuanbo-link.jinhefilm.com/v1/feedback`。服务器装好之前，桌面端提交时提示「反馈服务尚未开通」，可以用「另存为文件」。设计和客户端说明见 [问题反馈与日志整理](FEEDBACK_AND_LOGS_20261025.md)。

代码在分支 `claude/project-thread-2w5uee`，还没进 master：一进 master，CI 就会自动部署授权服务，所以要按本文的顺序装。

<a id="改什么"></a>
## 服务器上改什么

| 对象 | 变化 | 由谁改 |
| --- | --- | --- |
| 授权服务 `dist/index.js` | 新增反馈接口；启动时建 `feedback` 表（只加表，不改已有表） | 推 master 后 CI 自动部署 |
| 运营后台静态文件 | 新增「问题反馈」页，管理员和运营可见 | 同上 |
| 官网 `/privacy/` | 隐私政策补上问题反馈收集的内容和保存期限 | 同上 |
| `/opt/tblink-licensing/activate-release.py` | 部署工具允许反馈的两个路由：要么都有、要么都没有，并且都带限流 | 手工安装（第 5 步） |
| `/etc/tblink-licensing/service.env` | 加一行 `FEEDBACK_DIRECTORY=/var/lib/tblink-licensing/feedback` | 手工（第 4 步） |
| `/var/lib/tblink-licensing/feedback/` | 诊断包目录，`tblink-license` 所有，0700 | 手工（第 4 步） |
| `/etc/nginx/sites-available/tblink-licensing.conf` | 加反馈限流区和两个 location，其余不动 | 手工（第 6 步） |
| `/etc/tblink-deploy/policy.json` | `nginxSha256` 换成新配置的摘要 | 手工（第 6 步） |

不改：支付配置、商品目录、已有数据表、运营后台的 Nginx、systemd 单元、其他站点和服务。

服务器端的限制：

| 项目 | 限制 |
| --- | --- |
| 同一网络（IPv4 地址或 IPv6 /64） | 每小时 6 条、每天 20 条；另有每分钟 10 次请求的进程内限流，Nginx 每分钟 6 次（可突发 3 次） |
| 同一台电脑（机器码） | 每天 10 条 |
| 全站 | 每天 500 条 |
| 诊断包 | 授权有效的电脑 8 MB，其他 2 MB；上传凭据 30 分钟内一次有效；核对大小、SHA-256 和 gzip 文件头 |
| 存储 | 诊断包合计不超过 2 GB（含已发出、还没传完的上传位）；每次上传后磁盘至少留 1 GB，不够就只收文字 |
| 保存期限 | 诊断包 180 天，反馈记录 2 年，到期自动删除（每小时最多整理一次，只在有新反馈时进行，启动时不做） |
| 隐私 | 来源只存网络地址的加密摘要，不存 IP；只有管理员和运营能在后台看到反馈、联系方式和诊断包；下载诊断包记审计 |

同一条反馈（同网络、同电脑、同样的说明）24 小时内重复提交，返回原编号，不重复计数；原来的诊断包没传上去时，给新的上传凭据。

<a id="前提"></a>
## 前提

- 用户确认安装（写进本文末尾「安装结果」）。
- 没有其他会话准备往 master 推授权服务、官网或后台的改动；发版搬运脚本此时没有在推官网 `release.json`。从第 5 步装上部署工具到推上 master 只有几分钟，这期间别的推送会被部署工具拒绝（不影响线上，之后在 GitHub 上重跑一次工作流即可）。
- 每步都写了：做什么、备份什么、怎么验证、失败怎么回退。前一步验证没通过，就不要做下一步。第 2 步到第 6 步在同一个 SSH 会话里执行，`$stamp` 一直不变。

<a id="1-合并检查"></a>
## 1. 合并到最新 master，本地检查（管理员电脑）

```bash
gh api user --jq .login            # 应为 Fldicoahkiin
git fetch origin master claude/project-thread-2w5uee
git switch -c feedback-install origin/claude/project-thread-2w5uee
git rebase origin/master
pnpm install --frozen-lockfile
pnpm --filter @tb/licensing-server typecheck
pnpm exec vitest run apps/licensing-server apps/desktop/src/main/link/purchase-service.test.ts
python3 -m unittest discover -s apps/licensing-server/deploy -p 'test_*.py'
c=$(git rev-parse HEAD); echo "$c"
```

- 验证：类型检查、测试全部通过；`git log --oneline origin/master..HEAD` 只有本分支的提交。
- 回退：本地操作，删掉 `feedback-install` 分支即可。

<a id="2-导出检查"></a>
## 2. 导出原始字节，只读检查

管理员电脑上：

```bash
out="$(mktemp -d)/tblink-install-feedback"; mkdir -p "$out"
for f in activate-release.py publish-website.py feedback-proxy.py nginx.conf; do
  git show "${c}:apps/licensing-server/deploy/$f" > "$out/$f"
done
git show "origin/master:apps/licensing-server/deploy/activate-release.py" | shasum -a 256   # 现装版本应与此一致
(cd "$out" && shasum -a 256 activate-release.py publish-website.py feedback-proxy.py nginx.conf | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
ssh -F ~/.config/tblink-remote/ssh_config tblink-server
```

服务器上：

```bash
cd ~/tblink-install-feedback && sha256sum -c SHA256SUMS
sudo sha256sum /opt/tblink-licensing/activate-release.py /etc/nginx/sites-available/tblink-licensing.conf
sudo stat -c '%a %U:%G %n' /opt/tblink-licensing/activate-release.py /etc/nginx/sites-available/tblink-licensing.conf /etc/tblink-licensing/service.env /etc/tblink-deploy/policy.json
sudo python3 -c "import json; print(json.load(open('/etc/tblink-deploy/policy.json'))['nginxSha256'])"
sudo grep -c '^FEEDBACK_DIRECTORY=' /etc/tblink-licensing/service.env
df -h /var/lib/tblink-licensing
systemctl list-units 'tblink-deploy-*' --no-legend
python3 feedback-proxy.py /etc/nginx/sites-available/tblink-licensing.conf nginx.conf tblink-licensing.conf.next
diff -u /etc/nginx/sites-available/tblink-licensing.conf tblink-licensing.conf.next
```

- 验证：
  - 四个文件 `OK`。
  - 现装 `activate-release.py` 的摘要与 origin/master 上的一致（说明服务器没有别的未记录改动）。
  - `policy.json` 里的 `nginxSha256` 等于现在 Nginx 配置的摘要。
  - `grep -c` 输出 `0`；`df` 显示 `/var/lib/tblink-licensing` 所在磁盘可用空间至少 4 GB。
  - `tblink-deploy-*` 为空，GitHub Actions 里没有正在运行的 Verify Licensing Server。
  - `feedback-proxy.py` 打印 `candidate … sha256 …`（它已用部署工具和官网发布工具的同一套检查核过新配置），记下这个摘要。
  - `diff` 里只有新增行：文件开头的反馈限流区（注释一行加 `limit_req_zone … zone=tblink_feedback …`），API 站点里 `location / { return 404; }` 之前的两个 location（`= /v1/feedback` 只许 POST，`/v1/feedback/<编号>/diagnostic` 只许 PUT、上限 9m），没有删除或改动的行。
- 回退：只读，不需要回退。`feedback-proxy.py` 不写 `/etc`，只在当前目录生成候选文件。

<a id="3-备份"></a>
## 3. 备份

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
b="/var/backups/tblink/install-$stamp"
sudo install -d -o root -g root -m 0700 "$b"
sudo cp -p /opt/tblink-licensing/activate-release.py /etc/tblink-licensing/service.env /etc/tblink-deploy/policy.json "$b/"
sudo cp -p /etc/nginx/sites-available/tblink-licensing.conf "$b/tblink-licensing.conf"
sudo python3 - "$b/license.db" <<'PY'
import sqlite3, sys
from contextlib import closing
with closing(sqlite3.connect('file:/var/lib/tblink-licensing/license.db?mode=ro', uri=True)) as source, closing(sqlite3.connect(sys.argv[1])) as target:
    source.backup(target)
    print(target.execute('PRAGMA integrity_check').fetchone()[0], target.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table'").fetchone()[0])
PY
sudo sha256sum "$b"/*
```

- 备份：部署工具、环境文件、部署策略、Nginx 配置和数据库副本都在 `$b`。第 5 步的 CI 部署还会另做一份数据库备份并核对恢复（`activate-release.py` 的原有流程）。
- 验证：Python 输出 `ok` 和表的数量；`$b` 里五个文件的摘要与原文件一致（数据库副本除外）。
- 回退：只新建了备份目录，不需要回退。

<a id="4-目录和环境变量"></a>
## 4. 建诊断包目录，加环境变量（服务照常运行）

```bash
sudo install -d -o tblink-license -g tblink-license -m 0700 /var/lib/tblink-licensing/feedback
sudo flock -n /var/lib/tblink-deploy/deployment.lock sh -c 'printf "\n# In-app problem reports (docs/SERVER_INSTALL_FEEDBACK_20261025.md)\nFEEDBACK_DIRECTORY=/var/lib/tblink-licensing/feedback\n" >> /etc/tblink-licensing/service.env'
sudo stat -c '%a %U:%G %n' /var/lib/tblink-licensing/feedback /etc/tblink-licensing/service.env
sudo grep -n '^FEEDBACK_DIRECTORY=' /etc/tblink-licensing/service.env
```

- 正在运行的旧版服务不认这个变量，线上不变；第 5 步部署的新版启动时读它。
- 验证：目录为 `700 tblink-license:tblink-license`；环境文件权限、属主与第 2 步一致；`grep` 只有一行。
- 失败回退：`sudo flock -n /var/lib/tblink-deploy/deployment.lock install -m 0600 -o <原属主> -g <原属组> "$b/service.env" /etc/tblink-licensing/service.env`（属主、权限按第 2 步记下的写）。空的诊断包目录可以留着，或 `sudo mv /var/lib/tblink-licensing/feedback "$b/feedback-dir"` 挪进备份目录。

<a id="5-部署工具推-master"></a>
## 5. 装部署工具，立即推 master

服务器上：

```bash
mode=$(sudo stat -c %a /opt/tblink-licensing/activate-release.py)
sudo flock -n /var/lib/tblink-deploy/deployment.lock install -o root -g root -m "$mode" ~/tblink-install-feedback/activate-release.py /opt/tblink-licensing/activate-release.py
sudo sha256sum /opt/tblink-licensing/activate-release.py
```

`flock -n` 在 CI 正在部署时会立即失败，等它结束再试。装好后，管理员电脑上立即推送：

```bash
git fetch origin master && git merge-base --is-ancestor origin/master HEAD && git push origin HEAD:master
```

- 新的 `activate-release.py` 对现在没有反馈路由的 Nginx 照样放行，所以这次部署按原流程进行：维护页、停服务、备份并核对数据库、启动新版、核对已有表没变、恢复代理。
- 验证：
  - 新装文件的摘要与第 2 步 `SHA256SUMS` 一致。
  - 推送触发的 Verify Licensing Server 成功，「Deploy verified licensing service and website」实际执行（不是跳过）。
  - `sudo cat /var/lib/tblink-deploy/last-success.json` 和 `/opt/tblink-licensing/RELEASE` 里的 revision 是 `$c`。
  - `sudo journalctl -u tblink-licensing -n 20 --no-pager` 里有「问题反馈已开启」。
  - 数据库有了空的反馈表，其他表没变：
    ```bash
    sudo python3 -c "import sqlite3; db=sqlite3.connect('file:/var/lib/tblink-licensing/license.db?mode=ro', uri=True); print(db.execute('SELECT COUNT(*) FROM feedback').fetchone()[0])"
    ```
    输出 `0`。
  - 公网 `curl -fsS https://api.tuanbo-link.jinhefilm.com/health` 返回 `{"status":"ok"}`；官网、`/privacy/`、运营后台能打开，后台左侧有「问题反馈」（管理员、运营可见），页面为空。
  - 这时 `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://api.tuanbo-link.jinhefilm.com/v1/feedback` 仍是 `404`：Nginx 还没放行，属正常。
- 失败回退：
  - 部署被拒（`Deployment tools or proxy require an operator-reviewed update`）：核对已装工具的摘要是否等于 `$c` 里的版本，装对后在 GitHub 上重跑工作流。
  - 激活失败：`activate-release.py` 会自动装回旧代码、环境和代理，线上回到部署前。之后要撤回全部改动时，先在服务器上装回旧工具 `sudo flock -n /var/lib/tblink-deploy/deployment.lock install -o root -g root -m "$mode" "$b/activate-release.py" /opt/tblink-licensing/activate-release.py`，再在 master 上 `git revert` 本次的提交并推送，CI 会部署回旧版。反馈表留在库里（生产库只加表），旧版不读它。

<a id="6-nginx"></a>
## 6. 放行公网路由（Nginx 和部署策略）

服务器上，在部署锁里一次做完：装新配置、`nginx -t`、重载、更新策略摘要。`nginx -t` 不通过就装回原配置并停止。

```bash
cd ~/tblink-install-feedback
sudo flock -n /var/lib/tblink-deploy/deployment.lock bash -eu -s "$PWD/tblink-licensing.conf.next" "$b/tblink-licensing.conf" <<'SH'
conf=/etc/nginx/sites-available/tblink-licensing.conf
install -o root -g root -m 0644 "$1" "$conf"
if ! nginx -t; then install -o root -g root -m 0644 "$2" "$conf"; nginx -t; echo "nginx -t 失败，已装回原配置" >&2; exit 1; fi
systemctl reload nginx
python3 - "$conf" <<'PY'
import hashlib, json, os, sys
path = '/etc/tblink-deploy/policy.json'
policy = json.load(open(path))
policy['nginxSha256'] = hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest()
staged = path + '.next'
with open(staged, 'w') as out:
    out.write(json.dumps(policy, indent=2) + '\n')
os.chmod(staged, 0o600)
os.replace(staged, path)
print('policy nginxSha256', policy['nginxSha256'])
PY
SH
sudo sha256sum /etc/nginx/sites-available/tblink-licensing.conf
sudo stat -c '%a %U:%G %n' /etc/tblink-deploy/policy.json
```

- 验证：
  - 打印的 `policy nginxSha256` 与 `sha256sum` 的结果、第 2 步 `feedback-proxy.py` 打印的摘要三者一致；`policy.json` 仍为 `600 root:root`（以第 2 步记下的为准）。
  - 管理员电脑上：
    ```bash
    curl -s -X POST -H 'Content-Type: application/json' -d '{}' https://api.tuanbo-link.jinhefilm.com/v1/feedback
    curl -s -o /dev/null -w '%{http_code}\n' https://api.tuanbo-link.jinhefilm.com/v1/feedback
    curl -fsS https://api.tuanbo-link.jinhefilm.com/health
    ```
    第一条返回 `{"code":"INVALID_FEEDBACK",…}`（说明请求到了服务，空请求不会存任何东西）；第二条（GET）返回 `403`；第三条 `{"status":"ok"}`。
  - 实际提交一条：用 master 构建的桌面端（或 0.5.3 正式版），在「设置 › 帮助与反馈 › 问题反馈」写「安装验证：服务器反馈接口」，类型选「界面与其他」，附诊断包提交，拿到 `FB-…` 编号，提示「诊断包已一并上传」。后台「问题反馈」里能看到这条，诊断包为「已收到」，能下载；然后点「处理问题反馈」，选关闭，处理结论写「安装验证」。
  - 在 GitHub 上手动运行一次 Verify Licensing Server（master），部署步骤成功：说明以后的自动部署认可新的 Nginx 配置。
- 失败回退：
  - 上面的脚本在 `nginx -t` 失败时已自动装回原配置，策略没动。
  - 装好后要撤回：
    ```bash
    sudo flock -n /var/lib/tblink-deploy/deployment.lock bash -eu -c 'install -o root -g root -m 0644 "$1/tblink-licensing.conf" /etc/nginx/sites-available/tblink-licensing.conf && nginx -t && systemctl reload nginx && install -o root -g root -m 0600 "$1/policy.json" /etc/tblink-deploy/policy.json' _ "$b"
    ```
    公网反馈接口回到 404，桌面端提示「反馈服务尚未开通」。

<a id="临时关闭"></a>
## 临时关闭反馈（不改代码）

被刷或磁盘紧张时：在部署锁里把 `service.env` 的 `FEEDBACK_DIRECTORY` 那行删掉（或装回 `$b/service.env`），再 `sudo systemctl restart tblink-licensing`。接口回答 `404 FEEDBACK_DISABLED`，桌面端提示「反馈服务尚未开通」并建议另存为文件；后台仍能查看已收到的反馈，但不能下载诊断包。恢复时加回那一行再重启。

<a id="7-记录"></a>
## 7. 记录

在本文末尾补「安装结果」：用户确认原话、实际提交号 `$c`、`$stamp`、第 2 步记下的各文件摘要和权限、新的 Nginx 摘要、CI 运行链接和部署结果、验证用的反馈编号。

`~/tblink-install-feedback` 用完挪进 `$b`（`sudo mv ~/tblink-install-feedback "$b/"`），不要删。
