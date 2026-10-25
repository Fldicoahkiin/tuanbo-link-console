# 服务器安装：旧版归档只留 3 份，磁盘余量不足时拒绝发布（待用户确认）

每发一版，`publish-update.py` 都会把移出更新源的旧安装包和 blockmap 复制进那次回执的 `archived/`（`/var/backups/tblink/update-receipts/`），之前从不清理。每份约 1 GB，服务器磁盘不大，发几版就可能写满，自动发布也会跟着失败。提交「feat(release): keep three update archives and refuse to publish on a nearly full disk」改了两处：

- 每次发布或回滚之后，只保留最近 3 份回执的 `archived/`，更早回执的 `archived/` 删除。回执里的 `receipt.json`、`previous-latest.yml` 等小文件都留着，所以发布历史、「发布过的版本不再自动发布」的判断和一步回滚都不受影响。删了哪些写在新回执的 `prunedArchives` 里。
- 开始复制之前，检查工作目录、更新源和回执所在的磁盘，只要有一个余量低于 5 GB，就拒绝发布。结果里会写明「磁盘余量不足：哪个目录只剩多少 GB」，后台「最近一次自动发布」能看到。自动发布这样失败后不会自己再试（和其他失败一样），清出空间后在后台「软件更新」里手动发布。回滚不受这个限制。

这次只重装一个文件，不新建目录，不改 systemd 单元，不重启授权服务。`publish-update.py` 不在 CI 部署工具清单里，推 master 不受影响。

- 时机：staging 为空、没有发布正在进行时再装，不要在发布进行中换文件。
- 前提：用户确认这次安装。
- 所有命令在 Mac 上用 `ssh -F ~/.config/tblink-remote/ssh_config tblink-server` 连接执行。第 1 步到第 3 步在同一个 SSH 会话里执行。

每一步都写了：备份什么、怎么验证、失败怎么回退。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

Mac 上，`<提交>` 是上面那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-archive-prune"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/publish-update.py" > "$out/publish-update.py"
(cd "$out" && shasum -a 256 publish-update.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-archive-prune && sha256sum -c SHA256SUMS
grep -c "def prune_archives\|def require_free_space" publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py
sudo ls /var/lib/tblink-release/staging
systemctl is-active tblink-update-publish.path tblink-update-publish.timer
df -h /srv/tblink-updates/windows/x64 /var/backups/tblink /var/lib/tblink-update-publish
sudo sh -c 'ls -d /var/backups/tblink/update-receipts/*/archived; du -sh /var/backups/tblink/update-receipts'
```

- 验证：
  - `publish-update.py: OK`；grep 输出 `2`。
  - 现装版本的摘要是 `3ccb805f2d9a6e34ab1177f470f8b27b0eee228dd465e059bfbdc98c817bc7f6`（[自动发布安装记录](SERVER_INSTALL_AUTO_PUBLISH_20261024.md#安装结果)）。不一致就停下，先查清楚是谁改的。
  - staging 为空（没有等待发布的版本）。
  - 两个单元都是 `active`。
  - 记下 `df` 的余量和带 `archived` 的回执数量，第 4 步要写进记录。余量已经低于 5 GB 的话，装完之后下一次发布会被拒绝，先清理再发版。
- 回退：只读，不需要回退。

<a id="2-备份并安装"></a>
## 2. 备份并安装

持发布脚本自己的锁安装，避免换文件时它正在处理请求：

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /opt/tblink-licensing/publish-update.py "/var/backups/tblink/install-$stamp/"
sudo flock /var/lib/tblink-update-publish/publish.lock install -o root -g root -m 0644 publish-update.py /opt/tblink-licensing/publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py "/var/backups/tblink/install-$stamp/publish-update.py"
```

- 备份：旧版存在 `/var/backups/tblink/install-$stamp/publish-update.py`。
- 验证：新装文件的摘要与第 1 步的 `SHA256SUMS` 一致，备份的摘要是 `3ccb805f…`。
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
sudo sh -c 'ls -d /var/backups/tblink/update-receipts/*/archived'
```

- 验证：
  - `Result=success`、`ExecMainStatus=0`，日志里没有 Python 报错。
  - 状态文件的内容与安装前相同：更新源版本不变，staging 为空。
  - 更新目录和带 `archived` 的回执都没有变化。这次运行不发布也不回滚，所以不会清理任何归档。
- 回退：同第 2 步。

<a id="4-记录"></a>
## 4. 记录

在本文末尾补一节「安装结果」，记下实际安装的提交号、`$stamp`、新旧两个版本的摘要、第 1 步的磁盘余量和归档数量，以及第 3 步的输出。

第一次真正清理，会发生在带 `archived` 的回执超过 3 份之后的那次发布。届时新回执的 `receipt.json` 里 `prunedArchives` 会列出被清理的回执名，核对那些回执只剩 `receipt.json` 等小文件、`archived/` 已不存在。
