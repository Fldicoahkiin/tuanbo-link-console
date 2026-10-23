# 服务器安装：更新发布与 root 备份加固（2026-10-23，待用户确认）

这份说明一次装完两件事：

- Windows 更新发布：上传身份 tblink-release、发布助手 `publish-update.py` 和后台「软件更新」。设计见[自动发布文档](AUTOMATED_DEPLOYMENT.md#windows-更新发布staging-与后台确认)。
- root 备份加固：部署和运维工具的 root 备份移到 `/var/backups/tblink`；回滚前核对摘要；备份配置和巡检令牌不再信任服务账号的目录。路径清单见[部署和运维工具的 root 路径](AUTOMATED_DEPLOYMENT.md#部署和运维工具的-root-路径)和[发布助手的 root 路径](AUTOMATED_DEPLOYMENT.md#root-写入和信任判断的路径)。

<a id="安装来源"></a>
## 安装来源

- 涉及的提交（按标题）：
  - 已在 master 上：「fix(release)!: keep what the root update publisher writes or trusts in root-owned directories」（发布助手和上传接收器）。
  - 安装前不推 master：「fix(release): keep update receipts and the update audit in root's backups」「fix(deploy): write deployment backups only below root-owned directories」「fix(ops): read the backup recipient and the admin token without trusting the licensing account's directories」和本说明所在的文档提交。原因见[第 3 步](#3-安装两个-ci-部署工具然后推-master)。
- 第 0 步导出时，用本说明所在的那个提交（下文记作 `<提交>`）。安装前 master 如果前进了，先把这几个提交 rebase 上去：提交号会变，工具文件的字节不变，第 3 步会核对这一点。实际使用的提交号记在[第 9 步](#9-记录)。

<a id="影响"></a>
## 对线上的影响

- 第 3 步推 master 后，CI 会照常做一次授权服务和官网的部署：维护页约十几秒，与平时每次部署相同。
- 第 7 步重启授权服务一次，中断约 1 秒。
- 第 5 步 reload sshd，已经连着的 SSH 会话不会断。
- 从第 3 步装上工具到推上 master 的这几分钟里，其他会话不要往 master 推授权服务或官网的改动；否则那次 CI 部署会因为工具摘要不一致被拒绝，不过不会改动线上。

每一步都写了：做什么、备份什么、怎么验证、失败怎么回退。前一步验证没通过，就不要做下一步。第 1 步到第 7 步在同一个 SSH 会话里执行，`$stamp` 一直不变。

<a id="0-导出原始字节管理员电脑"></a>
## 0. 导出原始字节（管理员电脑）

工具都按 git 原始字节安装。不要从 Windows 工作区复制文件，CRLF 会让摘要不一致。

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-20261023"; mkdir -p "$out"
for f in activate-release.py publish-website.py backup-console.py payment-exceptions.py publish-update.py receive-update.py \
         tblink-update-publish.path tblink-update-publish.service tblink-update-publish.timer tblink-release.sshd.conf; do
  git show "$c:apps/licensing-server/deploy/$f" > "$out/$f"
done
git show "$c:apps/desktop/src/main/link/release-public-keys.json" > "$out/release-public-keys.json"
# 构建机上传公钥（D:\tblink-release-signing\upload\tblink-release-ed25519.pub，只是公钥），行首加 restrict：
printf 'restrict %s\n' "$(cat <拷到本机的 tblink-release-ed25519.pub>)" > "$out/authorized_keys"
(cd "$out" && shasum -a 256 * | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

- 验证：`SHA256SUMS` 有 12 行，`authorized_keys` 只有一行，以 `restrict ssh-ed25519 ` 开头。
- 回退：这一步只在本机生成文件，不需要回退。

<a id="1-只读检查"></a>
## 1. 只读检查

```bash
cd ~/tblink-install-20261023 && sha256sum -c SHA256SUMS
sudo stat -c '%U:%G %a %F %n' /var/backups /var/lib/tblink-licensing /etc/tblink-licensing/service.env /etc/tblink-licensing/admin-token.txt
systemctl is-active tblink-licensing nginx tblink-delivery-recovery.timer
systemctl list-units 'tblink-deploy-*' --no-legend
sudo sha256sum /opt/tblink-licensing/activate-release.py /opt/tblink-licensing/publish-website.py /opt/tblink-licensing/backup-console.py /opt/tblink-licensing/payment-exceptions.py
```

- 验证：
  - 12 个文件都是 `OK`。
  - `/var/backups` 是 `root:root 755 directory`；`/var/lib/tblink-licensing` 是 `tblink-license:tblink-license 700 directory`。
  - `service.env` 和 `admin-token.txt` 都是 `tblink-license:tblink-license 600 regular file`（如果显示 symbolic link 就停下）。
  - 三个服务都是 `active`，`tblink-deploy-*` 为空，说明没有正在进行的 CI 部署。GitHub Actions 里也不应有正在运行的 Verify Licensing Server。
  - 记下现有四个工具的摘要，第 2 步的备份要与它们一致。
- 回退：只读，不需要回退。

<a id="2-建-root-备份目录并备份现有文件"></a>
## 2. 建 root 备份目录，并备份现有文件

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 /var/backups/tblink /var/backups/tblink/update-receipts /var/backups/tblink/console "/var/backups/tblink/install-$stamp"
sudo cp -p /opt/tblink-licensing/activate-release.py /opt/tblink-licensing/publish-website.py /opt/tblink-licensing/backup-console.py \
  /opt/tblink-licensing/payment-exceptions.py /etc/tblink-licensing/service.env "/var/backups/tblink/install-$stamp/"
sudo sh -c "cd /var/backups/tblink/install-$stamp && sha256sum * | tee SHA256SUMS"
```

- 备份：现有四个工具和 `service.env`，放在 `/var/backups/tblink/install-$stamp/`。
- 验证：
  - `sudo stat -c '%U:%G %a %n' /var/backups/tblink /var/backups/tblink/*` 全部是 `root:root 700`。
  - 四个工具的摘要与第 1 步记下的一致。
- 回退：线上没有任何改动。新建的目录留着即可。

<a id="3-安装两个-ci-部署工具然后推-master"></a>
## 3. 安装两个 CI 部署工具，然后推 master

CI 部署会把服务器上的 `activate-release.py`、`publish-website.py`、`publish-console.py`、`receive-release.py` 与本次 CI 清单里的摘要比对，不一致就拒绝部署。`/etc/tblink-deploy/policy.json` 只记录两份 Nginx 配置的摘要，这次不用改。所以顺序必须是：先在服务器装新工具，再立刻把提交推上 master，让 CI 清单与服务器一致。

服务器上（持部署锁；CI 正在部署时 `flock -n` 会立即失败，等它结束再试）：

```bash
sudo flock -n /var/lib/tblink-deploy/deployment.lock sh -c \
  'install -o root -g root -m 0644 activate-release.py /opt/tblink-licensing/activate-release.py && install -o root -g root -m 0755 publish-website.py /opt/tblink-licensing/publish-website.py'
sudo sha256sum /opt/tblink-licensing/activate-release.py /opt/tblink-licensing/publish-website.py
```

管理员电脑上（先确认 `gh api user --jq .login` 是 Fldicoahkiin）：

```bash
git -C <仓库> show <提交>:apps/licensing-server/deploy/activate-release.py | shasum -a 256   # 与服务器上装的一致
git -C <仓库> push origin <提交>:master
```

- 备份：第 2 步已经备份了旧的两个工具。
- 验证：
  - 推送触发的 Verify Licensing Server 全部成功，包括「Deploy verified licensing service and website」这一步。
  - 服务器上 `sudo cat /var/lib/tblink-deploy/last-success.json` 里的 revision 是刚推的提交。
  - `sudo ls /var/backups/tblink` 多出这次部署的 `<时间>` 和 `<时间>-website` 两个目录；`sudo ls -t /var/lib/tblink-licensing/backups | head -3` 没有比 `$stamp` 更新的条目。
  - `curl -fsS https://api.tuanbo-link.jinhefilm.com/health` 返回 `{"status":"ok"}`，官网首页能打开。
- 失败回退：
  - 激活失败时，`activate-release.py` 会自己把上一版代码、环境和 Nginx 装回去。如果它报「Backup … differs from the files checked at activation start」，说明备份被改过：线上停在维护页，补交付定时器 `tblink-delivery-recovery.timer` 也保持停止。不要重试，把这条报错带回来人工处理；处理完要手工 `sudo systemctl start tblink-delivery-recovery.timer`。
  - 恢复旧工具：
    ```bash
    sudo flock -n /var/lib/tblink-deploy/deployment.lock sh -c "install -o root -g root -m 0644 /var/backups/tblink/install-$stamp/activate-release.py /opt/tblink-licensing/activate-release.py && install -o root -g root -m 0755 /var/backups/tblink/install-$stamp/publish-website.py /opt/tblink-licensing/publish-website.py"
    ```
  - 恢复旧工具后，在 master 上 `git revert` 那个「fix(deploy): write deployment backups only below root-owned directories」提交并推送，让 CI 清单回到旧工具，否则之后的部署都会被拒绝。

<a id="4-安装运维工具"></a>
## 4. 安装运维工具

```bash
sudo install -d -o root -g root -m 0755 /etc/tblink-backup
sudo install -o root -g root -m 0644 payment-exceptions.py backup-console.py /opt/tblink-licensing/
sudo sha256sum /opt/tblink-licensing/payment-exceptions.py /opt/tblink-licensing/backup-console.py
sudo python3 /opt/tblink-licensing/payment-exceptions.py --after 0 > /dev/null && echo token-ok
```

- 备份：第 2 步已备份旧版。
- 验证：
  - 摘要与第 0 步一致。
  - 输出 `token-ok`：root 能按新规则读到巡检令牌。这条命令只读一页异常订单，输出被丢弃，不会打印到屏幕。
  - 补交付定时器每分钟运行一次（以 tblink-license 身份）。等一分钟后执行 `sudo journalctl -u tblink-delivery-recovery.service --since "-3 min" --no-pager | tail -5`，不应出现 `Admin token file`。
  - 加密备份目前没有启用（服务器上没有 `backup.json`，也没有装备份定时器），不要手工运行 `backup-console.py`：没有配置时它会往数据库写一条失败状态。以后启用时，配置放在 `/etc/tblink-backup/backup.json`（root 0600），见[运营后台文档](OPERATIONS_CONSOLE.md#加密备份回滚与维护)。
- 回退：
  ```bash
  sudo install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/payment-exceptions.py" "/var/backups/tblink/install-$stamp/backup-console.py" /opt/tblink-licensing/
  ```

<a id="5-更新发布上传身份"></a>
## 5. 更新发布：上传身份

```bash
# 登录 shell 必须是 /bin/sh：sshd 通过它执行 ForceCommand，nologin 会直接退出。限制来自 Match 块和 authorized_keys 的 restrict。
sudo useradd --system --user-group --home-dir /var/lib/tblink-release --no-create-home --shell /bin/sh tblink-release
sudo install -d -o root -g root -m 0755 /var/lib/tblink-release
sudo install -d -o tblink-release -g tblink-release -m 0750 /var/lib/tblink-release/staging
sudo install -d -o root -g root -m 0755 /etc/tblink-release
sudo install -o root -g root -m 0644 authorized_keys /etc/tblink-release/authorized_keys
sudo install -o root -g root -m 0644 receive-update.py /usr/local/libexec/tblink-receive-update.py
sudo install -o root -g root -m 0644 tblink-release.sshd.conf /etc/ssh/sshd_config.d/71-tblink-release.conf
sudo sshd -t && sudo systemctl reload ssh
```

- 备份：这一步只新增文件和账号，不覆盖已有内容。
- 验证：
  - `getent passwd tblink-release` 以 `:/bin/sh` 结尾。
  - `sudo sshd -T -C user=tblink-release,host=probe,addr=127.0.0.1 | grep -i -E 'forcecommand|authorizedkeysfile'` 显示接收器和 `/etc/tblink-release/authorized_keys`。
  - 另开一个 SSH 窗口确认管理员仍能登录，再关闭当前会话。
  - 真实的上传探测在[第 8 步](#8-上传身份探测)。
- 回退（不删账号，只让它无法登录）：
  ```bash
  sudo mv /etc/ssh/sshd_config.d/71-tblink-release.conf "/var/backups/tblink/install-$stamp/" && sudo sshd -t && sudo systemctl reload ssh
  sudo usermod --lock tblink-release
  ```

<a id="6-更新发布发布助手"></a>
## 6. 更新发布：发布助手

```bash
sudo install -o root -g root -m 0644 publish-update.py release-public-keys.json /opt/tblink-licensing/
sudo install -d -o root -g tblink-license -m 0750 /var/lib/tblink-update-publish /var/lib/tblink-update-publish/results
sudo install -d -o root -g root -m 0700 /var/lib/tblink-update-publish/work
sudo install -d -o tblink-license -g tblink-license -m 0700 /var/lib/tblink-licensing/update-requests
sudo install -o root -g root -m 0644 tblink-update-publish.path tblink-update-publish.service tblink-update-publish.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tblink-update-publish.path tblink-update-publish.timer
sudo systemctl start tblink-update-publish.service
```

- 备份：服务器上原来没有这些文件。
- 验证：
  - `sudo stat -c '%U:%G %a %n' /var/lib/tblink-update-publish/update-status.json` 是 `root:tblink-license 640`。
  - `sudo cat /var/lib/tblink-update-publish/update-status.json` 显示 feed 为 0.4.29、`signed: false`，rollback 的 issue 为「没有可以回滚到的上一版」，staged 为空。
  - `sudo journalctl -u tblink-update-publish.service -n 20 --no-pager` 里没有「目录不安全」「目录缺失」或 Python 报错。
  - `systemctl is-active tblink-update-publish.path tblink-update-publish.timer` 都是 `active`。
- 回退：
  ```bash
  sudo systemctl disable --now tblink-update-publish.path tblink-update-publish.timer
  ```
  其余文件不再被调用，可以留着。

<a id="7-后台开启软件更新"></a>
## 7. 后台开启「软件更新」

```bash
# /etc/tblink-licensing 归服务账号：先确认 service.env 仍是普通文件（输出以 regular file 开头），再追加。
sudo stat -c '%F %U:%G %a' /etc/tblink-licensing/service.env
printf '%s\n' 'UPDATE_REQUEST_DIRECTORY=/var/lib/tblink-licensing/update-requests' 'UPDATE_PUBLISHER_DIRECTORY=/var/lib/tblink-update-publish' \
  | sudo tee -a /etc/tblink-licensing/service.env
sudo systemctl restart tblink-licensing
```

- 备份：第 2 步已备份 `service.env`。
- 验证：
  - `systemctl is-active tblink-licensing` 是 `active`。
  - `curl -fsS http://127.0.0.1:8787/health` 返回 `{"status":"ok"}`。
  - 管理员登录后台，打开「软件更新」，显示当前版本 0.4.29、没有待发布版本，不再提示「本服务器未启用更新发布」。
- 回退：
  ```bash
  sudo install -o tblink-license -g tblink-license -m 0600 "/var/backups/tblink/install-$stamp/service.env" /etc/tblink-licensing/service.env && sudo systemctl restart tblink-licensing
  ```

<a id="8-上传身份探测"></a>
## 8. 上传身份探测

和 tblink-deploy 一样，要确认任意命令都只能跑到接收器。在构建机上用上传私钥执行（`-n` 让 stdin 立即结束，否则接收器会一直等上传）：

```powershell
ssh -n -i D:\tblink-release-signing\upload\tblink-release-ed25519 -o IdentitiesOnly=yes -o UserKnownHostsFile=D:\tblink-release-signing\upload\known_hosts tblink-release@123.206.229.200 id
```

- 预期：标准输出为空，没有 `uid=` 这类 shell 输出；标准错误是 `{"error": "empty file"}`；退出码 1。服务器上 `sudo ls -A /var/lib/tblink-release/staging` 仍为空。
- 时序：[构建机准备第 3 步](RELEASE_BUILDER_SETUP.md#3-给-runner-账号开权限)会把上传私钥的属主改成 tblink-runner、只给它读权限，之后 WYZB 再用这把钥匙会被 OpenSSH 的权限检查拒绝。所以探测要在那一步之前做。如果那一步已经做完，就以第一次 Release Windows 的上传步骤作为探测（日志里应有 `staged` 结果），并在服务器上确认 staging 出现对应条目。
- 失败回退：如果输出了 shell 内容，立即按第 5 步的回退让账号不能登录，再排查。

<a id="9-记录"></a>
## 9. 记录

安装完成后，在本文末尾补一节「安装结果」，内容包括：
- 实际安装的提交号；
- `$stamp`；
- 第 0 步的 `SHA256SUMS`；
- 每一步的验证输出摘要；
- 第 3 步那次 CI 运行的链接；
- 探测结果。

旧的备份仍在 `/var/lib/tblink-licensing/backups/`，不移动也不删除。之后新的备份都在 `/var/backups/tblink/`。
