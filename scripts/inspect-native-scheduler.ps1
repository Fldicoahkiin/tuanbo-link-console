param(
    [Parameter(Mandatory=$true)][string]$TracePath,
    [Parameter(Mandatory=$true)][string]$LibraryDirectory,
    [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$library = (Resolve-Path -LiteralPath $LibraryDirectory).Path
[System.Reflection.Assembly]::LoadFrom((Join-Path $library 'Microsoft.Diagnostics.FastSerialization.dll')) | Out-Null
[System.Reflection.Assembly]::LoadFrom((Join-Path $library 'Microsoft.Diagnostics.Tracing.TraceEvent.dll')) | Out-Null
$source = @'
using System;
using System.Collections.Generic;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Parsers.Kernel;
public sealed class SchedulerThread {
    public int Pid, Tid;
    public string Name;
    public long Samples, Switches;
    public double FirstMs = double.PositiveInfinity, LastMs, MaxObservedSwitchIntervalMs;
    public double LastOutMs = -1;
    public string LastWait, LastState;
    public List<string> LongWaits = new List<string>();
}
public sealed class SchedulerReport {
    public DateTime Start, End;
    public long Lost, Samples, Switches;
    public double FirstSampleMs = double.PositiveInfinity, LastSampleMs;
    public Dictionary<int, SchedulerThread> Threads = new Dictionary<int, SchedulerThread>();
}
public static class NativeSchedulerReader {
    public static SchedulerReport Read(string file) {
        var report = new SchedulerReport();
        // Memory-mode ETL contains process/thread rundown after the samples.
        // Resolve identities in a separate pass before interpreting CPU data.
        var processes = new Dictionary<int, string>();
        var threads = new Dictionary<int, int>();
        using (var identities = new ETWTraceEventSource(file)) {
            Action<ProcessTraceData> process = e => processes[e.ProcessID] = e.ImageFileName;
            Action<ThreadTraceData> thread = e => threads[e.ThreadID] = e.ProcessID;
            identities.Kernel.ProcessStart += process; identities.Kernel.ProcessDCStart += process;
            identities.Kernel.ProcessDCStop += process; identities.Kernel.ProcessStop += process;
            identities.Kernel.ThreadStart += thread; identities.Kernel.ThreadDCStart += thread;
            identities.Kernel.ThreadDCStop += thread; identities.Kernel.ThreadStop += thread;
            identities.Process();
        }
        foreach (var pair in threads) {
            string name;
            if (!processes.TryGetValue(pair.Value, out name)) continue;
            if (name.IndexOf("tblink-playback", StringComparison.OrdinalIgnoreCase) >= 0 ||
                name.IndexOf("obs64", StringComparison.OrdinalIgnoreCase) >= 0)
                report.Threads[pair.Key] = new SchedulerThread { Pid = pair.Value, Tid = pair.Key, Name = name };
        }
        using (var source = new ETWTraceEventSource(file)) {
            report.Start = source.SessionStartTime; report.End = source.SessionEndTime;
            source.Kernel.PerfInfoSample += e => {
                report.Samples++; report.FirstSampleMs = Math.Min(report.FirstSampleMs, e.TimeStampRelativeMSec);
                report.LastSampleMs = Math.Max(report.LastSampleMs, e.TimeStampRelativeMSec);
                SchedulerThread thread;
                if (!report.Threads.TryGetValue(e.ThreadID, out thread)) return;
                thread.Samples++; thread.FirstMs = Math.Min(thread.FirstMs, e.TimeStampRelativeMSec);
                thread.LastMs = Math.Max(thread.LastMs, e.TimeStampRelativeMSec);
            };
            source.Kernel.ThreadCSwitch += e => {
                report.Switches++;
                SchedulerThread thread;
                if (report.Threads.TryGetValue(e.OldThreadID, out thread)) {
                    thread.LastOutMs = e.TimeStampRelativeMSec;
                    thread.LastWait = e.OldThreadWaitReason.ToString();
                    thread.LastState = e.OldThreadState.ToString();
                }
                if (report.Threads.TryGetValue(e.NewThreadID, out thread)) {
                    thread.Switches++;
                    if (thread.LastOutMs >= 0) {
                        double duration = e.TimeStampRelativeMSec - thread.LastOutMs;
                        thread.MaxObservedSwitchIntervalMs = Math.Max(thread.MaxObservedSwitchIntervalMs, duration);
                        if (duration >= 20 && thread.LongWaits.Count < 100) thread.LongWaits.Add(
                            String.Format(System.Globalization.CultureInfo.InvariantCulture,
                            "{0:F3}..{1:F3} ms; {2}; {3}", thread.LastOutMs, e.TimeStampRelativeMSec, thread.LastState, thread.LastWait));
                    }
                    thread.LastOutMs = -1;
                }
            };
            source.Process(); report.Lost = source.EventsLost;
        }
        return report;
    }
}
'@
Add-Type -TypeDefinition $source -ReferencedAssemblies @(
    (Join-Path $library 'Microsoft.Diagnostics.Tracing.TraceEvent.dll'),
    'System.Runtime', 'System.Collections', 'System.Linq.Expressions', 'System.Diagnostics.Process', 'netstandard'
)
$report = [NativeSchedulerReader]::Read((Resolve-Path -LiteralPath $TracePath).Path)
[pscustomobject]@{
    Scope = '离线 ETW 事件目录。环形记录的不同 CPU 缓冲可能覆盖不同区间；观察到的切换间隔不是已证明的阻塞时长，不能据此宣称驱动阻塞或排除早期故障。线程身份来自 rundown；复用 TID 的记录需要进一步核对。'
    Start = $report.Start; End = $report.End; Lost = $report.Lost
    Samples = $report.Samples; Switches = $report.Switches
    FirstSampleMs = $report.FirstSampleMs; LastSampleMs = $report.LastSampleMs
    Threads = @($report.Threads.Values)
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
Write-Output ([pscustomobject]@{ Output = $OutputPath; Samples = $report.Samples; Switches = $report.Switches; Lost = $report.Lost; FirstSampleMs = $report.FirstSampleMs; LastSampleMs = $report.LastSampleMs; Threads = $report.Threads.Count })
