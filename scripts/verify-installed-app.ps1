[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ExecutablePath,
  [ValidateSet('missing', 'tampered')][string]$Credential = 'missing'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw '安装版验证需要 Windows。' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
# Hidden acceptance launches have no Process.MainWindowHandle. Resolve only the
# window carrying this exact process id and title; WM_CLOSE remains a normal exit.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class InstalledAppWindow {
  public delegate bool Callback(IntPtr handle, IntPtr value);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr value);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder title, int count);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(uint pid, string expected) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((handle, value) => {
      uint owner; GetWindowThreadProcessId(handle, out owner);
      if (owner == pid) {
        var title = new StringBuilder(1024); GetWindowText(handle, title, title.Capacity);
        if (title.ToString() == expected) { found = handle; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Close(uint pid, string expected) {
    var handle = Find(pid, expected);
    return handle != IntPtr.Zero && PostMessage(handle, 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
}
'@
$testProfile = Join-Path ([System.IO.Path]::GetTempPath()) "tblink-license-check-$([guid]::NewGuid())"
[void](New-Item -ItemType Directory -Path $testProfile)
$licensePath = Join-Path $testProfile 'licensing/license.jwt'
if ($Credential -eq 'tampered') {
  [void](New-Item -ItemType Directory -Path (Split-Path -Parent $licensePath))
  [System.IO.File]::WriteAllText($licensePath, 'invalid-license')
}
# Production fuses disable Playwright's debugger. Inspect the shipped app's
# accessibility tree without changing its security flags.
$process = Start-Process -FilePath $ExecutablePath -ArgumentList "--user-data-dir=`"$testProfile`"", '--force-renderer-accessibility' -WindowStyle Hidden -PassThru
$expectedTitle = "团播联动台 / Tuanbo Link Console · $($process.Id)"
$locked = $false
try {
  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $process.Refresh()
    if ($process.HasExited) { throw "安装版提前退出：$($process.ExitCode)" }
    $handle = [InstalledAppWindow]::Find($process.Id, $expectedTitle)
    if ($handle -eq [IntPtr]::Zero) { continue }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = @($elements | ForEach-Object { $_.Current.Name })
    $expectedState = if ($Credential -eq 'tampered') { '校验失败' } else { '未激活' }
    $locked = $names -contains '激活团播联动台' -and $names -contains '激活本机' -and $names -contains $expectedState
  } while (-not $locked -and (Get-Date) -lt $deadline)
  if (-not $locked) { throw '安装版未显示完整的未激活入口。' }
  if ($names -contains '新建工程' -or $names -contains '主要工作区') { throw '未激活安装版暴露了工程工作区。' }
  if ([InstalledAppWindow]::Find($process.Id, $expectedTitle) -eq [IntPtr]::Zero) { throw '安装版窗口身份已改变。' }
  if ($Credential -eq 'missing' -and (Test-Path $licensePath)) { throw '空白配置意外产生授权凭证。' }
  if ($Credential -eq 'tampered' -and [System.IO.File]::ReadAllText($licensePath) -cne 'invalid-license') {
    throw '损坏凭证被意外改写，未能验证原凭证拒绝行为。'
  }
  Write-Output $expectedTitle
} finally {
  $process.Refresh()
  if (-not $process.HasExited) {
    if (-not [InstalledAppWindow]::Close($process.Id, $expectedTitle)) { throw '安装版拒绝正常关闭，保留进程以便诊断。' }
    if (-not $process.WaitForExit(15000)) { throw '安装版正常退出超时，未强制结束。' }
  }
}
