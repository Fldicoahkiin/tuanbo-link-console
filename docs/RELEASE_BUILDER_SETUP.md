# 构建机准备（Windows 正式包）

正式安装包只在国内构建机上打包、签名并上传到服务器 staging，发布链路和信任边界见 [自动发布文档](AUTOMATED_DEPLOYMENT.md#windows-更新发布staging-与后台确认)。目前构建机就是开发机 DESKTOP-2C8JIC2，它同时用于 GUI 测试：runner 会等 `C:\dev\claude-tools\locks\` 下没有锁时才开始打包。长期应换一台专门的构建机。

<a id="已经准备好的部分"></a>
## 已经准备好的部分

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `D:\tblink-release-assets\beauty\2dfd72cfcae9\` | 固定版本的美颜构建 | 与 `tools/obs/beauty/release-pin.json` 一致；目录名是指纹前 12 位 |
| `D:\tblink-release-signing\release-2026-10-a.pem` | 发布签名私钥（日常） | 客户端内置对应公钥 |
| `D:\tblink-release-signing\release-2026-10-b.pem` | 发布签名私钥（备用） | 用于轮换；**应离线保存**，见第 1 步 |
| `D:\tblink-release-signing\upload\` | 上传到服务器的 SSH 私钥和 known_hosts | 只能写服务器 staging |

`D:\tblink-release-signing` 目前只允许 WYZB 和 SYSTEM 访问。WYZB 是管理员，这台机器上以 WYZB 运行的程序都能读到私钥，这是换专门构建机之前的已知风险。

<a id="1-离线保存备用密钥"></a>
## 1. 离线保存备用密钥（用户）

1. 插入 U 盘，把 `D:\tblink-release-signing\release-2026-10-b.pem` 复制到 U 盘，U 盘放到安全的地方。
2. 确认 U 盘里的文件能打开后，删除电脑上的 `release-2026-10-b.pem`。

日常密钥丢失或泄露时，用备用密钥签发一个新版本；这个新版本里再放入下一把备用公钥。

<a id="2-新建-runner-服务账号"></a>
## 2. 新建 runner 服务账号（用户，管理员）

1. 开始 → 设置 → 账户 → 其他用户 → 添加账户。
2. 选「我没有这个人的登录信息」→「添加一个没有 Microsoft 账户的用户」。
3. 用户名填 `tblink-runner`，设置一个密码，自己保存，**不要发到聊天里**。账户类型保持「标准用户」。

<a id="3-给-runner-账号开权限"></a>
## 3. 给 runner 账号开权限（用户，管理员 PowerShell）

在开始菜单搜索 PowerShell，右键「以管理员身份运行」，逐行执行：

```powershell
icacls D:\tblink-release-assets /grant "tblink-runner:(OI)(CI)RX"
icacls D:\tblink-release-signing /grant "tblink-runner:RX"
icacls D:\tblink-release-signing\release-2026-10-a.pem /grant "tblink-runner:R"
icacls D:\tblink-release-signing\upload /grant "tblink-runner:RX"
icacls D:\tblink-release-signing\upload\known_hosts /grant "tblink-runner:R"
icacls D:\tblink-release-signing\upload\tblink-release-ed25519 /setowner tblink-runner
icacls D:\tblink-release-signing\upload\tblink-release-ed25519 /inheritance:r /grant:r "tblink-runner:R" "SYSTEM:F" "Administrators:F"
icacls C:\dev\claude-tools\locks /grant "tblink-runner:(OI)(CI)M"
```

资产和私钥 runner 只能读不能改。上传私钥的所有者改成 tblink-runner：Windows 的 OpenSSH 只接受只属于当前账户的私钥。最后一行让 runner 能建和删自己的锁文件。

<a id="4-注册-self-hosted-runner"></a>
## 4. 注册 self-hosted runner（仓库所有者 JinHe9527）

1. 用 JinHe9527 登录 GitHub，打开仓库 `JinHe9527/tuanbo-link-console` → Settings → Actions → Runners → New self-hosted runner，系统选 Windows、架构 x64。页面会列出下载命令和一个一次性 token。
2. 在开发机上用管理员 PowerShell，建目录 `D:\actions-runner`，进入该目录，按页面上的「Download」部分执行下载和解压命令。
3. 配置命令用下面这一行。`<token>` 换成页面上的 token，`<密码>` 换成第 2 步的密码。这两个值只在这个 PowerShell 窗口里输入，**不要贴到聊天里**：

   ```powershell
   .\config.cmd --url https://github.com/JinHe9527/tuanbo-link-console --token <token> --name DESKTOP-2C8JIC2-release --labels release-builder --runasservice --windowslogonaccount .\tblink-runner --windowslogonpassword <密码>
   ```

   提示「Enter the name of runner group」「work folder」时直接回车用默认值。
4. 回到网页的 Runners 列表，应看到 `DESKTOP-2C8JIC2-release` 显示 Idle，标签含 `release-builder`。
5. Settings → Actions → General：确认「Fork pull request workflows」相关选项是关闭的（私有仓库默认关闭）。这个 runner 只服务本仓库。

<a id="5-验证"></a>
## 5. 验证

完成后告诉主会话。会话会在 Actions 手动运行 Release Windows，确认构建机打出的包和本地验收的候选包内容一致：比较 `win-unpacked\resources\app.asar` 和资源目录，不比较安装包本身，因为 NSIS 会写入时间戳。然后确认包已进入服务器 staging，再由你在运营后台确认发布。
