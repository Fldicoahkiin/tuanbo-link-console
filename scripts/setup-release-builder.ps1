#Requires -RunAsAdministrator
# 团播联动台构建机准备：按 docs/RELEASE_BUILDER_SETUP.md 第 1–5 步执行，重复运行会跳过已完成的步骤。
# 只在需要你的地方停下：插 U 盘、设密码、浏览器登录。私钥、密码和 token 都不会显示在屏幕上。
$ErrorActionPreference = 'Stop'
$repo = 'Fldicoahkiin/tuanbo-link-console'
$signing = 'D:\tblink-release-signing'
$runnerDir = 'D:\actions-runner'
$runnerName = 'DESKTOP-2C8JIC2-release'
function Step([string]$text) { Write-Host ''; Write-Host "== $text" -ForegroundColor Cyan }
function Done([string]$text) { Write-Host "   完成：$text" -ForegroundColor Green }
function Invoke-Quiet([scriptblock]$block) { $saved = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $block } finally { $ErrorActionPreference = $saved } }
function Stop-Here([string]$text) { Write-Host "   停下：$text" -ForegroundColor Red; exit 1 }

$node = "$env:ProgramFiles\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node).Source }
$gh = (Get-Command gh).Source
if (-not (Get-NetTCPConnection -LocalPort 7890 -State Listen -ErrorAction SilentlyContinue)) { Stop-Here '本机代理 127.0.0.1:7890 没有运行，先打开 Clash 再运行本脚本' }
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7890'; $env:HTTP_PROXY = 'http://127.0.0.1:7890' }

Step '第 1 步：备用密钥 b 备份到 U 盘'
$keyB = Join-Path $signing 'release-2026-10-b.pem'
if (Test-Path -LiteralPath $keyB) {
  $drive = (Read-Host '   插好 U 盘，输入 U 盘的盘符（例如 E）').Trim().TrimEnd(':', '\')
  if ($drive -notmatch '^[A-Za-z]$') { Stop-Here '盘符格式不对' }
  $backup = "$($drive):\release-2026-10-b.pem"
  if (-not (Test-Path -LiteralPath $backup)) { Copy-Item -LiteralPath $keyB -Destination $backup }
  $check = Join-Path $env:TEMP 'tblink-check-release-key.mjs'
  Set-Content -LiteralPath $check -Encoding utf8 -Value @'
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const embedded = {
  'release-2026-10-a': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAggCDXomY/ABkCHsGKIZaiQ2IFGV7830dkPa33LbQ61I=\n-----END PUBLIC KEY-----\n',
  'release-2026-10-b': '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEArE82ORMuwtbtow21vjrkLjRyZQQUYZMonhTXQqX7BfY=\n-----END PUBLIC KEY-----\n'
};
try {
  const privateKey = createPrivateKey(readFileSync(process.argv[2]));
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const kid = Object.keys(embedded).find(id => embedded[id].trim() === publicPem.trim());
  if (!kid) throw new Error('这把私钥不是客户端内置的任何一把发布密钥');
  const sample = randomBytes(64);
  if (!verify(null, sample, createPublicKey(embedded[kid]), sign(null, sample, privateKey))) throw new Error('私钥签名后无法用内置公钥验证');
  console.log(`备份可用：这把私钥对应客户端内置的 ${kid}，签名和验签都正常。`);
} catch (error) {
  console.error(`检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
'@
  & $node $check $backup
  if ($LASTEXITCODE -ne 0) { Stop-Here 'U 盘里的备份校验没通过；电脑上的原件没有动' }
  Done 'U 盘备份可用。全部跑完后，请手动删除电脑上的 release-2026-10-b.pem（选中后按 Shift+Delete），再拔下 U 盘收好'
} else { Done '电脑上已经没有 release-2026-10-b.pem，跳过' }

Step '第 2 步：新建 tblink-runner 账号（标准用户）'
$password = $null
if (Get-LocalUser -Name 'tblink-runner' -ErrorAction SilentlyContinue) {
  Done '账号已经存在，跳过'
} else {
  $password = Read-Host '   给 tblink-runner 设一个密码（自己记好，不要发到聊天里）' -AsSecureString
  New-LocalUser -Name 'tblink-runner' -Password $password -PasswordNeverExpires -UserMayNotChangePassword -Description '团播联动台 GitHub Actions runner' | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member 'tblink-runner'
  Done '已创建，并加入标准用户组'
}

Step '第 3 步：给 tblink-runner 开读取权限'
New-Item -ItemType Directory -Force -Path 'C:\dev\claude-tools\locks' | Out-Null
$grants = @(
  @('D:\tblink-release-assets', '/grant', 'tblink-runner:(OI)(CI)RX'),
  @($signing, '/grant', 'tblink-runner:RX'),
  @("$signing\upload", '/grant', 'tblink-runner:RX'),
  @("$signing\upload\known_hosts", '/grant', 'tblink-runner:R'),
  @("$signing\upload\tblink-release-ed25519", '/setowner', 'tblink-runner'),
  @("$signing\upload\tblink-release-ed25519", '/inheritance:r', '/grant:r', 'tblink-runner:R', '*S-1-5-18:F', '*S-1-5-32-544:F'),
  @('C:\dev\claude-tools\locks', '/grant', 'tblink-runner:(OI)(CI)M')
)
foreach ($grant in $grants) {
  & icacls @grant | Out-Null
  if ($LASTEXITCODE -ne 0) { Stop-Here ("icacls 失败：" + ($grant -join ' ')) }
}
Done '7 项权限已设置'

Step '第 4 步：登录 GitHub（Fldicoahkiin）并注册 runner'
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
Done 'gh 已登录 Fldicoahkiin'
if (Test-Path -LiteralPath (Join-Path $runnerDir '.runner')) {
  Done 'runner 已经注册过，跳过'
} else {
  if (-not $password) { $password = (Get-Credential -UserName '.\tblink-runner' -Message '输入第 2 步给 tblink-runner 设的密码').Password }
  $token = (& $gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $token) { Stop-Here '取注册 token 失败' }
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
  Push-Location $runnerDir
  try {
    & .\config.cmd --unattended --url "https://github.com/$repo" --token $token --name $runnerName --labels release-builder --runasservice --windowslogonaccount '.\tblink-runner' --windowslogonpassword $plain
    $code = $LASTEXITCODE
  } finally { Pop-Location; $plain = $null; $token = $null }
  if ($code -ne 0) { Stop-Here 'runner 注册失败，看上面的输出' }
  Done 'runner 已注册为 Windows 服务'
}

Step '第 5 步：把日常密钥 a 放进 GitHub secret'
$keyA = Join-Path $signing 'release-2026-10-a.pem'
if (-not (Test-Path -LiteralPath $keyA)) { Stop-Here '找不到 release-2026-10-a.pem' }
cmd /c "gh secret set TBLINK_RELEASE_SIGNING_KEY --repo $repo < `"$keyA`""
if ($LASTEXITCODE -ne 0) { Stop-Here 'secret 没有设置成功' }
if ((& $gh secret list --repo $repo | Out-String) -notmatch 'TBLINK_RELEASE_SIGNING_KEY') { Stop-Here 'secret 列表里没有 TBLINK_RELEASE_SIGNING_KEY' }
Done 'secret 已设置'
if ((Invoke-Quiet { & $gh auth status 2>&1 } | Out-String) -match 'account JinHe9527') {
  Invoke-Quiet { & $gh auth logout --hostname github.com --user JinHe9527 2>&1 } | Out-Null
  Done '已清掉 JinHe9527 失效的旧登录；Fldicoahkiin 的登录保留'
}

Step '核对'
$runner = (& $gh api "repos/$repo/actions/runners" | ConvertFrom-Json).runners | Where-Object name -eq $runnerName
if ($runner) { Write-Host ("   runner：{0}  {1}  {2}" -f $runner.name, $runner.status, ($runner.labels.name -join ',')) }
else { Write-Host '   runner 列表里还没有出现，过一分钟再看一次' -ForegroundColor Yellow }
Get-Service 'actions.runner.*' | Format-Table Name, Status, StartType -AutoSize
Write-Host '全部完成。剩下两件事要你手动做：' -ForegroundColor Cyan
Write-Host '  1. 删除电脑上的 D:\tblink-release-signing\release-2026-10-b.pem（选中后按 Shift+Delete），拔下 U 盘收好'
Write-Host '  2. 告诉 Claude「构建机准备好了」'
