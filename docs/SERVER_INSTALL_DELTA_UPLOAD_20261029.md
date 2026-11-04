# 服务器安装：搬运只传变化的部分（2026-11-04，已安装）

## 为什么要装

发版时，搬运脚本要先从 GitHub 下载约 982 MB 的完整安装包，再整个上传到服务器。0.5.4 草稿到上线等了 8 个多小时，0.5.5 搬运用了 58 分钟，大部分时间花在这两段传输上。

提交「feat(release): relay only the blocks the feed's installer lacks」改了两处：

- 服务器接收脚本 `receive-update.py`：除了完整的四个文件，还接受「变化部分」：一份说明加上更新源当前版没有的块。它按说明从更新源上的当前版安装包复制其余的块，拼出新安装包，再和完整上传一样按 `release-manifest.json` 核对大小和 sha256。对不上就拒收、什么都不写，并在报错里告诉搬运脚本可以改传完整安装包。它对更新源只读，拼包时只打开 `/srv/tblink-updates/windows/x64/` 里名字形如 `Tuanbo-Link-Console-X.Y.Z-x64.exe` 的普通文件，不跟随链接。`status` 多返回一项 `"delta": "tblink-installer-delta-1"`，搬运脚本据此判断能不能只传变化部分。
- 搬运脚本 `relay-release.mjs`（和它用的 `github-releases.mjs`）：服务器能拼时，只从草稿里按范围下载这些块，打成变化部分上传；服务器不能拼或拼不出来，就在同一次运行里改为下载、上传完整安装包。

2026-10-29 用 GitHub Releases 上真实的 0.5.4、0.5.5 试过：变化部分从 GitHub 分 11 段下载，共 7.4 MB，用了 4 秒；上传的 tar 是 8.4 MB（含 1 MB 的 blockmap），原来是 982 MB；接收脚本用 0.5.4 拼出的 0.5.5 与构建清单的 sha256 `aaa9f442…1706` 一致。

发布脚本 `publish-update.py` 不变，仍然把 staging 里的四个文件复制一份，重新核对 manifest、sha256、`latest.yml` 和 Ed25519 发布签名，全部通过才上线。所以接收脚本拼错了也发不出去。

新旧两边互相兼容：没装新接收脚本时，新搬运脚本看不到 `delta`，照旧传完整安装包；装了以后，没更新的旧搬运脚本照旧传完整安装包，新接收脚本照收。

- 这次只重装一个文件 `/usr/local/libexec/tblink-receive-update.py`，不新建目录、不改 sshd、systemd、Nginx，不重启任何服务。`receive-update.py` 不在 CI 部署工具清单里，推送不受影响。
- 磁盘：变化部分上传时，staging 里只多出约 10 MB 的 tar 和拼出的约 1 GB 安装包；完整上传时是约 1 GB 的 tar 加约 1 GB 解出的文件，比原来少。
- 前提：用户确认这次安装；装的时候没有版本正在上传或发布（staging 为空）。可以和[保留 blockmap 的安装](SERVER_INSTALL_BLOCKMAPS_20261029.md)在同一个 SSH 会话里先后做。
- 每一步都写了：备份什么、怎么验证、失败怎么回退。第 1 步到第 4 步在同一个 SSH 会话里执行。

<a id="1-导出并只读检查"></a>
## 1. 导出原始字节，只读检查

管理员电脑上，`<提交>` 是上面那个提交（如果 master 前进过，提交号可能变，文件字节不变）：

```bash
c=<提交>
out="$(mktemp -d)/tblink-install-delta"; mkdir -p "$out"
git show "${c}:apps/licensing-server/deploy/receive-update.py" > "$out/receive-update.py"
(cd "$out" && shasum -a 256 receive-update.py | tee SHA256SUMS)
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:
```

服务器上：

```bash
cd ~/tblink-install-delta && sha256sum -c SHA256SUMS
grep -c "def rebuild" receive-update.py
sudo sha256sum /usr/local/libexec/tblink-receive-update.py
sudo -u tblink-release env SSH_ORIGINAL_COMMAND=status /usr/bin/python3 /usr/local/libexec/tblink-receive-update.py
sudo -u tblink-release head -c 2 /srv/tblink-updates/windows/x64/latest.yml; echo
```

- 验证：
  - `receive-update.py: OK`；grep 输出 `1`。
  - 现装版本的摘要是 `c78f6df74e96bb46420c4039afd86e676fa91352eaa16c2f0ffd0f6981f6a70b`（[搬运安装记录](SERVER_INSTALL_RELAY_20261024.md)，提交 bc7045f，之后没改过）。不一致就停下，先查清楚是谁改的。
  - `status` 输出 `{"staged": [], "uploading": false}`，没有 `delta`。staging 不为空或正在上传就等它发布完再装。
  - 最后一行输出 `ve`：tblink-release 读得到更新源（目录 root:root 0755，文件 0644）。
- 回退：只读，不需要回退。

<a id="2-备份并安装"></a>
## 2. 备份并安装

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ); echo "$stamp"
sudo install -d -o root -g root -m 0700 "/var/backups/tblink/install-$stamp"
sudo cp -p /usr/local/libexec/tblink-receive-update.py "/var/backups/tblink/install-$stamp/"
sudo install -o root -g root -m 0644 receive-update.py /usr/local/libexec/tblink-receive-update.py
sudo sha256sum /usr/local/libexec/tblink-receive-update.py "/var/backups/tblink/install-$stamp/tblink-receive-update.py"
```

和 sshd 的 `ForceCommand` 一样用 `/usr/bin/python3` 运行，所以装成 0644 就够。`install` 换的是新文件，正在运行的上传（第 1 步已确认没有）不受影响。

- 备份：旧版存在 `/var/backups/tblink/install-$stamp/tblink-receive-update.py`。
- 验证：新装文件的摘要与第 1 步的 `SHA256SUMS` 一致，备份的摘要是 `c78f6df7…`。
- 回退：
  ```bash
  sudo install -o root -g root -m 0644 "/var/backups/tblink/install-$stamp/tblink-receive-update.py" /usr/local/libexec/tblink-receive-update.py
  ```

<a id="3-核对状态和拼包"></a>
## 3. 核对 `status` 和拼包

```bash
sudo -u tblink-release env SSH_ORIGINAL_COMMAND=status /usr/bin/python3 /usr/local/libexec/tblink-receive-update.py
sudo -u tblink-release /usr/bin/python3 -I - <<'EOF'
import hashlib, importlib.util, io, json, re, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('receive_update', '/usr/local/libexec/tblink-receive-update.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
base = re.search(r'^path: (.+)$', (r.FEED / 'latest.yml').read_text(), re.M).group(1)
size = (r.FEED / base).stat().st_size
n = 1024 * 1024
delta = json.dumps({'format': r.DELTA_FORMAT, 'base': {'file': base, 'size': size}, 'size': 2 * n + 3, 'ops': [[0, size - n, n], [1, 3], [0, 0, n]]}).encode() + b'\nabc'
with open(r.FEED / base, 'rb') as installer:
    installer.seek(size - n)
    expected = installer.read(n) + b'abc'
    installer.seek(0)
    expected += installer.read(n)
with tempfile.TemporaryDirectory() as directory:
    result = r.rebuild(io.BytesIO(delta), len(delta), Path(directory) / 'rebuilt')
    same = (Path(directory) / 'rebuilt').read_bytes() == expected and result['sha256'] == hashlib.sha256(expected).hexdigest()
print(json.dumps({'base': result['base'], 'bytes': result['bytes'], 'same': same}))
EOF
sudo ls -A /var/lib/tblink-release/staging
```

第二条以 tblink-release 身份，用当前更新源的安装包拼一份 2 MB 的测试文件（末尾 1 MB、3 个字节、开头 1 MB），写在它自己的临时目录里，结束时自动清掉。它不经过 `receive()`，不碰 staging，也就不会触发发布。

- 验证：
  - `status` 输出 `{"staged": [], "uploading": false, "delta": "tblink-installer-delta-1"}`。
  - 拼包输出 `{"base": "Tuanbo-Link-Console-<当前版本>-x64.exe", "bytes": 2097155, "same": true}`。
  - staging 里只有 `.upload.lock`。
- 回退：同第 2 步。

<a id="4-更新搬运脚本"></a>
## 4. 更新搬运脚本

这一步不改服务器。

- Mac：仓库检出更新到包含这个提交的 master 即可（`git pull --ff-only`），`pnpm release:relay` 用的就是检出里的脚本。
- 工位电脑（在线时）：管理员电脑上把两个脚本导出，先备份旧的，再放进 `D:\tblink-relay\` 和 `D:\tblink-builder-setup\`，后者是为了以后再运行 `setup-relay.ps1` 时不被旧版本覆盖：
  ```bash
  c=<提交>
  out="$(mktemp -d)/tblink-relay-scripts"; mkdir -p "$out"
  for f in relay-release.mjs github-releases.mjs; do git show "${c}:scripts/$f" > "$out/$f"; done
  (cd "$out" && shasum -a 256 relay-release.mjs github-releases.mjs | tee SHA256SUMS)
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  ssh -F ~/.config/tblink-remote/ssh_config win "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force D:/tblink-relay/backup-$stamp; Copy-Item D:/tblink-relay/relay-release.mjs,D:/tblink-relay/github-releases.mjs D:/tblink-relay/backup-$stamp/\""
  for d in D:/tblink-relay/ D:/tblink-builder-setup/; do scp -F ~/.config/tblink-remote/ssh_config "$out/relay-release.mjs" "$out/github-releases.mjs" "win:$d"; done
  ssh -F ~/.config/tblink-remote/ssh_config win "powershell -NoProfile -Command \"Get-FileHash -Algorithm SHA256 D:/tblink-relay/relay-release.mjs,D:/tblink-relay/github-releases.mjs,D:/tblink-builder-setup/relay-release.mjs,D:/tblink-builder-setup/github-releases.mjs | Format-Table -AutoSize Hash,Path\""
  ```
  计划任务下次运行就用新脚本，不用重装任务。工位电脑不在线就先跳过，旧脚本照旧传完整安装包，上线后再做。
- 验证：四个文件的摘要（小写比对）与 `SHA256SUMS` 一致；`D:\tblink-relay\logs\` 下一次运行的日志里没有报错（没有草稿时是「没有等待搬运的草稿 release」）。
- 回退：把 `D:\tblink-relay\backup-$stamp\` 里的两个文件复制回 `D:\tblink-relay\` 和 `D:\tblink-builder-setup\`。

<a id="5-记录"></a>
## 5. 记录

在本文末尾补一节「安装结果」，记下实际安装的提交号、`$stamp`、新旧两个版本的摘要、第 3 步的输出，以及第 4 步更新了哪几台机器。

下一次发布（0.5.6）时核对搬运日志：应该有「只下载、上传变化的部分：… 字节」和「已上传到 staging：…，服务器用 Tuanbo-Link-Console-0.5.5-x64.exe 拼出了完整安装包」，之后照常上线。如果日志写「服务器没能用变化的部分拼出新包，改传完整安装包」，这次发布照样会完成，把那一行的原因记下来再查。

<a id="安装结果"></a>
## 安装结果

2026-11-04 由主会话经用户 Mac 上的会话执行（用户确认同上一份 [blockmap 安装](SERVER_INSTALL_BLOCKMAPS_20261029.md#安装结果)）。

- 安装的字节：`receive-update.py` 来自提交 efc7342（字节与 b372ddb 相同），sha256 `f44c0c5974b08986cecb31574faa03985f968f0aa3a1bc6e20f364fa8fee5efc`。
- `$stamp`：`20261104T011334Z`；旧版（`c78f6df74e96bb46420c4039afd86e676fa91352eaa16c2f0ffd0f6981f6a70b`）备份在 `/var/backups/tblink/install-20261104T011334Z/`。
- 第 1 步：`receive-update.py: OK`，grep 输出 `1`；现装摘要与文档一致；`status` 为 `{"staged": [], "uploading": false}`；最后一行输出 `ve`。
- 第 3 步：`status` 输出 `{"staged": [], "uploading": false, "delta": "tblink-installer-delta-1"}`；拼包输出 `{"base": "Tuanbo-Link-Console-0.5.5-x64.exe", "bytes": 2097155, "same": true}`；staging 只有 `.upload.lock`。
- 第 4 步：Mac 检出在 master 推上去后 `git pull --ff-only` 到 4c55efa。工位电脑 01:1x UTC 时 SSH 超时：它开着机、搬运日志每 10 分钟照常，原因是 Mac 和工位之间的 Tailscale 建不了直连，只能走 DERP 中转（`tailscale ping` 约 470–580 ms），当时中转没通。07:43 UTC 中转恢复后补做：脚本来自 master c4ee2ef（与 efc7342 相同），旧版（`relay-release.mjs` 078ABF03…DB1F、`github-releases.mjs` B985EA10…FF01）备份在 `D:\tblink-relay\backup-20261104T074346Z\`；`D:\tblink-relay\` 和 `D:\tblink-builder-setup\` 里四个文件的 Get-FileHash 与 `SHA256SUMS` 一致；换完后计划任务 07:50 UTC 运行一次，`LastTaskResult=0`，日志没有报错。
