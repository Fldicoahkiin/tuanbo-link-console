# 服务器安装：更新源只保留最新版和上一版（待用户确认）

用户 2026-10-24 要求官网只保留最新的包。提交「feat(release): keep only the latest and the previous version on the update feed」改了 `publish-update.py`：

- 发布成功后，更新源只留新版和它替换掉的上一版。更早版本的安装包和 blockmap 移进这次发布回执的 `archived/`，在 `/var/backups/tblink/update-receipts/` 下，不删除，也不对外提供。
- 回滚到上一版后，撤下的版本也移进回滚回执的 `archived/`。

规则见[以后发版本的标准流程](RELEASE_CHAIN.md#以后发版本的标准流程)。

这次只重装一个文件，不新建目录，不改 systemd 单元，不重启授权服务。`publish-update.py` 不在 CI 部署工具清单里，推送不受影响。

- 第一次发布 0.5.0 时，更新源会保留 0.5.0 和它替换掉的 0.4.29，不会移出任何东西；从发布 0.5.1 起，0.4.29 才会被移出。
- 前提：用户确认这次安装，且由主会话转达原话。

每一步都写了：备份什么、怎么验证、失败怎么回退。第 1 步到第 3 步在同一个 SSH 会话里执行。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

管理员电脑上，`<提交>` 是上面那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-feed-retention"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/publish-update.py" > "$out/publish-update.py"
(cd "$out" && shasum -a 256 publish-update.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-feed-retention && sha256sum -c SHA256SUMS
grep -c "def archive_feed" publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py
sudo ls /var/lib/tblink-release/staging
systemctl is-active tblink-update-publish.path tblink-update-publish.timer
```

- 验证：
  - `publish-update.py: OK`；grep 输出 `1`。
  - 服务器上现装版本的摘要与 2026-10-23 安装记录里的 `08724d3b…` 一致。
  - staging 为空（没有等待发布的版本）。
  - 两个单元都是 `active`。
- 回退：只读，不需要回退。

<a id="2-备份并安装"></a>
## 2. 备份并安装

持发布助手自己的锁安装，避免换文件时它正在处理请求：

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /opt/tblink-licensing/publish-update.py "/var/backups/tblink/install-$stamp/"
sudo flock /var/lib/tblink-update-publish/publish.lock install -o root -g root -m 0644 publish-update.py /opt/tblink-licensing/publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py "/var/backups/tblink/install-$stamp/publish-update.py"
```

- 备份：旧版存在 `/var/backups/tblink/install-$stamp/publish-update.py`。
- 验证：新装文件的摘要与第 1 步的 `SHA256SUMS` 一致，备份的摘要与第 1 步记下的旧版一致。
- 回退：
  ```bash
  sudo flock /var/lib/tblink-update-publish/publish.lock install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/publish-update.py" /opt/tblink-licensing/publish-update.py
  ```

<a id="3-运行一次并核对状态"></a>
## 3. 运行一次，核对状态

```bash
sudo systemctl start tblink-update-publish.service
systemctl show tblink-update-publish.service --property=Result,ExecMainStatus
sudo journalctl -u tblink-update-publish.service -n 10 --no-pager
sudo cat /var/lib/tblink-update-publish/update-status.json
sudo ls /srv/tblink-updates/windows/x64/
```

- 验证：
  - `Result=success`、`ExecMainStatus=0`，日志里没有 Python 报错。
  - 状态文件的内容与安装前相同：更新源仍是 0.4.29，staging 为空。
  - 更新目录里的文件没有变化。这次运行不发布任何版本，所以不会移出文件。
- 回退：同第 2 步。

<a id="4-记录"></a>
## 4. 记录

在本文末尾补一节「安装结果」，记下实际安装的提交号、`$stamp`、新旧两个版本的摘要，以及第 3 步的输出。

第一次真正移出旧版本，会发生在发布 0.5.1 的时候。届时后台显示的结果里会写「已移出更新源：0.4.29」，再核对回执的 `archived/` 里有 0.4.29 的安装包和 blockmap。
