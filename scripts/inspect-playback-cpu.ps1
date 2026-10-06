param(
    [Parameter(Mandatory=$true)][string]$TracePath,
    [Parameter(Mandatory=$true)][string]$ToolsDirectory,
    [Parameter(Mandatory=$true)][string]$SymbolsDirectory,
    [Parameter(Mandatory=$true)][int]$TargetPid,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [double]$FromQpcUs = 0,
    [double]$ToQpcUs = [double]::PositiveInfinity,
    [int]$TargetThread = 0,
    [string]$FromUtc = '',
    [string]$ToUtc = ''
)
$ErrorActionPreference = 'Stop'
$base = (Resolve-Path -LiteralPath $ToolsDirectory).Path
$library = Join-Path $base 'TraceEvent/lib/netstandard2.0'
[System.Reflection.Assembly]::LoadFrom((Join-Path $base 'NETCoreClient/lib/net6.0/Microsoft.Diagnostics.NETCore.Client.dll')) | Out-Null
foreach ($name in @('Microsoft.Diagnostics.FastSerialization.dll','Dia2Lib.dll','Microsoft.Diagnostics.Tracing.TraceEvent.dll')) {
    [System.Reflection.Assembly]::LoadFrom((Join-Path $library $name)) | Out-Null
}
$source = @'
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;
using Microsoft.Diagnostics.Tracing.Etlx;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
using Microsoft.Diagnostics.Symbols;
public sealed class CpuStack {
    public int Thread;
    public string Stack;
    public int Samples;
}
public sealed class CpuReport {
    public DateTime Start;
    public double DurationMs, FirstSampleMs = double.PositiveInfinity, LastSampleMs;
    public double GlobalFirstSampleMs = double.PositiveInfinity, GlobalLastSampleMs;
    public int Process, Lost, Samples, MissingStacks;
    public List<CpuStack> Stacks;
    public List<string> Processes = new List<string>();
    public Dictionary<string, int> ProcessSamples = new Dictionary<string, int>();
    public List<string> Switches = new List<string>();
    public List<ModuleIdentity> Modules = new List<ModuleIdentity>();
}
public sealed class ModuleIdentity {
    public string Name, ImageBase, PdbName, PdbSignature;
    public int PdbAge;
}
public static class PlaybackCpuReader {
    public static CpuReport Read(string file, string symbols, int pid, string logFile, double fromQpcUs, double toQpcUs, long qpcFrequency, int targetThread, string fromUtc, string toUtc) {
        using (var log = new StreamWriter(logFile))
        using (var trace = TraceLog.OpenOrConvert(file, new TraceLogOptions { ConversionLog = log }))
        using (var reader = new SymbolReader(log, symbols)) {
            var report = new CpuReport { Start = trace.SessionStartTime, DurationMs = trace.SessionEndTimeRelativeMSec,
                Process = pid, Lost = trace.EventsLost };
            double fromRelative = String.IsNullOrEmpty(fromUtc) ? 0 : (DateTime.Parse(fromUtc).ToUniversalTime() - trace.SessionStartTime.ToUniversalTime()).TotalMilliseconds;
            double toRelative = String.IsNullOrEmpty(toUtc) ? Double.PositiveInfinity : (DateTime.Parse(toUtc).ToUniversalTime() - trace.SessionStartTime.ToUniversalTime()).TotalMilliseconds;
            foreach (var module in trace.ModuleFiles) {
                if (module.Name == "obs" || module.Name == "obs-ffmpeg" || module.Name == "obs64")
                    trace.CodeAddresses.LookupSymbolsForModule(reader, module);
            }
            var stacks = new Dictionary<string, CpuStack>();
            foreach (var process in trace.Processes.Where(p => p.ProcessID == pid))
                foreach (var module in process.LoadedModules)
                    report.Modules.Add(new ModuleIdentity { Name = module.Name, ImageBase = "0x" + module.ImageBase.ToString("x"),
                        PdbName = module.ModuleFile.PdbName, PdbSignature = module.ModuleFile.PdbSignature.ToString("N"), PdbAge = module.ModuleFile.PdbAge });
            foreach (var process in trace.Processes) report.Processes.Add(
                process.ProcessID + " " + process.Name + " startMs=" + process.StartTimeRelativeMsec
                + " endMs=" + process.EndTimeRelativeMsec + " threads=" + trace.Threads.Count(t => t.Process == process));
            var targetThreads = new HashSet<int>(trace.Threads.Where(t => t.Process.ProcessID == pid && (targetThread == 0 || t.ThreadID == targetThread)).Select(t => t.ThreadID));
            foreach (var data in trace.Events) {
                if (fromQpcUs > 0 && report.Switches.Count < 2000) {
                    var change = data as CSwitchTraceData;
                    if (change != null && (targetThreads.Contains(change.OldThreadID) || targetThreads.Contains(change.NewThreadID))) {
#pragma warning disable CS0618
                        double at = change.TimeStampQPC * 1000000.0 / qpcFrequency;
#pragma warning restore CS0618
                        if (at >= fromQpcUs && at <= toQpcUs) report.Switches.Add(String.Format(
                            System.Globalization.CultureInfo.InvariantCulture,
                            "{0:F3} ms CPU{1} old={2}/{3} {4} {5} pri{6} new={7}/{8} pri{9}",
                            (at - fromQpcUs) / 1000, change.ProcessorNumber,
                            trace.Threads.GetThread(change.OldThreadID, change.TimeStampRelativeMSec)?.Process.ProcessID ?? -1, change.OldThreadID,
                            change.OldThreadState, change.OldThreadWaitReason, change.OldThreadPriority,
                            trace.Threads.GetThread(change.NewThreadID, change.TimeStampRelativeMSec)?.Process.ProcessID ?? -1,
                            change.NewThreadID, change.NewThreadPriority));
                    }
                }
                var sample = data as SampledProfileTraceData;
                if (sample == null) continue;
                report.GlobalFirstSampleMs = Math.Min(report.GlobalFirstSampleMs, sample.TimeStampRelativeMSec);
                report.GlobalLastSampleMs = Math.Max(report.GlobalLastSampleMs, sample.TimeStampRelativeMSec);
                if (sample.TimeStampRelativeMSec < fromRelative || sample.TimeStampRelativeMSec > toRelative) continue;
                // Chromium trace timestamps are machine QPC microseconds. This
                // diagnostic deliberately joins that clock rather than UTC.
#pragma warning disable CS0618
                double qpcUs = sample.TimeStampQPC * 1000000.0 / qpcFrequency;
#pragma warning restore CS0618
                if (qpcUs < fromQpcUs || qpcUs > toQpcUs) continue;
                var process = trace.Processes.GetProcess(sample.ProcessID, sample.TimeStampRelativeMSec);
                string processKey = sample.ProcessID + " " + (process?.Name ?? "unknown");
                int processCount;
                report.ProcessSamples.TryGetValue(processKey, out processCount);
                report.ProcessSamples[processKey] = processCount + 1;
                if (sample.ProcessID != pid || targetThread != 0 && sample.ThreadID != targetThread) continue;
                report.Samples++;
                report.FirstSampleMs = Math.Min(report.FirstSampleMs, sample.TimeStampRelativeMSec);
                report.LastSampleMs = Math.Max(report.LastSampleMs, sample.TimeStampRelativeMSec);
                var stack = trace.GetCallStackForEvent(sample);
                if (stack == null) { report.MissingStacks++; continue; }
                var frames = new List<string>();
                while (stack != null && frames.Count < 40) {
                    var address = stack.CodeAddress;
                    frames.Add(address.ModuleName + "!" + (String.IsNullOrEmpty(address.FullMethodName)
                        ? "0x" + address.Address.ToString("x") : address.FullMethodName));
                    stack = stack.Caller;
                }
                string text = String.Join(" <- ", frames);
                string key = sample.ThreadID + ":" + text;
                CpuStack count;
                if (!stacks.TryGetValue(key, out count)) {
                    count = new CpuStack { Thread = sample.ThreadID, Stack = text };
                    stacks.Add(key, count);
                }
                count.Samples++;
            }
            report.Stacks = stacks.Values.OrderByDescending(e => e.Samples).Take(100).ToList();
            return report;
        }
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @(
    (Join-Path $library 'Microsoft.Diagnostics.Tracing.TraceEvent.dll'),
    (Join-Path $library 'Microsoft.Diagnostics.FastSerialization.dll'),
    (Join-Path $base 'NETCoreClient/lib/net6.0/Microsoft.Diagnostics.NETCore.Client.dll'),
    'System.Runtime', 'System.Collections', 'System.Linq', 'System.Linq.Expressions', 'System.Diagnostics.Process', 'System.IO', 'System.Net.Http', 'netstandard'
)
$symbolPaths = @((Resolve-Path -LiteralPath $SymbolsDirectory).Path)
$symbolPaths += @(Get-ChildItem -LiteralPath $SymbolsDirectory -Directory -Recurse | Select-Object -ExpandProperty FullName)
# QPC range filters are only for traces collected on this host.
$result = [PlaybackCpuReader]::Read((Resolve-Path -LiteralPath $TracePath).Path, ($symbolPaths -join ';'), $TargetPid, "$OutputPath.log", $FromQpcUs, $ToQpcUs, [Diagnostics.Stopwatch]::Frequency, $TargetThread, $FromUtc, $ToUtc)
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output ([pscustomobject]@{ Output = $OutputPath; Samples = $result.Samples; MissingStacks = $result.MissingStacks; Lost = $result.Lost })
