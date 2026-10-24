# 服务器安装：发版搬运的状态查询和 Mac 上传密钥（待用户确认）

用户 2026-10-24 要求：发版搬运不依赖工位电脑一直开着，工位电脑上线后自动同步，Mac 本地也能完成同一过程，而且要灵活、稳。搬运脚本 `scripts/relay-release.mjs` 每次运行都先查状态再做下一步，见 [README 的发布与部署链路](../README.md#发布与部署链路)。服务器上需要两处改动：

1. 重装 `receive-update.py`（提交「feat(release): relay drafts to the server from the office PC or a Mac」）：
   - `ssh tblink-release@… status` 只读返回 `{"staged": [...], "uploading": true/false}`，搬运脚本据此不重复上传；
   - 同一时间只允许一份上传：第二台机器的上传在发送前就被拒绝（`Another upload is in progress`），不会白传 1 GB；
   - 其他命令一律拒绝，上传行为和校验不变。
2. 在 `/etc/tblink-release/authorized_keys` 加一行 Mac 的上传公钥，带 `restrict`。和工位电脑那把一样，它只能运行 ForceCommand 的接收脚本：只能写 staging，碰不到更新源。

范围：
- 不改 systemd 单元，不改 sshd 配置，不重启任何服务。
- `receive-update.py` 不在 CI 部署工具清单里，推送不受影响。
- 新旧接收脚本处理上传的方式一样，旧搬运方式在安装前后都能用。

前提：用户确认这次安装，且由主会话转达原话。

每一步都写了：备份什么、怎么验证、失败怎么回退。第 1 步到第 3 步在同一个 SSH 会话里执行，`$stamp` 一直不变。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

管理员电脑（Mac）上，`<提交>` 是上面那个提交：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-relay"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/receive-update.py" > "$out/receive-update.py"
cp ~/.config/tblink-remote/tblink_release_upload.pub "$out/mac-relay.pub"
(cd "$out" && shasum -a 256 receive-update.py mac-relay.pub | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

`mac-relay.pub` 应该正好是这一行（2026-10-24 在 Mac 上生成，私钥在 `~/.config/tblink-remote/tblink_release_upload`，不进仓库）：

```text
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJh99Lucpo4ef1PwrN7Dab8D93OYO+tsSjQPOj0iAsSI tblink-release relay (Mac)
```

指纹 `SHA256:OpOekSFOu5IoguKSbM+C2JdheLaalupn6C3AlV0dFyk`。

服务器上：

```bash
cd ~/tblink-install-relay && sha256sum -c SHA256SUMS
grep -c "def status" receive-update.py
sudo sha256sum /usr/local/libexec/tblink-receive-update.py
sudo ls -l /etc/tblink-release/authorized_keys
sudo wc -l /etc/tblink-release/authorized_keys
sudo sh -c 'ls -A /var/lib/tblink-release/staging'
```

- 验证：
  - 两个文件 `OK`，grep 输出 `1`。
  - 现装的接收脚本摘要是 `6e6752355b46716552b49120c01449aa38a5db6aaa1fe93951ed7079f63a5a6f`（2026-10-23 安装、2026-10-24 核对过）。
  - `authorized_keys` 为 root 所有、0644，只有 1 行（工位电脑那把）。
  - staging 里没有 `.incoming-*`，也就是没有正在进行的上传。
- 回退：只读，不需要回退。

<a id="2-备份并安装"></a>
## 2. 备份，装接收脚本，加公钥

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /usr/local/libexec/tblink-receive-update.py /etc/tblink-release/authorized_keys "/var/backups/tblink/install-$stamp/"
sudo install -o root -g root -m 0644 receive-update.py /usr/local/libexec/tblink-receive-update.py
printf 'restrict %s\n' "$(cat mac-relay.pub)" | sudo tee -a /etc/tblink-release/authorized_keys > /dev/null
sudo sha256sum /usr/local/libexec/tblink-receive-update.py
sudo ls -l /etc/tblink-release/authorized_keys
sudo awk '{print $1, $2, $NF}' /etc/tblink-release/authorized_keys
```

- 备份：旧的接收脚本和 `authorized_keys` 都在 `/var/backups/tblink/install-$stamp/`。
- 验证：
  - 接收脚本的摘要与第 1 步的 `SHA256SUMS` 一致，root 所有、0644。
  - `authorized_keys` 仍是 root 0644，两行都以 `restrict ssh-ed25519` 开头，第二行末尾是 `(Mac)`。
- 回退：
  ```bash
  sudo cp -p "/var/backups/tblink/install-$stamp/tblink-receive-update.py" /usr/local/libexec/tblink-receive-update.py
  sudo cp -p "/var/backups/tblink/install-$stamp/authorized_keys" /etc/tblink-release/authorized_keys
  ```

<a id="3-从-mac-核对"></a>
## 3. 从 Mac 核对

在 Mac 的仓库检出里：

```bash
ssh -F none -T -i ~/.config/tblink-remote/tblink_release_upload -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.config/tblink-remote/known_hosts tblink-release@100.111.120.96 status
ssh -F none -T -i ~/.config/tblink-remote/tblink_release_upload -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.config/tblink-remote/known_hosts tblink-release@100.111.120.96 whoami; echo "exit $?"
pnpm release:relay
```

- 验证：
  - 第一条输出 `{"staged": [], "uploading": false}`。
  - 第二条输出 `{"error": "Unknown command"}`，`exit 1`：除了 `status` 和上传，别的命令都不执行。
  - 第三条最后一行是「本次同步：没有等待搬运的草稿 release」，或者有草稿时的相应结果。
  - 服务器上 `sudo journalctl _COMM=sshd-session --since -10min | grep tblink-release` 能看到这把 Mac 密钥的指纹 `SHA256:OpOekSFO…`。
- 回退：同第 2 步。

<a id="4-记录"></a>
## 4. 记录

在本文末尾补一节「安装结果」，记下：

- 实际安装的提交号和 `$stamp`；
- 接收脚本新旧两个版本的摘要；
- `authorized_keys` 新旧两个版本的行数；
- 第 3 步三条命令的输出。
