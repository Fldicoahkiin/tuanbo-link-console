param([string]$P1Directory = 'D:\HirenderP1', [switch]$Remove)
$ErrorActionPreference = 'Stop'
$targetDirectory = (Resolve-Path -LiteralPath $P1Directory).Path
$p1 = Join-Path $targetDirectory 'HirenderP1.exe'
$shim = Join-Path $targetDirectory 'winmm.dll'
$systemCopy = Join-Path $targetDirectory 'tblink_winmm_system.dll'
$expectedP1 = '3973312A96BBDE034B005B407BF1DD363B166B9680C085E0876356408554A874'
$expectedShim = '51C164CE8614A1C30D403C344B88AED06A312154EF0577C0D6FD6024819E7278'
$installedSystemHash = 'ED76D6396A53C168F91AEC28B69EC50DA47BFEA1C3966F28A107A6D93E97A2BD'
if ((Get-FileHash -LiteralPath $p1).Hash -ne $expectedP1) { throw '仅支持本次验证的 P1 1.14.2 主程序，拒绝修改其他版本。' }
if (Get-Process -Name HirenderP1 -ErrorAction SilentlyContinue) { throw '请先正常退出 P1。' }
if ($Remove) {
    if ((Get-FileHash -LiteralPath $shim).Hash -ne $expectedShim) { throw '兼容模块摘要不同，拒绝移除未知文件。' }
    if ((Test-Path -LiteralPath $systemCopy) -and (Get-FileHash -LiteralPath $systemCopy).Hash -ne $installedSystemHash) { throw '系统库副本摘要不同，拒绝移除未知文件。' }
    Remove-Item -LiteralPath $shim
    if (Test-Path -LiteralPath $systemCopy) { Remove-Item -LiteralPath $systemCopy }
    Write-Output '已移除兼容模块；P1 主程序和工程未修改。'
    exit
}
$source = Join-Path $PSScriptRoot 'winmm.dll'
if ((Get-FileHash -LiteralPath $source).Hash -ne $expectedShim) { throw '兼容模块摘要不匹配。' }
if ((Get-FileHash -LiteralPath (Join-Path $env:WINDIR 'System32\winmm.dll')).Hash -ne $installedSystemHash) { throw 'Windows MIDI 系统库版本不同，需要重新验证。' }
if ((Test-Path -LiteralPath $shim) -or (Test-Path -LiteralPath $systemCopy)) { throw '目录内已有同名模块，拒绝覆盖。' }
Copy-Item -LiteralPath (Join-Path $env:WINDIR 'System32\winmm.dll') -Destination $systemCopy
Copy-Item -LiteralPath $source -Destination $shim
Write-Output '已安装。打开 P1 设置 → MIDI，勾选输出“团播联动台 P1 MTC”。'
