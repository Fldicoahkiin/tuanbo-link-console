# 构建机准备（Windows 正式包）

正式安装包只在国内构建机上打包、签名并上传到服务器 staging。发布链路和信任边界见 [自动发布文档](AUTOMATED_DEPLOYMENT.md#windows-更新发布staging-与后台确认)。目前构建机就是开发机 DESKTOP-2C8JIC2，它同时用于 GUI 测试：runner 会等 `C:\dev\claude-tools\locks\` 下没有锁时才开始打包。长期应换一台专门的构建机。

下面的步骤由用户和仓库所有者完成。**私钥、token 和密码都只在本机窗口或 GitHub 网页里输入，不要贴到聊天里，也不要发给任何人。**

<a id="现状"></a>
## 现状

| 位置 | 内容 | 之后的去向 |
| --- | --- | --- |
| `D:\tblink-release-assets\beauty\2dfd72cfcae9\` | 固定版本的美颜构建，与 `tools/obs/beauty/release-pin.json` 一致 | 留在构建机，runner 只读 |
| `D:\tblink-release-signing\release-2026-10-a.pem` | 发布签名私钥（日常） | 放进 GitHub secret；CI 用 secret 签名成功后删除本机副本（第 6 步） |
| `D:\tblink-release-signing\release-2026-10-b.pem` | 发布签名私钥（备用） | 拷到 U 盘离线保存后删除本机副本（第 1 步） |
| `D:\tblink-release-signing\upload\` | 上传到服务器的 SSH 私钥和 known_hosts | 留在构建机，只给 runner 账号读 |

过渡期两把私钥都在 `D:\tblink-release-signing\`，目录只允许 WYZB 和 SYSTEM 访问。WYZB 是管理员，文件权限挡不住管理员，也挡不住这台机器上以 WYZB 运行的程序，所以要尽快完成第 1、5、6 步。

<a id="1-备用密钥离线保存"></a>
## 1. 备用密钥离线保存（用户）

1. 插入一个专用 U 盘，打开 `D:\tblink-release-signing\`，把 `release-2026-10-b.pem` 复制到 U 盘根目录。
2. 确认 U 盘里的备份能读出来，且确实是客户端内置的那把：打开 PowerShell（不需要管理员），执行下面两行，`E:` 换成 U 盘的盘符：

   ```powershell
   cd C:\dev\tblink-release
   node scripts\check-release-key.mjs E:\release-2026-10-b.pem
   ```

   看到「备份可用：这把私钥对应客户端内置的 release-2026-10-b，签名和验签都正常。」才算成功。这个脚本不会显示私钥内容。
3. 成功后删除电脑上的 `D:\tblink-release-signing\release-2026-10-b.pem`，并清空回收站里的这个文件。
4. 拔下 U 盘，放到安全的地方。日常密钥丢失或泄露时要用它签发一个新版本，在新版本里换上下一对密钥。

<a id="2-新建-runner-服务账号"></a>
## 2. 新建 runner 服务账号（用户，管理员）

1. 开始 → 设置 → 账户 → 其他用户 → 添加账户。
2. 选「我没有这个人的登录信息」→「添加一个没有 Microsoft 账户的用户」。
3. 用户名填 `tblink-runner`，设置一个密码，自己保存。账户类型保持「标准用户」。

<a id="3-给-runner-账号开权限"></a>
## 3. 给 runner 账号开权限（用户，管理员 PowerShell）

服务器安装已于 2026-10-23 完成，上传身份的探测也已做完（见[服务器安装记录](SERVER_INSTALL_20261023.md#安装结果)），现在可以执行这一步。

在开始菜单搜索 PowerShell，右键「以管理员身份运行」，逐行执行：

```powershell
icacls D:\tblink-release-assets /grant "tblink-runner:(OI)(CI)RX"
icacls D:\tblink-release-signing /grant "tblink-runner:RX"
icacls D:\tblink-release-signing\upload /grant "tblink-runner:RX"
icacls D:\tblink-release-signing\upload\known_hosts /grant "tblink-runner:R"
icacls D:\tblink-release-signing\upload\tblink-release-ed25519 /setowner tblink-runner
icacls D:\tblink-release-signing\upload\tblink-release-ed25519 /inheritance:r /grant:r "tblink-runner:R" "SYSTEM:F" "Administrators:F"
icacls C:\dev\claude-tools\locks /grant "tblink-runner:(OI)(CI)M"
```

runner 只能读资产和上传身份，不能读发布签名私钥（它来自 GitHub secret）。上传私钥的所有者改成 tblink-runner，因为 Windows 的 OpenSSH 只接受只属于当前账户的私钥。最后一行让 runner 能建和删自己的锁文件。

<a id="4-注册-self-hosted-runner"></a>
## 4. 注册 self-hosted runner（仓库所有者 JinHe9527，开发机上的管理员 PowerShell）

注册 runner 和设置 secret 都需要仓库 admin 权限，只有 JinHe9527 有（Fldicoahkiin 只有 push 权限）。第 4、5 步在开发机的同一个管理员 PowerShell 窗口里依次完成，最后退出登录。开发机已经装了 gh，默认账号是 JinHe9527，但之前的 token 已失效。

1. 重新登录 gh：

   ```powershell
   gh auth login --hostname github.com --git-protocol https --web
   ```

   屏幕上会显示一次性验证码，按回车打开浏览器，用 JinHe9527 登录 GitHub 并输入这个验证码。验证码只在浏览器里输入，不要发到聊天里。如果问「Authenticate Git with your GitHub credentials?」，回答 `n`。

   预期最后两行是 `✓ Authentication complete.` 和 `✓ Logged in as JinHe9527`。再执行 `gh auth status`，应看到 `Logged in to github.com account JinHe9527`，并且这个账号的 `Active account: true`。如果活动账号不是 JinHe9527，执行 `gh auth switch -h github.com -u JinHe9527`。

2. 下载并校验 runner：

   ```powershell
   New-Item -ItemType Directory -Force D:\actions-runner | Out-Null; Set-Location D:\actions-runner
   $asset = (gh api repos/actions/runner/releases/latest | ConvertFrom-Json).assets | Where-Object name -Match '^actions-runner-win-x64-[0-9.]+\.zip$'
   $asset.name
   Invoke-WebRequest $asset.browser_download_url -OutFile $asset.name
   ("sha256:" + (Get-FileHash $asset.name -Algorithm SHA256).Hash.ToLower()) -eq $asset.digest
   Expand-Archive $asset.name -DestinationPath .
   ```

   预期：`$asset.name` 输出形如 `actions-runner-win-x64-2.xxx.x.zip`，只有一行；摘要比较那一行输出 `True`。输出 `False` 就停下，不要解压。这里的命令在 Windows PowerShell 5.1 和 PowerShell 7 里都能用。

3. 给 runner 配代理。开发机直连 GitHub 不通，平时经本机代理 `127.0.0.1:7890` 访问，但这个代理只配在 WYZB 的用户设置里。runner 以 tblink-runner 的服务身份运行，读不到这些设置，要写进 runner 目录下的 `.env` 文件：

   ```powershell
   Set-Content -Encoding ascii D:\actions-runner\.env "https_proxy=http://127.0.0.1:7890`nhttp_proxy=http://127.0.0.1:7890`nno_proxy=localhost,127.0.0.1"
   Get-Content D:\actions-runner\.env
   ```

   预期显示三行：`https_proxy=…`、`http_proxy=…`、`no_proxy=localhost,127.0.0.1`。代理程序要一直开着，runner 才能保持在线、执行任务；以后代理端口变了，就改这个文件并重启 runner 服务。上传到服务器走 SSH，不经过这个代理。

4. 取一次性注册 token 并配置 runner。token 只存在 PowerShell 变量里，不显示在屏幕上；tblink-runner 的密码通过提示框输入，不写进命令历史：

   ```powershell
   $cred = Get-Credential -UserName '.\tblink-runner' -Message '输入第 2 步给 tblink-runner 设的密码'
   $token = gh api -X POST repos/JinHe9527/tuanbo-link-console/actions/runners/registration-token --jq .token
   if ($LASTEXITCODE -ne 0 -or -not $token) { throw '取注册 token 失败，先检查 gh auth status' }
   .\config.cmd --unattended --url https://github.com/JinHe9527/tuanbo-link-console --token $token --name DESKTOP-2C8JIC2-release --labels release-builder --runasservice --windowslogonaccount .\tblink-runner --windowslogonpassword $cred.GetNetworkCredential().Password
   Remove-Variable token, cred
   ```

   预期 `config.cmd` 的输出依次包含 `Connected to GitHub`、`Runner successfully added`、`Runner connection is good`、`Settings Saved`，最后几行是 `Service actions.runner.JinHe9527-tuanbo-link-console.DESKTOP-2C8JIC2-release` 安装成功并已启动。`throw` 那一行报错，说明登录或权限有问题，不要继续。

5. 核对 runner 已在线：

   ```powershell
   (gh api repos/JinHe9527/tuanbo-link-console/actions/runners | ConvertFrom-Json).runners | ForEach-Object { '{0} {1} {2}' -f $_.name, $_.status, ($_.labels.name -join ',') }
   Get-Service 'actions.runner.*' | Format-Table Name, Status, StartType
   ```

   预期第一条输出 `DESKTOP-2C8JIC2-release online self-hosted,Windows,X64,release-builder`；第二条显示这个服务 `Running`。如果是 `offline`，先确认代理程序在运行、`.env` 内容正确，再执行 `Restart-Service 'actions.runner.*'`。

6. 在浏览器里打开仓库 Settings → Actions → General，确认「Run workflows from fork pull requests」没有勾选（私有仓库默认不勾选）。这个 runner 只服务本仓库。

<a id="5-日常密钥放进-github-secret"></a>
## 5. 日常密钥放进 GitHub secret（同一个窗口，接着第 4 步）

1. 从文件按原始字节读入 secret。不经过剪贴板，也不经过 PowerShell 管道，因为管道可能改动编码：

   ```powershell
   cmd /c "gh secret set TBLINK_RELEASE_SIGNING_KEY --repo JinHe9527/tuanbo-link-console < D:\tblink-release-signing\release-2026-10-a.pem"
   ```

   预期输出 `✓ Set Actions secret TBLINK_RELEASE_SIGNING_KEY for JinHe9527/tuanbo-link-console`。这条命令不会显示私钥内容。

2. 核对 secret 已存在：

   ```powershell
   gh secret list --repo JinHe9527/tuanbo-link-console
   ```

   预期有一行 `TBLINK_RELEASE_SIGNING_KEY`，更新时间是刚才。secret 的值无法读回，是否正确由第 6 步的首次 CI 签名来验证。

3. 退出 gh 登录。这台机器上很多进程以 WYZB 身份运行，不能长期留着仓库所有者的 token：

   ```powershell
   gh auth logout -h github.com -u JinHe9527
   gh auth status
   ```

   预期第一条输出 `✓ Logged out of github.com account JinHe9527`；第二条不再列出 JinHe9527（没有其他账号时显示 `You are not logged into any GitHub hosts`）。

工作流只在「Sign latest.yml with the release key」这一步把它放进环境变量，不会写到磁盘，日志里也会被遮掉。

<a id="6-首次构建后删除本机日常密钥"></a>
## 6. 首次构建后删除本机日常密钥（用户）

完成后告诉主会话。会话会在 Actions 手动运行一次 Release Windows，确认：构建机打出的包内容与本地验收的候选包一致（比较 `win-unpacked\resources\app.asar` 和资源目录，不比较安装包本身，因为 NSIS 会写入时间戳）；`latest.yml` 已用 secret 正确签名；包已进入服务器 staging。

会话通知「CI 签名验证成功」后，删除电脑上的 `D:\tblink-release-signing\release-2026-10-a.pem`，并清空回收站里的这个文件。之后这台电脑上不再有发布签名私钥。
