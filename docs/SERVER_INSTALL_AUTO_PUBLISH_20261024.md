# 服务器安装：staging 里的新包自动发布（待用户确认）

用户 2026-10-24 决定「打 tag 即上线」，去掉后台确认这一步。提交「feat(release): publish a staged release on its own」改了 `publish-update.py`：

- 每次运行先处理后台请求，再看 staging。
- staging 里版本最高的一份如果满足下面全部条件，就按原来的全部校验发布上线：
  - 版本高于当前更新源；
  - 以前没有发布回执；
  - 目录名里的版本与 manifest 一致。
- 每份上传只尝试一次。结果写进 `/var/lib/tblink-update-publish/auto-publish.json`、审计日志和 `update-status.json` 的 `autoPublish` 字段，后台显示为「最近一次自动发布」。
- 被回滚过的版本不再自动发布，只能在后台手动发布。

规则见[以后发版本的标准流程](RELEASE_CHAIN.md#以后发版本的标准流程)，链路和信任边界见[自动发布文档](AUTOMATED_DEPLOYMENT.md#windows-更新发布打-tag-即上线)。

范围：
- 这次只重装 `publish-update.py`，不新建目录，不改 systemd 单元，不重启授权服务。`tblink-update-publish.path` 已经在监视 staging，新包一到就会触发。
- `publish-update.py` 不在 CI 部署工具清单里，推送不受影响。
- 后台显示「最近一次自动发布」的改动随普通推送由 CI 部署。新旧后台都能读新脚本写的状态文件，先装哪个都可以。

> 注意：装好后的第一次运行就会自动发布 staging 里符合条件的包。安装前在第 1 步确认 staging 的内容：要么为空，要么就是准备上线的那一份。

前提：用户确认这次安装，且由主会话转达原话。

每一步都写了：备份什么、怎么验证、失败怎么回退。第 1 步到第 3 步在同一个 SSH 会话里执行。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

管理员电脑上，`<提交>` 是上面那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-auto-publish"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/publish-update.py" > "$out/publish-update.py"
(cd "$out" && shasum -a 256 publish-update.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-auto-publish && sha256sum -c SHA256SUMS
grep -c "def auto_publish" publish-update.py
sudo sha256sum /opt/tblink-licensing/publish-update.py
sudo sh -c 'ls -la /var/lib/tblink-release/staging'
sudo cat /var/lib/tblink-update-publish/update-status.json
systemctl is-active tblink-update-publish.path tblink-update-publish.timer
```

- 验证：
  - `publish-update.py: OK`，grep 输出 `1`。
  - 现装版本的摘要是 `2f82f81035ccd5007338e94d243bb36910a3c16256c2a37f8afbe7902ce053ee`，与[更新源保留规则的安装记录](SERVER_INSTALL_FEED_RETENTION_20261024.md#安装结果)一致。
  - staging 为空，或者只有准备上线的那一份。
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
- 验证：新装文件的摘要与第 1 步的 `SHA256SUMS` 一致，备份的摘要是 `2f82f810…`。
- 回退：
  ```bash
  sudo flock /var/lib/tblink-update-publish/publish.lock install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/publish-update.py" /opt/tblink-licensing/publish-update.py
  ```
  新脚本留下的 `auto-publish.json` 旧脚本不读，可以留着。

<a id="3-运行一次并核对状态"></a>
## 3. 运行一次，核对状态

```bash
sudo systemctl start tblink-update-publish.service
systemctl show tblink-update-publish.service --property=Result,ExecMainStatus
sudo journalctl -u tblink-update-publish.service -n 10 --no-pager
sudo cat /var/lib/tblink-update-publish/update-status.json
sudo ls /srv/tblink-updates/windows/x64/
sudo tail -n 3 /var/backups/tblink/update-audit.jsonl
```

- 验证：
  - `Result=success`、`ExecMainStatus=0`，日志里没有 Python 报错。
  - 状态文件多了 `autoPublish` 字段。staging 为空时它是 `null`，更新源和更新目录都没有变化。
  - staging 里有准备上线的那一份时：`autoPublish.ok` 为 `true`，消息是「已自动发布 X」；更新源换成新版本；审计日志最后一行是 `auto-publish`。
- 回退：同第 2 步。已经自动上线的版本，用后台「回滚到上一版」撤回。

<a id="4-记录"></a>
## 4. 记录

在本文末尾补一节「安装结果」，记下：

- 实际安装的提交号和 `$stamp`；
- 新旧两个版本的摘要；
- 第 1 步看到的 staging 内容；
- 第 3 步的输出。

<a id="安装结果"></a>
## 安装结果

2026-10-24 由主会话执行（用户在主会话里直接确认「确认服务器改动」）。

- 安装的字节：`publish-update.py` 来自提交 987ae61（与当时 master 一致），sha256 `3ccb805f2d9a6e34ab1177f470f8b27b0eee228dd465e059bfbdc98c817bc7f6`。
- `$stamp`：`20261024T141728Z`；旧版备份 `/var/backups/tblink/install-20261024T141728Z/publish-update.py`，sha256 `2f82f81035ccd5007338e94d243bb36910a3c16256c2a37f8afbe7902ce053ee`，与更新源保留规则的安装记录一致。
- 第 1 步：`publish-update.py: OK`，`def auto_publish` 计数 1；staging 为空；path 和 timer 都是 active。
- 第 3 步：`Result=success`、`ExecMainStatus=0`；状态文件：更新源 0.4.29（未签名）、staging 为空、`autoPublish` 为空；更新目录没有变化。
