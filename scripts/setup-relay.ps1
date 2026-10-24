#Requires -RunAsAdministrator
# 团播联动台发版搬运准备（工位电脑）。一条命令做完，重复运行安全：
#   powershell -ExecutionPolicy Bypass -File D:\tblink-builder-setup\setup-relay.ps1
# 安装包在 GitHub 云端构建，放进草稿 release；这台电脑上的计划任务每 10 分钟（以及登录、联网时）运行
# relay-release.mjs，把草稿送到服务器，服务器发布后把 release 转为正式。只有 gh 没登录时要你在浏览器里登录。
$ErrorActionPreference = 'Stop'
$repo = 'Fldicoahkiin/tuanbo-link-console'
$here = $PSScriptRoot
$relay = 'D:\tblink-relay'
$signing = 'D:\tblink-release-signing'
$taskName = 'tblink-relay'
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Done([string]$text) { Write-Host "   完成：$text" -ForegroundColor Green }
function Invoke-Quiet([scriptblock]$block) { $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $block } finally { $ErrorActionPreference = $saved } }
function Stop-Here([string]$text) { Write-Host "   停下：$text" -ForegroundColor Red; exit 1 }

Step '检查这台电脑'
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($account -notmatch '\\wyzb$') { Stop-Here "要用 WYZB 账号运行（现在是 $account）：计划任务用 WYZB 的 gh 登录和上传私钥" }
$node = "$env:ProgramFiles\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) { Stop-Here "没有找到 $node，先安装 Node.js 24 或更新版本" }
# 上传用 Git for Windows 的 ssh：Windows 自带的 ssh.exe 发送大量输入会停住。
if (-not (Test-Path -LiteralPath "$env:ProgramFiles\Git\usr\bin\ssh.exe")) { Stop-Here '没有找到 C:\Program Files\Git\usr\bin\ssh.exe，先安装 Git for Windows' }
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) { Stop-Here '没有找到 gh（GitHub CLI），先安装' }
foreach ($file in "$signing\upload\tblink-release-ed25519", "$signing\upload\known_hosts") {
  if (-not (Test-Path -LiteralPath $file)) { Stop-Here "没有找到上传身份文件：$file" }
}
foreach ($file in 'relay-release.mjs', 'github-releases.mjs') {
  if (-not (Test-Path -LiteralPath (Join-Path $here $file))) { Stop-Here "脚本旁边缺少 $file，把它和本脚本放在同一个文件夹" }
}
if (-not (Get-NetTCPConnection -LocalPort 7890 -State Listen -ErrorAction SilentlyContinue)) { Stop-Here '本机代理 127.0.0.1:7890 没有运行，先打开 Clash 再运行本脚本' }
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'; $env:HTTP_PROXY = 'http://127.0.0.1:7890'
Done "账号 $account，node、Git ssh、gh、上传身份和代理都在"

Step '登录 GitHub（Fldicoahkiin）'
$status = (Invoke-Quiet { & $gh auth status 2>&1 } | Out-String)
if ($status -notmatch 'account Fldicoahkiin') {
  Write-Host '   接下来会显示一个验证码并打开浏览器：用 Fldicoahkiin 登录 GitHub，输入这个验证码。'
  Write-Host '   如果问「Authenticate Git with your GitHub credentials?」，回答 n。'
  & $gh auth login --hostname github.com --git-protocol https --web
  if ($LASTEXITCODE -ne 0) { Stop-Here 'gh 登录没有完成' }
}
Invoke-Quiet { & $gh auth switch --hostname github.com --user Fldicoahkiin 2>&1 } | Out-Null
$who = (& $gh api user --jq .login | Out-String).Trim()
if ($who -ne 'Fldicoahkiin') { Stop-Here "gh 当前账号是 $who，不是 Fldicoahkiin" }
if ((Invoke-Quiet { & $gh auth status 2>&1 } | Out-String) -match 'account JinHe9527') {
  Invoke-Quiet { & $gh auth logout --hostname github.com --user JinHe9527 2>&1 } | Out-Null
}
Done 'gh 已登录 Fldicoahkiin'

Step '云端签名用的 secret'
$keyA = Join-Path $signing 'release-2026-10-a.pem'
if (Test-Path -LiteralPath $keyA) {
  # 私钥文件直接作为 gh 的标准输入，不经过屏幕、命令行参数和 PowerShell 管道。
  $secret = Start-Process -FilePath $gh -ArgumentList "secret set TBLINK_RELEASE_SIGNING_KEY --repo $repo" -RedirectStandardInput $keyA -NoNewWindow -Wait -PassThru
  if ($secret.ExitCode -ne 0) { Stop-Here 'secret 没有设置成功' }
}
if ((& $gh secret list --repo $repo | Out-String) -notmatch 'TBLINK_RELEASE_SIGNING_KEY') { Stop-Here "secret 列表里没有 TBLINK_RELEASE_SIGNING_KEY，而 $keyA 也不在" }
Done 'TBLINK_RELEASE_SIGNING_KEY 已设置'

Step '安装搬运计划任务'
New-Item -ItemType Directory -Force -Path "$relay\logs" | Out-Null
# 计划任务以 WYZB 运行这里的脚本：D 盘根目录默认允许所有登录用户改动，所以去掉继承，只留 WYZB、SYSTEM 和管理员。
& icacls $relay /inheritance:r /grant:r "${account}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T | Out-Null
if ($LASTEXITCODE -ne 0) { Stop-Here "设置 $relay 的权限失败" }
foreach ($file in 'relay-release.mjs', 'github-releases.mjs') { Copy-Item -LiteralPath (Join-Path $here $file) -Destination $relay -Force }
$ghDirectory = Split-Path $gh
Set-Content -LiteralPath "$relay\run-relay.cmd" -Encoding ascii -Value @(
  '@echo off',
  "set `"PATH=$ghDirectory;%PATH%`"",
  'set "HTTPS_PROXY=http://127.0.0.1:7890"',
  'set "HTTP_PROXY=http://127.0.0.1:7890"',
  'set "NO_PROXY=localhost,127.0.0.1,.jinhefilm.com"',
  "`"$node`" --use-env-proxy `"%~dp0relay-release.mjs`" --log `"%~dp0logs`""
)
# wscript 隐藏控制台窗口，免得每 10 分钟闪一下。
Set-Content -LiteralPath "$relay\run-relay.vbs" -Encoding ascii -Value 'CreateObject("WScript.Shell").Run """D:\tblink-relay\run-relay.cmd""", 0, True'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>团播联动台发版搬运：把云端构建的草稿 release 送到服务器，上线后转为正式。日志在 $relay\logs</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$account</UserId><Delay>PT1M</Delay></LogonTrigger>
    <EventTrigger><Enabled>true</Enabled><Delay>PT1M</Delay><Subscription>&lt;QueryList&gt;&lt;Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"&gt;&lt;Select Path="Microsoft-Windows-NetworkProfile/Operational"&gt;*[System[(EventID=10000)]]&lt;/Select&gt;&lt;/Query&gt;&lt;/QueryList&gt;</Subscription></EventTrigger>
    <TimeTrigger><Enabled>true</Enabled><StartBoundary>2026-10-24T00:00:00</StartBoundary><Repetition><Interval>PT10M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$account</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //Nologo "$relay\run-relay.vbs"</Arguments></Exec></Actions>
</Task>
"@
Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Done "计划任务 $taskName：登录和联网后各跑一次，之后每 10 分钟一次；日志在 $relay\logs"

Step '立刻同步一次'
$output = (& "$relay\run-relay.cmd" 2>&1 | Out-String)
Write-Host $output.Trim()
$result = ($output -split "`r?`n" | Where-Object { $_ -match '本次同步' } | Select-Object -Last 1) -replace '^\S+\s+', ''
if (-not $result) { $result = '没有输出，看 ' + "$relay\logs" }

Write-Host ''
Write-Host "搬运就绪：gh 已登录 Fldicoahkiin、签名 secret 已设置、计划任务已安装、$result" -ForegroundColor Cyan
