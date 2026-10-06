param(
  [ValidateRange(10, 21600)][int]$Seconds = 21600,
  [ValidatePattern('^out-[a-zA-Z0-9-]+$')][string]$BuildDirectory = 'out-sixhour-20261005'
)
$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $workspace
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $workspace "artifacts\mtc-sixhour-$stamp"
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$buildPath = Join-Path $workspace "apps\desktop\$BuildDirectory"
if (-not (Test-Path -LiteralPath (Join-Path $buildPath 'main\index.cjs'))) { throw '缺少独立验收构建' }
$manifest = @(Get-ChildItem -LiteralPath $buildPath -Recurse -File | ForEach-Object {
  @{ path = $_.FullName.Substring($buildPath.Length + 1); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDirectory 'build-manifest.json') -Encoding UTF8
$state = [ordered]@{
  status = 'running'; startedAt = [DateTime]::UtcNow.ToString('o'); finishedAt = $null
  seconds = $Seconds; offsetMs = 480000; runnerPid = $PID; exitCode = $null
  buildDirectory = $BuildDirectory; directory = $runDirectory
  scope = '当前正式播放器，单首长音频、480 秒原始偏移、Windows MIDI 专用回环；波形缓存。不是完整高负载节目或实体控台验收。'
  failure = $null
}
$stateFile = Join-Path $runDirectory 'run.json'
$state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
Write-Output $runDirectory
try {
  $env:TBLINK_LOCAL_TEST_ACCESS = '1'
  $env:TBLINK_MTC_SOAK = '1'
  $env:TBLINK_MTC_SOAK_INTERNAL = '1'
  $env:TBLINK_MTC_SOAK_SECONDS = [string]$Seconds
  $env:TBLINK_MTC_SOAK_OFFSET_MS = '480000'
  $env:TBLINK_MTC_SOAK_CACHED = '1'
  $env:TBLINK_MTC_SOAK_BUILD_DIR = $BuildDirectory
  $env:TBLINK_MTC_SOAK_INPUT = 'TBLINK SOAK MTC'
  $env:TBLINK_MTC_SOAK_OUTPUT = 'TBLINK SOAK MTC'
  $env:TBLINK_MTC_SOAK_AUDIO_SECONDS = [string]($Seconds + 5)
  $env:TBLINK_MTC_SOAK_PEER = $null
  $env:TBLINK_MTC_SOAK_GC = $null
  $env:TBLINK_MTC_SOAK_PROFILE = $null
  & pnpm.cmd --filter '@tb/desktop' exec playwright test mtc-soak.spec.ts --workers=1 "--output=$runDirectory\results" *> (Join-Path $runDirectory 'test.log')
  $state.exitCode = $LASTEXITCODE
  if ($LASTEXITCODE -ne 0) { throw "MIDI 长测退出码 $LASTEXITCODE，查看 test.log 和 results 中的原始证据；不会自动重试" }
  foreach ($entry in $manifest) {
    if ((Get-FileHash -LiteralPath (Join-Path $buildPath $entry.path) -Algorithm SHA256).Hash -ne $entry.sha256) { throw '测试期间验收构建被改变，本次不能签收' }
  }
  $state.status = 'passed'
} catch {
  $state.status = 'failed'
  $state.failure = $_.Exception.Message
} finally {
  $state.finishedAt = [DateTime]::UtcNow.ToString('o')
  $state | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}
if ($state.status -ne 'passed') { exit 1 }
