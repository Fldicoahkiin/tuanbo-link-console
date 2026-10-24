# 服务器安装：仓库转移后重装 receive-release.py（已安装）

仓库从 `JinHe9527/tuanbo-link-console` 转移到 `Fldicoahkiin/tuanbo-link-console` 后，自动部署有三处认仓库名：工作流的部署条件、CI 端的 `deploy-from-ci.py`、服务器上的 `receive-release.py`。改动在提交「fix(deploy): deploy from Fldicoahkiin/tuanbo-link-console after the repository transfer」里。

<a id="影响"></a>
## 转移后、安装前的情况

- 转移完成、这个提交还没推上 master 时，工作流的部署条件仍写着旧仓库名，推送后 Verify Licensing Server 照常检查，但部署那一步会跳过，线上不变。
- `receive-release.py` 是 CI 部署工具之一。CI 会拿服务器上装的版本和本次清单里的摘要比对，不一致就拒绝部署。所以顺序和上次一样：先在服务器上装新版，再立刻把提交推上 master。
- 从装上新版到推上 master 的几分钟里，其他会话不要往 master 推授权服务或官网的改动。
- 前提：用户确认转移已经完成，并且主会话转达了对这次安装的确认。

每步都写了：做什么、备份什么、怎么验证、失败怎么回退。前一步验证没通过，就不要做下一步。第 2 步到第 4 步在同一个 SSH 会话里执行，`$stamp` 一直不变。

<a id="1-核对转移后的仓库设置管理员电脑"></a>
## 1. 核对转移后的仓库设置（管理员电脑）

```bash
gh api user --jq .login
gh repo view Fldicoahkiin/tuanbo-link-console --json nameWithOwner,viewerPermission
gh secret list --repo Fldicoahkiin/tuanbo-link-console
gh variable list --repo Fldicoahkiin/tuanbo-link-console
```

- 验证：
  - 第一条输出 `Fldicoahkiin`。
  - 第二条显示 `"nameWithOwner":"Fldicoahkiin/tuanbo-link-console"`、`"viewerPermission":"ADMIN"`。
  - secret 列表里有 `TBLINK_DEPLOY_SSH_KEY` 和 `TBLINK_DEPLOY_KNOWN_HOSTS`。
  - 变量列表里有 `TBLINK_AUTO_DEPLOY`，值为 `true`。
- 如果 secret 或变量没有随转移带过来，就停在这里，不要继续安装：
  - 部署私钥只存在于 GitHub secret 里，需要重新生成一对部署密钥，更新服务器上 tblink-deploy 的公钥，再写回 secret。这一步要单独写说明，并经用户确认后再做。
  - 变量可以用 `gh variable set TBLINK_AUTO_DEPLOY --body true --repo Fldicoahkiin/tuanbo-link-console` 补上。这也是一次 GitHub 写操作，要用户确认。
- 本机仓库的远程地址可以顺手改成新地址（旧地址 GitHub 会重定向，不改也能用）：`git remote set-url origin https://github.com/Fldicoahkiin/tuanbo-link-console`。

<a id="2-导出并只读检查"></a>
## 2. 导出原始字节，只读检查

管理员电脑上，`<提交>` 写那个 fix(deploy) 提交（如果 master 前进过，先 rebase，提交号会变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-repo-transfer"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/receive-release.py" > "$out/receive-release.py"
(cd "$out" && shasum -a 256 receive-release.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-repo-transfer && sha256sum -c SHA256SUMS
grep -c "Fldicoahkiin/tuanbo-link-console" receive-release.py
sudo sha256sum /usr/local/libexec/tblink-receive-release.py
systemctl list-units 'tblink-deploy-*' --no-legend
```

- 验证：
  - `receive-release.py: OK`；grep 输出 `1`。
  - 服务器上现装的版本，摘要与转移前 master 上的 `receive-release.py` 一致（`git show <转移前的 master>:apps/licensing-server/deploy/receive-release.py | shasum -a 256`）。
  - `tblink-deploy-*` 为空，GitHub Actions 里也没有正在运行的 Verify Licensing Server。
- 回退：只读，不需要回退。

<a id="3-备份并安装然后推-master"></a>
## 3. 备份并安装，然后推 master

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /usr/local/libexec/tblink-receive-release.py "/var/backups/tblink/install-$stamp/"
sudo flock -n /var/lib/tblink-deploy/deployment.lock install -o root -g root -m 0644 receive-release.py /usr/local/libexec/tblink-receive-release.py
sudo sha256sum /usr/local/libexec/tblink-receive-release.py "/var/backups/tblink/install-$stamp/tblink-receive-release.py"
```

`flock -n` 在 CI 正在部署时会立即失败，等它结束再试。装好后，在管理员电脑上立即推送（先确认 `gh api user --jq .login` 是 Fldicoahkiin）：

```bash
git push origin <提交>:master
```

- 备份：旧的 `tblink-receive-release.py` 存在 `/var/backups/tblink/install-$stamp/`。
- 验证：
  - 新装文件的摘要与第 2 步 `SHA256SUMS` 一致；备份的摘要与第 2 步记下的旧版一致。
  - 推送触发的 Verify Licensing Server 成功，并且「Deploy verified licensing service and website」这一步实际执行了（不是跳过）。
  - 服务器上 `sudo cat /var/lib/tblink-deploy/last-success.json` 里的 revision 是刚推的提交。
  - 最新一个 `/var/lib/tblink-deploy/jobs/*/request.json` 里的 repository 是 `Fldicoahkiin/tuanbo-link-console`。
  - 公网 `curl -fsS https://api.tuanbo-link.jinhefilm.com/health` 返回 `{"status":"ok"}`，官网首页能打开。
- 失败回退：
  ```bash
  sudo flock -n /var/lib/tblink-deploy/deployment.lock install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/tblink-receive-release.py" /usr/local/libexec/tblink-receive-release.py
  ```
  然后在 master 上 `git revert` 那个 fix(deploy) 提交并推送。回退后部署条件又变回旧仓库名，之后的推送只做检查、跳过部署，线上不变，等排查清楚再装。

<a id="4-记录"></a>
## 4. 记录

在本文末尾补一节「安装结果」，内容包括：
- 实际安装的提交号；
- `$stamp`；
- 第 1 步核对到的 secret 和变量；
- 新旧两个版本的摘要；
- 那次 CI 运行的链接和部署结果。

<a id="安装结果"></a>
## 安装结果（2026-10-24）

用户确认原话：「确认重装部署工具」（经主会话转达）。`$stamp=20261024T094314Z`。

| 步骤 | 结果 |
| --- | --- |
| 1 仓库设置 | `gh api user` 为 Fldicoahkiin；`Fldicoahkiin/tuanbo-link-console` 的权限为 ADMIN；secret 有 `TBLINK_DEPLOY_KNOWN_HOSTS`、`TBLINK_DEPLOY_SSH_KEY`；变量 `TBLINK_AUTO_DEPLOY=true` |
| 2 导出和只读检查 | 按 `c19244e` 导出，与提交里的 blob 一致，sha256 为 `ee809753da945d596be70bf62be81e521a0f1a64aa6f958e8d524c6003740759`；服务器上 `sha256sum -c` 通过，文件里有一处 `Fldicoahkiin/tuanbo-link-console`；现装版本为 `3ced4d1c31ef07b975e9ddd4362bd07cdf9fbe4c80fc6f6fe5268df0e34ed78a`，与转移前的 master 一致。上一次推送（7f5d587）的 CI 跑完、部署步骤被跳过之后才继续 |
| 3 备份、安装、推送 | 旧版备份在 `/var/backups/tblink/install-20261024T094314Z/`；持部署锁安装后为 root 644，摘要与第 2 步一致；推送前 master 没有前进，推送 `c19244e` |
| 验证 | [CI 40083075123](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/40083075123) 成功，「Deploy verified licensing service and website」这一步实际执行（不是跳过）。CI 于 17:45:55 以 tblink-deploy 登录，新的接收器核对仓库名和工具摘要后返回部署计划；生产环境已与本次构建的每个产物一致，所以没有上传、没有激活，`last-success.json` 仍是 `cc681a6`（运行 39964944249）。公网 `/health` 正常，官网 200 |

这次没有真正的激活。下一次改动授权服务、官网或后台产物的推送（例如发布 0.5.0 后更新官网下载信息）会走完整部署，届时核对 `last-success.json` 和最新任务的 `request.json` 里 repository 为 `Fldicoahkiin/tuanbo-link-console`。

