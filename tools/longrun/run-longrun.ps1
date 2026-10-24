# Long run of the formal player on Windows (see longrun.mjs). Runs from this checkout after
# `pnpm --filter @tb/desktop build`, with OBS open and a loopMIDI port named -Port. The whole run has a
# hard time limit (-CapMinutes + 15) and always cleans up: leftover app and receiver processes, the
# project copy (moved into -Out) and, with -Lock, the lock it still holds.
#
#   pwsh tools/longrun/run-longrun.ps1 -Project 'D:\...\演出.tblink' -Out C:\runs\longrun-1 -Stamp longrun-1
#   [-Port 'TBLINK SOAK MTC'] [-PlayMinutes 240] [-SegmentMinutes 30] [-BreakMinutes 10] [-CapMinutes 360]
#   [-Lock C:\locks\gui.lock -Discarded C:\discarded]   # shares the machine: refuses to start while any *.lock is
#                                                         # there, releases its lock between segments
#
# Summary afterwards: node tools/longrun/summary.mjs <Out>\run
param(
  [Parameter(Mandatory)][string]$Project, [Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$Stamp,
  [string]$Port = 'TBLINK SOAK MTC', [int]$PlayMinutes = 240, [int]$SegmentMinutes = 30, [int]$BreakMinutes = 10, [int]$CapMinutes = 360,
  [string]$Lock = '', [string]$Discarded = ''
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$run = Join-Path $Out 'run'; $log = Join-Path $Out 'batch.log'; $label = "long run $Stamp"
New-Item -ItemType Directory -Force -Path $run | Out-Null
$arguments = @((Join-Path $PSScriptRoot 'longrun.mjs'), '--project', $Project, '--out', $run, '--stamp', $Stamp, '--port', $Port,
  '--play', "$PlayMinutes", '--segment', "$SegmentMinutes", '--break', "$BreakMinutes", '--cap', "$CapMinutes")
if ($Lock) {
  # Any *.lock beside it means another user has the machine.
  $held = @(Get-ChildItem -LiteralPath (Split-Path -Parent $Lock) -Filter *.lock)
  if ($held.Count) { throw "机器正被占用：$($held.Name -join ', ')" }
  Set-Content -LiteralPath $Lock $label
  $arguments += @('--lock', $Lock, '--lock-label', $label)
  if ($Discarded) { $arguments += @('--discarded', $Discarded) }
}
try {
  "$(Get-Date -Format o) start play=$PlayMinutes segment=$SegmentMinutes break=$BreakMinutes cap=$CapMinutes at $(git -C $repo rev-parse --short HEAD)" | Add-Content $log
  $node = Start-Process -FilePath (Get-Command node).Source -ArgumentList $arguments -PassThru -NoNewWindow -WorkingDirectory $repo `
    -RedirectStandardOutput (Join-Path $Out 'run.out') -RedirectStandardError (Join-Path $Out 'run.out.err')
  if ($node.WaitForExit(($CapMinutes + 15) * 60000)) { "$(Get-Date -Format o) exit $($node.ExitCode)" | Add-Content $log }
  else {
    # Ends only the driver's own process tree, so the cleanup below still runs.
    "$(Get-Date -Format o) timeout; ending process tree $($node.Id)" | Add-Content $log
    & taskkill /PID $node.Id /T /F *>> $log
    $node.WaitForExit(10000) | Out-Null
  }
} finally {
  $userData = Join-Path $run 'userdata'
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -like "*$userData*" -and $_.CommandLine -notmatch '--type=' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Continue; "stopped leftover app $($_.ProcessId)" | Add-Content $log }
  Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'pwsh.exe' -and $_.CommandLine -like '*mtc-receiver.ps1*' -and $_.CommandLine -like "*$run*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Continue; "stopped receiver $($_.ProcessId)" | Add-Content $log }
  $copy = Join-Path (Split-Path -Parent $Project) "长时间运行-$Stamp.tblink"
  if (Test-Path -LiteralPath $copy) { Move-Item -LiteralPath $copy -Destination $Out -Force; "moved project copy into $Out" | Add-Content $log }
  if ($Lock -and (Test-Path -LiteralPath $Lock) -and ((Get-Content -LiteralPath $Lock -Raw) -match [regex]::Escape($label))) {
    $target = if ($Discarded) { Join-Path $Discarded ((Split-Path -Leaf $Lock) + '.' + (Get-Date -Format yyyyMMdd-HHmmss)) } else { "$Lock.$(Get-Date -Format yyyyMMdd-HHmmss)" }
    Move-Item -LiteralPath $Lock -Destination $target
  }
  "$(Get-Date -Format o) done" | Add-Content $log
}
