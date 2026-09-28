[CmdletBinding()]
param([Parameter(Mandatory)][string]$ExecutablePath)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw '安装版验证需要 Windows。' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$testProfile = Join-Path ([System.IO.Path]::GetTempPath()) "tblink-license-check-$([guid]::NewGuid())"
[void](New-Item -ItemType Directory -Path $testProfile)
# Production fuses disable Playwright's debugger. Inspect the shipped app's
# accessibility tree without changing its security flags.
$process = Start-Process -FilePath $ExecutablePath -ArgumentList "--user-data-dir=`"$testProfile`"", '--force-renderer-accessibility' -PassThru
$locked = $false
try {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "安装版提前退出：$($process.ExitCode)" }
    if ($process.MainWindowHandle -eq 0) { continue }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = @($elements | ForEach-Object { $_.Current.Name })
    $locked = $names -contains '激活团播联动台' -and $names -contains '激活本机' -and $names -contains '未激活'
  } while (-not $locked -and (Get-Date) -lt $deadline)
  if (-not $locked) { throw '安装版未显示完整的未激活入口。' }
  if ($names -contains '新建工程' -or $names -contains '主要工作区') { throw '未激活安装版暴露了工程工作区。' }
  if ($process.MainWindowTitle -ne '团播联动台 / Tuanbo Link Console') { throw '安装版窗口标题不正确。' }
  if (Test-Path (Join-Path $testProfile 'licensing/license.jwt')) { throw '空白配置意外产生授权凭证。' }
  Write-Output $process.MainWindowTitle
} finally {
  $process.Refresh()
  if (-not $process.HasExited) {
    if (-not $process.CloseMainWindow()) { throw '安装版拒绝正常关闭，保留进程以便诊断。' }
    if (-not $process.WaitForExit(15000)) { throw '安装版正常退出超时，未强制结束。' }
  }
}
