# 服务器安装：更新源保留每个版本的 blockmap（待用户确认）

## 为什么要装

软件内升级只下载变化的部分，前提是拿得到「当前版本」的 blockmap（约 1 MB）。软件内更新装上的电脑在本机缓存里有；从官网下载安装的电脑没有，要去更新源取。现在更新源只留最新版和上一版的文件，所以官网装的电脑一旦跳过一个版本就取不到，只能下载完整安装包。

2026-10-29 按 GitHub Releases 上的 blockmap 计算：0.5.3 升 0.5.5 本来只需下载 7.41 MB，取不到 0.5.3 的 blockmap 时要下载 981.5 MB，按更新源约 470 KB/s 是 16 秒和 35 分钟的差别。

提交「feat(release): keep every version's blockmap on the update feed」改了 `publish-update.py`：

- 发布新版时，旧版本的安装包照旧移进回执的 `archived/`，blockmap 留在更新源。每个约 1 MB，发 100 个版本约 100 MB。
- 回滚时，撤下的版本连同它的 blockmap 一起移出，这样它以后还能重新发布。
- 新增 `publish-update.py --restore-blockmaps`：把以前的发布移进回执的 blockmap 放回更新源。每个文件都要和那个版本 `release-manifest.json` 里记的 sha256 一致才放；被回滚撤下的版本不放；比当前更新源新的版本不放；已经在更新源上的不动。重复运行安全。

按[保留规则](RELEASE_CHAIN.md#以后发版本的标准流程)，归档只保留最近 3 份。现在应该还在的是：0.5.3 的发布回执里有 0.5.0 的文件，0.5.4 的里有 0.5.2 的，0.5.5 的里有 0.5.3 的。0.4.29 的已经清掉，它的客户端本来就不做差分，不用补。

GitHub Releases 上的 blockmap（2026-10-29 下载核对，与各版本的 `release-manifest.json` 一致）：

| 版本 | 字节 | sha256 |
| --- | --- | --- |
| 0.5.0 | 1,022,790 | `c61c020aacfc4ae299c207eac9795d663a4b3c5191f8033cb20525e16485a395` |
| 0.5.2 | 1,018,831 | `a4d8e78ecd94dad7150392c1c0ca6e88baf7ceae23bdf59bb6bf6aeb2e1adff6` |
| 0.5.3 | 1,018,984 | `9e430e46eefa816e8a648634296f067c867156b582f044c9a035b313b7bf8b0e` |
| 0.5.4 | 1,019,059 | `7ac9c1092e552f7b3297ac60c8f7c94050ee560df756d536ef924a4dfbf59699` |
| 0.5.5 | 1,018,900 | `6035c11a737a3dcb6773ddaadf5ecd4205e04b33ba369218182c7fabb07a6983` |

这次只重装一个文件，不新建目录，不改 systemd 单元和 Nginx，不重启授权服务。Nginx 本来就按 `Tuanbo-Link-Console-X.Y.Z-x64.exe.blockmap` 的规则对外提供任何版本的 blockmap。`publish-update.py` 不在 CI 部署工具清单里，推送不受影响。

- 前提：用户确认这次安装；装的时候没有版本正在发布（staging 为空）。最好在 0.5.6 发布之前装好，这样官网装的 0.5.2、0.5.3 电脑升 0.5.6 也只下载变化的部分。
- 每一步都写了：备份什么、怎么验证、失败怎么回退。第 1 步到第 4 步在同一个 SSH 会话里执行。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

管理员电脑上，`<提交>` 是上面那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-blockmaps"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/publish-update.py" > "$out/publish-update.py"
(cd "$out" && shasum -a 256 publish-update.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-blockmaps && sha256sum -c SHA256SUMS
grep -c "def restore_blockmaps" publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py
sudo ls /var/lib/tblink-release/staging
systemctl is-active tblink-update-publish.path tblink-update-publish.timer
sudo ls -l /srv/tblink-updates/windows/x64/
sudo sh -c 'ls -l /var/backups/tblink/update-receipts/*/archived/*.blockmap'
sudo sha256sum /var/backups/tblink/update-receipts/*/archived/*.blockmap
```

- 验证：
  - `publish-update.py: OK`；grep 输出 `1`。
  - 现装版本的摘要是 `e694b246e6a7f9e2f37b6900ab080e8b4d9e8f63ff6bf45be299d60c75e16446`（[归档清理安装记录](SERVER_INSTALL_ARCHIVE_PRUNE_20261024.md#安装结果)）。不一致就停下，先查清楚是谁改的。
  - staging 为空，两个单元都是 `active`。
  - 更新目录里只有 0.5.4、0.5.5 的安装包和 blockmap，加 `latest.yml`（0.5.5）。
  - 回执里的 blockmap 摘要和上面的表一致。记下有哪几个版本，第 3 步要用。
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
- 验证：新装文件的摘要与第 1 步的 `SHA256SUMS` 一致，备份的摘要是 `e694b246…`。
- 回退：
  ```bash
  sudo flock /var/lib/tblink-update-publish/publish.lock install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/publish-update.py" /opt/tblink-licensing/publish-update.py
  ```

<a id="3-放回旧版本的-blockmap"></a>
## 3. 放回旧版本的 blockmap

```bash
sudo /usr/bin/python3 /opt/tblink-licensing/publish-update.py --restore-blockmaps
sudo ls -l /srv/tblink-updates/windows/x64/
sudo sha256sum /srv/tblink-updates/windows/x64/*.blockmap
for v in 0.5.0 0.5.2 0.5.3; do curl -s "https://updates.tuanbo-link.jinhefilm.com/windows/x64/Tuanbo-Link-Console-$v-x64.exe.blockmap" | sha256sum; done
```

和发布服务的 `ExecStart` 一样用 `/usr/bin/python3` 运行（脚本装成 0644，不能直接执行）。

- 验证：
  - 输出 `{"restored": [...]}`，列出第 1 步在回执里看到的那几个版本（应为 0.5.0、0.5.2、0.5.3）。
  - 更新目录里这几个 blockmap 属主 root、权限 `-rw-r--r--`，摘要与上表一致。
  - 外网下载到的摘要与上表一致。
  - 再运行一次 `--restore-blockmaps`，输出 `{"restored": []}`。
- 回退：放回的 blockmap 只是公开的静态文件，不影响任何版本的安装。要撤回时移进本次的备份目录：
  ```bash
  for v in 0.5.0 0.5.2 0.5.3; do sudo mv "/srv/tblink-updates/windows/x64/Tuanbo-Link-Console-$v-x64.exe.blockmap" "/var/backups/tblink/install-$stamp/"; done
  ```

回执里缺了某个版本（例如有人在后台回滚过），就从 GitHub Releases 补：管理员电脑上 `gh release download v<版本> -R Fldicoahkiin/tuanbo-link-console -p '*.blockmap'`，核对摘要与上表一致，`scp` 到服务器，再 `sudo install -o root -g root -m 0644 <文件> /srv/tblink-updates/windows/x64/`，同样做外网摘要核对。

<a id="4-运行一次并核对状态"></a>
## 4. 运行一次发布服务，核对状态

```bash
sudo systemctl start tblink-update-publish.service
systemctl show tblink-update-publish.service --property=Result,ExecMainStatus
sudo journalctl -u tblink-update-publish.service -n 10 --no-pager
sudo cat /var/lib/tblink-update-publish/update-status.json
```

- 验证：`Result=success`、`ExecMainStatus=0`，日志里没有 Python 报错；状态文件仍是更新源 0.5.5、可以回滚到 0.5.4、staging 为空。
- 回退：同第 2 步。

<a id="5-记录"></a>
## 5. 记录

在本文末尾补一节「安装结果」，记下实际安装的提交号、`$stamp`、新旧两个版本的摘要、第 3 步放回的文件，以及第 4 步的输出。

下一次发布（0.5.6）后核对：后台结果写「已移出更新源：0.5.4」，回执的 `archived/` 里只有 0.5.4 的安装包；更新目录里 0.5.0、0.5.2～0.5.6 的 blockmap 都在。
