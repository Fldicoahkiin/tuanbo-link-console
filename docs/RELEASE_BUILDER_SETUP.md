# 发版搬运准备（工位电脑和 Mac）

安装包在 GitHub 云端打包、签名，放进这个标签的草稿 GitHub Release。服务器的上传私钥不进 GitHub，所以由 `scripts/relay-release.mjs` 把草稿搬到服务器 staging，等服务器发布后把草稿转为正式并标为 Latest。用户 2026-10-24 决定：不用 self-hosted runner，也不用 Cloudflare；工位电脑上线后自动同步，Mac 也能手动完成同一过程。

搬运脚本每次运行都先查状态，再做下一步，所以随时可以再跑：
- 更新源已经是这个版本：把草稿转为正式，结束；
- 服务器 staging 里已经有这个版本，或另一台机器正在上传：等，不重复上传；
- 都不是：下载草稿，按构建清单和标签提交核对，上传，再等最多 10 分钟，服务器发布了就顺手把草稿转为正式。服务器能拼安装包时（[安装说明](SERVER_INSTALL_DELTA_UPLOAD_20261029.md)），安装包只下载、上传更新源当前版没有的块，约占 1%；拼不出来就改为下载、上传完整安装包。

哪一步失败都只记日志，下次运行接着做；工位电脑和 Mac 同时跑也不会出错，服务器同一时间只接受一份上传。链路图和排查表见 [README](../README.md#发布与部署链路)，信任边界见[自动发布文档](AUTOMATED_DEPLOYMENT.md#windows-更新发布打-tag-即上线)。搬运需要服务器上的状态查询，安装见 [SERVER_INSTALL_RELAY_20261024.md](SERVER_INSTALL_RELAY_20261024.md)。

**私钥、token 和密码都只在本机窗口或 GitHub 网页里输入，不要贴到聊天里，也不要发给任何人。**

<a id="工位电脑"></a>
## 工位电脑：一条命令

在工位电脑上用「以管理员身份运行」打开 PowerShell，运行：

```powershell
powershell -ExecutionPolicy Bypass -File D:\tblink-builder-setup\setup-relay.ps1
```

[`scripts/setup-relay.ps1`](../scripts/setup-relay.ps1) 和它要复制的 `relay-release.mjs`、`github-releases.mjs` 放在 `D:\tblink-builder-setup\`，由会话同步。这两个脚本改了之后，要把新版本同时放进 `D:\tblink-builder-setup\` 和 `D:\tblink-relay\`，否则计划任务还跑旧的。脚本做这些事，重复运行安全：

1. 检查：以 WYZB 运行，Node.js、Git for Windows 的 `ssh.exe`、gh、上传身份文件和本机代理 `127.0.0.1:7890` 都在。
2. gh 没登录 Fldicoahkiin 时，走浏览器登录。**这是唯一要你动手的地方**：浏览器里用 Fldicoahkiin 登录，输入屏幕上的验证码；问「Authenticate Git with your GitHub credentials?」回答 n。
3. 把 `D:\tblink-release-signing\release-2026-10-a.pem` 从文件直接读进 GitHub secret `TBLINK_RELEASE_SIGNING_KEY`，供云端签名。私钥不经过屏幕和命令行参数。
4. 把搬运脚本复制到 `D:\tblink-relay\`（目录权限只留 WYZB、SYSTEM 和管理员，别的账号改不了计划任务要运行的脚本），安装计划任务 `tblink-relay`：以 WYZB 运行，登录后、联网后各跑一次，之后每 10 分钟一次；上一次还没跑完就跳过这次。窗口隐藏，日志写到 `D:\tblink-relay\logs\relay-<日期>.log`，保留 14 天。
5. 立刻同步一次，最后打印一行结论，例如「搬运就绪：gh 已登录 Fldicoahkiin、签名 secret 已设置、计划任务已安装、本次同步：没有等待搬运的草稿 release」。

计划任务用 WYZB 的 gh 登录，所以只在 WYZB 登录着的时候运行。开机后 WYZB 登录，任务就会跑一次。

<a id="mac"></a>
## Mac：手动跑一次

在仓库检出里运行：

```bash
pnpm release:relay
```

它用 Mac 上已经登录的 gh 和本机代理访问 GitHub。上传用 Mac 自己的密钥 `~/.config/tblink-remote/tblink_release_upload`（2026-10-24 生成，不进仓库），经 Tailscale 连服务器 `100.111.120.96`，主机密钥用现有的 `~/.config/tblink-remote/known_hosts`。这把公钥要先加到服务器，见[安装说明](SERVER_INSTALL_RELAY_20261024.md)。一次运行会做完整个过程：下载、上传、等服务器发布、把草稿转为正式。

路径都可以用环境变量改：`TBLINK_RELEASE_UPLOAD_KEY`、`TBLINK_RELEASE_KNOWN_HOSTS`、`TBLINK_RELEASE_HOST`、`TBLINK_RELEASE_SSH`、`TBLINK_RELAY_CACHE`。

<a id="现状"></a>
## 密钥和资产在工位电脑上的位置

| 位置 | 内容 | 去向 |
| --- | --- | --- |
| `D:\tblink-release-signing\release-2026-10-a.pem` | 发布签名私钥（日常） | 读进 GitHub secret；第一次云端签名成功后删除本机副本（见[下文](#删除本机日常密钥)） |
| `D:\tblink-release-signing\release-2026-10-b.pem` | 发布签名私钥（备用） | 暂时留在这里（2026-10-24 没有 U 盘，用户决定先不另外备份）；有 U 盘后拷过去离线保存，再删本机副本 |
| `D:\tblink-release-signing\upload\` | 上传到服务器的 SSH 私钥和 known_hosts | 留在工位电脑，计划任务以 WYZB 读取 |
| `D:\tblink-release-assets\` | 固定版本的美颜构建和音乐分析运行时 | 上传到 `build-assets-*` release 一次（见[固定资产](#固定资产)），之后不再需要 |
| `C:\Program Files\Git\usr\bin\ssh.exe` | Git for Windows 自带的 OpenSSH，上传用它 | Windows 自带的 `ssh.exe`（9.5p2）发送大量标准输入时，约 100 KB 后就停住 |

两把签名私钥在 `D:\tblink-release-signing\`，目录只允许 WYZB、SYSTEM 和管理员访问。文件权限挡不住以 WYZB 运行的程序，所以第一次云端签名成功后尽快删掉日常密钥 a 的本机副本。

<a id="删除本机日常密钥"></a>
## 第一次云端签名成功后删除本机日常密钥（用户）

第一次推标签、云端 build 作业用 secret 签名成功（草稿 release 里有带签名的 `latest.yml`）后，会话会通知你。之后删除 `D:\tblink-release-signing\release-2026-10-a.pem`，并清空回收站里的这个文件。再运行 `setup-relay.ps1` 时，它看到 secret 已设置、本机没有私钥，就跳过这一步。

<a id="固定资产"></a>
## 固定资产（一次，会话做）

美颜构建和离线音乐分析运行时不在 git 里。云端 build 作业从两个专门的 GitHub release 下载它们：`build-assets-beauty-<指纹前 12 位>` 和 `build-assets-music-analysis-<指纹前 12 位>`，指纹来自仓库里的 `release-pin.json`。每个 release 里是一份压缩后分卷的 tar（每卷小于 GitHub 单个附件 2 GiB 的上限）和一份列出各卷 sha256 的 `build-assets.json`。下载时逐卷核对，afterPack 再按 `release-pin.json` 核对每个文件。

gh 登录之后，会话在工位电脑上把 `D:\tblink-release-assets\` 下的两份资产上传一次（`scripts/build-assets.mjs` 的 `pack` 和 `publish`，用 `gh auth token` 作为 `GITHUB_TOKEN`，经本机代理上传）。资产重新构建、`release-pin.json` 的指纹变了，就要再上传一份新指纹的 release；旧的留着，旧标签的构建仍然可以重跑。

<a id="3-给-runner-账号开权限"></a>
## 已取消的 runner 方案

2026-10-24 之前的方案是在工位电脑上注册 self-hosted runner（tblink-runner 账号，上传私钥改归它所有）。这个方案已取消，没有执行：上传私钥仍归 WYZB，`D:\actions-runner\` 没有注册，GitHub 上也没有 runner。
