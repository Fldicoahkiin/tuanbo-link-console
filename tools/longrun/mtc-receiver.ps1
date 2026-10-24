# MTC receiver for the long run (longrun.mjs starts it): listens on the input side of a loopMIDI test
# port with WinMM (the port itself is not changed) and decodes what the app sends to its output side.
# Every second it rewrites <Log>.status.json with the last complete timecode; every 30 s it appends one
# JSON line of window statistics to <Log>; gaps, breaks in order and jumps go to <Log>.events.jsonl.
# It closes when <Log>.stop appears or after HoldSeconds.
param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][int]$HoldSeconds, [Parameter(Mandatory)][string]$Log)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class MtcReceiver {
  public delegate void MidiInProc(IntPtr handle, uint message, IntPtr instance, IntPtr param1, IntPtr param2);
  [DllImport("winmm.dll")] static extern uint midiInGetNumDevs();
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern uint midiInGetDevCapsW(UIntPtr id, byte[] caps, uint size);
  [DllImport("winmm.dll")] static extern uint midiInOpen(out IntPtr handle, uint id, MidiInProc callback, IntPtr instance, uint flags);
  [DllImport("winmm.dll")] static extern uint midiInStart(IntPtr handle);
  [DllImport("winmm.dll")] static extern uint midiInStop(IntPtr handle);
  [DllImport("winmm.dll")] static extern uint midiInClose(IntPtr handle);
  // Kept in a static field so the driver's callback target is never collected.
  static readonly MidiInProc Callback = Receive;
  static IntPtr input;
  static readonly object Gate = new object();
  // Every gap over 50 ms, break in order and jump, with its Unix time, for matching against song starts.
  public static readonly ConcurrentQueue<string> Events = new ConcurrentQueue<string>();
  static double UnixMs() { return (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }
  // Window counters (reset by Window) and totals.
  static long qf, cycles, outOfOrder, fullFrames, other, jumps, stops, gaps20, gaps50, gaps100;
  static double maxGapMs;
  static long totalQf, totalCycles, totalOutOfOrder, totalFullFrames, totalJumps, totalStops, totalGaps50, totalGaps100;
  static double totalMaxGapMs;
  static long lastQfTicks;
  static int expected = 0; static readonly int[] parts = new int[8];
  static long previousCycleFrames = -1;
  static long lastTcMs = -1; static double lastTcAtUnixMs; static int lastFps;
  static readonly double TickMs = 1000.0 / Stopwatch.Frequency;
  static int Fps(int rate) { return rate == 0 ? 24 : rate == 1 ? 25 : 30; }
  static void Quarter(byte data) {
    long now = Stopwatch.GetTimestamp();
    lock (Gate) {
      qf++; totalQf++;
      if (lastQfTicks != 0) {
        double gap = (now - lastQfTicks) * TickMs;
        if (gap >= 500) { stops++; totalStops++; previousCycleFrames = -1; expected = 0; Events.Enqueue(string.Format("{{\"at\":{0:F0},\"kind\":\"stop\",\"ms\":{1:F1}}}", UnixMs(), gap)); }
        else {
          if (gap > maxGapMs) maxGapMs = gap; if (gap > totalMaxGapMs) totalMaxGapMs = gap;
          if (gap > 20) gaps20++; if (gap > 50) { gaps50++; totalGaps50++; Events.Enqueue(string.Format("{{\"at\":{0:F0},\"kind\":\"gap\",\"ms\":{1:F1}}}", UnixMs(), gap)); } if (gap > 100) { gaps100++; totalGaps100++; }
        }
      }
      lastQfTicks = now;
      int piece = data >> 4, value = data & 15;
      // After a break in order, wait for the next piece 0 without counting each skipped piece again.
      if (expected == -1) { if (piece != 0) return; expected = 0; }
      if (piece != expected) {
        outOfOrder++; totalOutOfOrder++; previousCycleFrames = -1;
        Events.Enqueue(string.Format("{{\"at\":{0:F0},\"kind\":\"order\",\"piece\":{1},\"expected\":{2}}}", UnixMs(), piece, expected));
        if (piece != 0) { expected = -1; return; }
      }
      parts[piece] = value; expected = piece + 1;
      if (piece < 7) return;
      expected = 0; cycles++; totalCycles++;
      int frames = parts[0] | (parts[1] << 4), seconds = parts[2] | (parts[3] << 4), minutes = parts[4] | (parts[5] << 4);
      int hours = parts[6] | ((parts[7] & 1) << 4), fps = Fps((parts[7] >> 1) & 3);
      long total = ((hours * 60L + minutes) * 60L + seconds) * fps + frames;
      if (previousCycleFrames >= 0 && total != previousCycleFrames + 2) { jumps++; totalJumps++; Events.Enqueue(string.Format("{{\"at\":{0:F0},\"kind\":\"jump\",\"from\":{1},\"to\":{2}}}", UnixMs(), previousCycleFrames, total)); }
      previousCycleFrames = total;
      // The cycle carries the frame of its first quarter frame; it completes about two frames later.
      lastTcMs = (long)Math.Round((total + 2) * 1000.0 / fps); lastFps = fps;
      lastTcAtUnixMs = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
    }
  }
  // Short messages only: full-frame SysEx needs input buffers and is not counted (a relocation shows as a jump).
  static void Receive(IntPtr handle, uint message, IntPtr instance, IntPtr param1, IntPtr param2) {
    if (message != 0x3C3) return;
    long data = (long)param1;
    if ((data & 0xFF) == 0xF1) { Quarter((byte)((data >> 8) & 0xFF)); return; }
    lock (Gate) other++;
  }
  public static string Open(string name) {
    int found = -1;
    for (uint i = 0; i < midiInGetNumDevs(); i++) {
      var caps = new byte[80]; midiInGetDevCapsW((UIntPtr)i, caps, 80);
      if (System.Text.Encoding.Unicode.GetString(caps, 8, 64).TrimEnd('\0') == name) { if (found >= 0) return "MIDI 输入不唯一：" + name; found = (int)i; }
    }
    if (found < 0) return "找不到 MIDI 输入：" + name;
    uint opened = midiInOpen(out input, (uint)found, Callback, IntPtr.Zero, 0x30000);
    if (opened != 0) return "打开 MIDI 输入失败：" + opened;
    uint started = midiInStart(input);
    return started == 0 ? null : "启动 MIDI 输入失败：" + started;
  }
  public static void Close() { midiInStop(input); midiInClose(input); }
  public static string Status() {
    lock (Gate) {
      return string.Format("{{\"lastTcMs\":{0},\"lastTcAtUnixMs\":{1:F1},\"fps\":{2},\"totalQf\":{3},\"lastFull\":\"\"}}", lastTcMs, lastTcAtUnixMs, lastFps, totalQf);
    }
  }
  public static string Window(string at) {
    lock (Gate) {
      string line = string.Format("{{\"at\":\"{0}\",\"qf\":{1},\"cycles\":{2},\"outOfOrder\":{3},\"fullFrames\":{4},\"other\":{5},\"jumps\":{6},\"stops\":{7},\"gaps20\":{8},\"gaps50\":{9},\"gaps100\":{10},\"maxGapMs\":{11:F2},"
        + "\"total\":{{\"qf\":{12},\"cycles\":{13},\"outOfOrder\":{14},\"fullFrames\":{15},\"jumps\":{16},\"stops\":{17},\"gaps50\":{18},\"gaps100\":{19},\"maxGapMs\":{20:F2}}}}}",
        at, qf, cycles, outOfOrder, fullFrames, other, jumps, stops, gaps20, gaps50, gaps100, maxGapMs,
        totalQf, totalCycles, totalOutOfOrder, totalFullFrames, totalJumps, totalStops, totalGaps50, totalGaps100, totalMaxGapMs);
      totalFullFrames += fullFrames;
      qf = cycles = outOfOrder = fullFrames = other = jumps = stops = gaps20 = gaps50 = gaps100 = 0; maxGapMs = 0;
      return line;
    }
  }
}
'@
$failure = [MtcReceiver]::Open($Name)
if ($failure) { "{`"error`":`"$failure`"}" | Add-Content $Log; throw $failure }
"{`"opened`":`"$(Get-Date -Format o)`",`"port`":`"$Name`"}" | Add-Content $Log
$deadline = (Get-Date).AddSeconds($HoldSeconds); $nextWindow = (Get-Date).AddSeconds(30)
try {
  while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath "$Log.stop")) {
    Start-Sleep -Milliseconds 1000
    $event = $null; while ([MtcReceiver]::Events.TryDequeue([ref]$event)) { $event | Add-Content "$Log.events.jsonl" }
    [IO.File]::WriteAllText("$Log.status.json", [MtcReceiver]::Status())
    if ((Get-Date) -ge $nextWindow) { [MtcReceiver]::Window((Get-Date -Format o)) | Add-Content $Log; $nextWindow = $nextWindow.AddSeconds(30) }
  }
} finally {
  [MtcReceiver]::Window((Get-Date -Format o)) | Add-Content $Log
  [MtcReceiver]::Close()
  "{`"closed`":`"$(Get-Date -Format o)`"}" | Add-Content $Log
}
