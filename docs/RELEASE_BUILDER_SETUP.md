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
## 4. 注册 self-hosted runner（仓库所有者 JinHe9527）

1. 用 JinHe9527 登录 GitHub，打开仓库 `JinHe9527/tuanbo-link-console` → Settings → Actions → Runners → New self-hosted runner，系统选 Windows、架构 x64。页面会列出下载命令和一个一次性 token。
2. 在开发机上用管理员 PowerShell，建目录 `D:\actions-runner`，进入该目录，按页面上「Download」部分执行下载和解压命令。
3. 配置命令用下面这一行，`<token>` 换成页面上的 token，`<密码>` 换成第 2 步的密码：

   ```powershell
   .\config.cmd --url https://github.com/JinHe9527/tuanbo-link-console --token <token> --name DESKTOP-2C8JIC2-release --labels release-builder --runasservice --windowslogonaccount .\tblink-runner --windowslogonpassword <密码>
   ```

   提示 runner group 和 work folder 时直接回车用默认值。
4. 回到网页的 Runners 列表，应看到 `DESKTOP-2C8JIC2-release` 显示 Idle，标签含 `release-builder`。
5. Settings → Actions → General：确认 fork 的 pull request 不会运行工作流（私有仓库默认如此）。这个 runner 只服务本仓库。

<a id="5-日常密钥放进-github-secret"></a>
## 5. 日常密钥放进 GitHub secret（仓库所有者，在开发机上操作）

1. 在开发机上用记事本打开 `D:\tblink-release-signing\release-2026-10-a.pem`，Ctrl+A 全选、Ctrl+C 复制，然后关闭记事本，不要保存其他位置。
2. 在开发机的浏览器里，用 JinHe9527 打开仓库 → Settings → Secrets and variables → Actions → New repository secret。
3. Name 填 `TBLINK_RELEASE_SIGNING_KEY`，Secret 里粘贴刚才复制的全部内容（包括 `-----BEGIN PRIVATE KEY-----` 和 `-----END PRIVATE KEY-----` 两行），点 Add secret。
4. 随便复制一段别的文字，覆盖剪贴板里的私钥。

工作流只在「Sign latest.yml with the release key」这一步把它放进环境变量，不会写到磁盘，日志里也会被遮掉。

<a id="6-首次构建后删除本机日常密钥"></a>
## 6. 首次构建后删除本机日常密钥（用户）

完成后告诉主会话。会话会在 Actions 手动运行一次 Release Windows，确认：构建机打出的包内容与本地验收的候选包一致（比较 `win-unpacked\resources\app.asar` 和资源目录，不比较安装包本身，因为 NSIS 会写入时间戳）；`latest.yml` 已用 secret 正确签名；包已进入服务器 staging。

会话通知「CI 签名验证成功」后，删除电脑上的 `D:\tblink-release-signing\release-2026-10-a.pem`，并清空回收站里的这个文件。之后这台电脑上不再有发布签名私钥。
