[CmdletBinding()]
param(
  [Parameter()]
  [string]$InstallerPath = '',

  [Parameter()]
  [string]$PreviousInstallerPath = '',

  [Parameter()]
  [string]$PreviousVersion = '',

  [Parameter()]
  [string]$InstallDirectory = 'C:\dev\tuanbo-link-installer-acceptance'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Installer {
  param(
    [Parameter(Mandatory)]
    [string]$Installer,

    [Parameter(Mandatory)]
    [string]$Target
  )

  $process = Start-Process -FilePath $Installer -ArgumentList '/S', "/D=$Target" -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(120000)) { throw '安装超时，保留进程以便诊断。' }
  if ($process.ExitCode -ne 0) {
    throw "安装程序退出码：$($process.ExitCode)"
  }
}

function Get-TuanboProcesses {
  param(
    [Parameter(Mandatory)]
    [string]$InstallDirectory
  )

  return @(Get-Process | Where-Object {
    try {
      $_.Path -like "$InstallDirectory\*"
    }
    catch {
      $false
    }
  })
}

function Wait-TuanboMainWindow {
  param(
    [Parameter(Mandatory)]
    [string]$InstallDirectory,

    [Parameter(Mandatory)]
    [int]$TimeoutSeconds,

    [Parameter(Mandatory)]
    [string]$ExpectedTitle
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastTitle = ''
  do {
    Start-Sleep -Milliseconds 500
    $windows = @(Get-TuanboProcesses -InstallDirectory $InstallDirectory | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($windows.Count -eq 1 -and $windows[0].MainWindowTitle -eq $ExpectedTitle) {
      return $windows[0]
    }
    if ($windows.Count -eq 1) {
      $lastTitle = $windows[0].MainWindowTitle
    }
    if ($windows.Count -gt 1) {
      throw "安装版出现 $($windows.Count) 个主窗口，无法确定唯一运行实例。"
    }
  } while ((Get-Date) -lt $deadline)

  throw "安装版启动后 20 秒内未进入最终 renderer 窗口标题；最后标题：$lastTitle。按产品规则保留进程，不强制结束。"
}

function Get-TuanboUninstallEntries {
  $entries = @()
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (Test-Path -LiteralPath $root) {
      foreach ($key in Get-ChildItem -LiteralPath $root) {
        $property = Get-ItemProperty -LiteralPath $key.PSPath
        $displayNameProperty = $property.PSObject.Properties['DisplayName']
        if ($null -ne $displayNameProperty -and $displayNameProperty.Value -eq '团播联动台') {
          $uninstallProperty = $property.PSObject.Properties['UninstallString']
          $entries += [pscustomobject]@{
            Hive = $root
            Key = $key.PSChildName
            UninstallString = if ($null -eq $uninstallProperty) { '' } else { [string]$uninstallProperty.Value }
          }
        }
      }
    }
  }
  return @($entries)
}

if (-not $IsWindows) {
  throw '安装生命周期验收必须在 Windows 原生 PowerShell 环境运行。'
}

if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
  $desktopPackage = Get-Content -LiteralPath 'apps\desktop\package.json' -Raw | ConvertFrom-Json
  $InstallerPath = "apps\desktop\dist\Tuanbo-Link-Console-$($desktopPackage.version)-x64.exe"
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedInstallDirectory = [System.IO.Path]::GetFullPath($InstallDirectory)
if ($resolvedInstallDirectory -notlike 'C:\dev\tuanbo-link-installer-acceptance*') {
  throw "验收安装目录必须位于 C:\dev\tuanbo-link-installer-acceptance*：$resolvedInstallDirectory"
}
if ($resolvedInstallDirectory -match '\s') {
  throw "NSIS 静默验收目录不能包含空格：$resolvedInstallDirectory"
}
if (Test-Path -LiteralPath $resolvedInstallDirectory) {
  throw "验收安装目录已存在，停止以避免覆盖：$resolvedInstallDirectory"
}

$existingEntries = @(Get-TuanboUninstallEntries)
if ($existingEntries.Count -gt 0) {
  throw '当前账户已经安装“团播联动台”；验收脚本拒绝覆盖用户现有安装。'
}

$desktopPackage = Get-Content -LiteralPath 'apps\desktop\package.json' -Raw | ConvertFrom-Json
$applicationPath = Join-Path $resolvedInstallDirectory '团播联动台.exe'
$migration = 'not-requested'
if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
  if ($PreviousVersion -notmatch '^\d+\.\d+\.\d+$' -or [version]$PreviousVersion -ge [version]$desktopPackage.version) {
    throw '旧版迁移必须提供低于当前版本的确切版本号。'
  }
  $resolvedPreviousInstaller = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  Invoke-Installer -Installer $resolvedPreviousInstaller -Target $resolvedInstallDirectory
  $previousMetadata = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($applicationPath)
  if ([version]$previousMetadata.ProductVersion -ne [version]"$PreviousVersion.0") {
    throw "旧版安装后的可执行文件版本不匹配：$($previousMetadata.ProductVersion)"
  }
  $oldEntries = @(Get-TuanboUninstallEntries)
  if ($oldEntries.Count -ne 1 -or $oldEntries[0].Hive -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
    throw '旧版安装没有产生唯一的当前用户卸载项。'
  }
  if (@(Get-TuanboProcesses -InstallDirectory $resolvedInstallDirectory).Count -gt 0) {
    throw '旧版静默安装后仍有进程运行，停止覆盖以避免强制关闭。'
  }
  $migration = "$PreviousVersion -> $($desktopPackage.version)"
  Write-Host "Verified installed legacy executable: $($previousMetadata.ProductVersion)"
}

Invoke-Installer -Installer $resolvedInstaller -Target $resolvedInstallDirectory
$currentMetadata = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($applicationPath)
if ([version]$currentMetadata.ProductVersion -ne [version]"$($desktopPackage.version).0") {
  throw "覆盖安装后未切换到目标版本：$($currentMetadata.ProductVersion)"
}
Write-Host "Verified installed current executable: $($currentMetadata.ProductVersion); migration: $migration"
Invoke-Installer -Installer $resolvedInstaller -Target $resolvedInstallDirectory

$installedEntries = @(Get-TuanboUninstallEntries)
if ($installedEntries.Count -ne 1) {
  throw "安装后预期 1 个卸载注册项，实际 $($installedEntries.Count) 个。"
}
if ($installedEntries[0].Hive -ne 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall') {
  throw "安装范围不是当前用户：$($installedEntries[0].Hive)"
}
if ($installedEntries[0].UninstallString -notmatch '/currentuser') {
  throw "卸载注册项未声明当前用户安装：$($installedEntries[0].UninstallString)"
}

$uninstallerPath = Join-Path $resolvedInstallDirectory 'Uninstall 团播联动台.exe'
if (-not (Test-Path -LiteralPath $applicationPath)) {
  throw "安装后缺少主程序：$applicationPath"
}
if (-not (Test-Path -LiteralPath $uninstallerPath)) {
  throw "安装后缺少卸载程序：$uninstallerPath"
}

$mainWindowTitle = (& ./scripts/verify-installed-app.ps1 -ExecutablePath $applicationPath | Out-String).Trim()
$tamperedWindowTitle = (& ./scripts/verify-installed-app.ps1 -ExecutablePath $applicationPath -Credential tampered | Out-String).Trim()
Write-Host 'Installed product rejected both missing and tampered credentials.'

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  $remainingProcesses = @(Get-TuanboProcesses -InstallDirectory $resolvedInstallDirectory)
} while ($remainingProcesses.Count -gt 0 -and (Get-Date) -lt $deadline)

if ($remainingProcesses.Count -gt 0) {
  throw '安装版正常关闭超时；按产品规则保留进程，不强制结束。'
}

# NSIS's original stub exits after launching its temporary copy. Execute our own
# verified copy with _?= so WaitForExit observes the actual uninstall and status.
$uninstallCopyDirectory = Join-Path ([System.IO.Path]::GetTempPath()) "tblink-uninstall-check-$([guid]::NewGuid())"
[void](New-Item -ItemType Directory -Path $uninstallCopyDirectory)
$uninstallCopy = Join-Path $uninstallCopyDirectory 'uninstall.exe'
Copy-Item -LiteralPath $uninstallerPath -Destination $uninstallCopy
if ((Get-FileHash $uninstallerPath -Algorithm SHA256).Hash -cne (Get-FileHash $uninstallCopy -Algorithm SHA256).Hash) {
  throw '卸载程序临时副本校验失败。'
}
$uninstall = Start-Process -FilePath $uninstallCopy -ArgumentList '/S', '/currentuser', "_?=$resolvedInstallDirectory" -WindowStyle Hidden -PassThru
if (-not $uninstall.WaitForExit(120000)) { throw '卸载超时，保留进程以便诊断。' }
if ($uninstall.ExitCode -ne 0) {
  throw "卸载程序退出码：$($uninstall.ExitCode)"
}

Start-Sleep -Seconds 3
$processResidue = @(Get-TuanboProcesses -InstallDirectory $resolvedInstallDirectory)
$registryResidue = @(Get-TuanboUninstallEntries)
if (Test-Path -LiteralPath $resolvedInstallDirectory) {
  throw "卸载后安装目录仍存在：$resolvedInstallDirectory"
}
if ($processResidue.Count -gt 0) {
  throw "卸载后仍有 $($processResidue.Count) 个联动台进程。"
}
if ($registryResidue.Count -gt 0) {
  throw "卸载后仍有 $($registryResidue.Count) 个卸载注册项：$($registryResidue | ConvertTo-Json -Compress)"
}

[pscustomobject]@{
  Installer = $resolvedInstaller
  InstallDirectory = $resolvedInstallDirectory
  FirstInstall = 'passed'
  SameVersionOverwrite = 'passed'
  PreviousVersionMigration = $migration
  InstallScope = 'current-user'
  MainWindow = $mainWindowTitle
  TamperedCredentialWindow = $tamperedWindowTitle
  GracefulClose = 'passed'
  Uninstall = 'passed'
  ProcessResidue = 0
  RegistryResidue = 0
} | Format-List
