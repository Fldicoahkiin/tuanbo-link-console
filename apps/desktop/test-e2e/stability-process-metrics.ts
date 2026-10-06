import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const sampleSchema = z.object({ processes: z.array(z.object({
  pid: z.number().int().positive(), parentPid: z.number().int().nonnegative(), name: z.string(),
  startedAt: z.number().finite().positive(), privateBytes: z.number().finite().nonnegative(),
  workingSetBytes: z.number().finite().nonnegative()
})), departed: z.array(z.number().int().positive()) });

/** Read-only Windows process tree measurement. Electron getAppMetrics excludes
 * the native audio engine and FFmpeg; count their private bytes as well. */
export async function measurePlaybackProcesses(rootPid: number, rootCreatedAt: number, enginePid: number | null) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid) || rootPid <= 0 || !Number.isFinite(rootCreatedAt)) throw new Error('Windows 验收根进程身份无效');
  const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$processRows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
$byId=@{}
foreach($row in $processRows){$byId[[int]$row.ProcessId]=$row}
$root=$byId[${rootPid}]
if($null -eq $root){throw '验收根进程已退出'}
$started=([DateTimeOffset]$root.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
if([Math]::Abs($started-${rootCreatedAt}) -gt 10){throw '验收根进程身份已改变'}
$owned=[Collections.Generic.HashSet[int]]::new()
[void]$owned.Add(${rootPid})
do {
  $added=$false
  foreach($row in $processRows){
    $id=[int]$row.ProcessId
    $parent=[int]$row.ParentProcessId
    if($owned.Contains($parent) -and !$owned.Contains($id) -and $row.CreationDate -ge $byId[$parent].CreationDate){[void]$owned.Add($id);$added=$true}
  }
} while($added)
$departed=[Collections.Generic.List[int]]::new()
$samples=@(foreach($id in $owned){
  try {
    $entry=[Diagnostics.Process]::GetProcessById($id)
  } catch [ArgumentException] { $departed.Add($id); continue }
  try {
    $row=$byId[$id]
    $actual=([DateTimeOffset]$entry.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    $listed=([DateTimeOffset]$row.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds()
    if([Math]::Abs($actual-$listed) -gt 10){throw '采样期间进程身份已改变'}
    @{pid=$id;parentPid=[int]$row.ParentProcessId;name=$row.Name;startedAt=$actual;privateBytes=$entry.PrivateMemorySize64;workingSetBytes=$entry.WorkingSet64}
  } finally { $entry.Dispose() }
})
@{processes=$samples;departed=@($departed.ToArray())}|ConvertTo-Json -Depth 4 -Compress
`;
  const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
  const sample = sampleSchema.parse(JSON.parse(result.stdout.replace(/^\uFEFF/, '')));
  if (!sample.processes.some(entry => entry.pid === rootPid)) throw new Error('验收根进程内存缺测');
  if (enginePid !== null && !sample.processes.some(entry => entry.pid === enginePid)) throw new Error('正式音频子进程内存缺测');
  return { ...sample, totalPrivateBytes: sample.processes.reduce((sum, entry) => sum + entry.privateBytes, 0) };
}
