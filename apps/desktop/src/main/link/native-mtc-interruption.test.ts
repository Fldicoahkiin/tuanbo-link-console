import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { NativePlaybackClient } from './native-playback-client';

const portsSchema = z.object({ outputs: z.array(z.object({ id: z.number().int(), name: z.string() })) });

/** Stalls only the MTC worker, the engine's single MMCSS critical-priority thread
 * (base priority 26; audio runs at 24). Audio keeps rendering, as in the field case
 * where the worker woke 33.5 ms late after 111 minutes. */
function stallMtcWorker(pid: number, milliseconds: number): void {
  const script = 'Add-Type -Name Thread -Namespace Tblink -MemberDefinition \'[DllImport("kernel32.dll")] public static extern IntPtr OpenThread(int access, bool inherit, int id); [DllImport("kernel32.dll")] public static extern int SuspendThread(IntPtr h); [DllImport("kernel32.dll")] public static extern int ResumeThread(IntPtr h); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);\'; '
    + `$workers = @((Get-Process -Id ${pid}).Threads | Where-Object { $_.BasePriority -ge 25 }); if ($workers.Count -ne 1) { throw "expected one critical MTC thread, found $($workers.Count)" }; `
    + '$handle = [Tblink.Thread]::OpenThread(2, $false, $workers[0].Id); if ($handle -eq [IntPtr]::Zero) { throw "OpenThread failed" }; '
    + `try { [void][Tblink.Thread]::SuspendThread($handle); Start-Sleep -Milliseconds ${milliseconds}; [void][Tblink.Thread]::ResumeThread($handle) } finally { [void][Tblink.Thread]::CloseHandle($handle) }`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20_000 });
}

// Uses the dedicated loopback port; never a console's port.
it.skipIf(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1')('真实引擎：时间码短暂中断后按实际位置整帧重新同步并继续发送，不在本首歌内永久停止', async () => {
  const executable = resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');
  const ports = portsSchema.parse(JSON.parse(execFileSync(join(dirname(executable), 'tblink-playback-probe.exe'), ['--list'], { encoding: 'utf8', windowsHide: true })));
  const port = ports.outputs.filter(entry => entry.name === 'TBLINK SOAK MTC');
  expect(port).toHaveLength(1);
  const directory = await mkdtemp(join(tmpdir(), 'tblink-mtc-interruption-')), path = join(directory, 'silence.pcm');
  await writeFile(path, Buffer.alloc(48000 * 4 * 10));
  const failures: string[] = [];
  let clocks = 0;
  const client = new NativePlaybackClient(executable, event => { if (event.kind === 'clock') clocks++; }, error => failures.push(error.message));
  try {
    await client.start();
    await client.command({ protocol: 4, requestId: 1, generation: 1, kind: 'prepare', pcmPath: path, sampleRate: 48000, frameRate: 30,
      midiDevice: port[0]!.id, startMs: 0, endMs: 9000, offsetMs: 480000, volume: 1 });
    await client.command({ protocol: 4, requestId: 2, generation: 2, kind: 'play' });
    await expect.poll(() => client.clock?.midiSent ?? 0).toBeGreaterThan(40);
    const before = clocks;
    stallMtcWorker(client.identity!.pid, 300);
    await expect.poll(() => clocks, { timeout: 3000 }).toBeGreaterThan(before + 10);
    await expect.poll(() => client.clock?.midiInterruptions ?? 0, { timeout: 3000 }).toBeGreaterThan(0);
    const resumedFrom = client.clock!.midiSent;
    await expect.poll(() => client.clock?.midiSent ?? 0, { timeout: 3000 }).toBeGreaterThan(resumedFrom + 40);
    expect(client.clock).toMatchObject({ state: 'playing', midiError: 0 });
    expect(failures).toEqual([]);
  } finally {
    console.info('时间码中断证据', JSON.stringify({ clocks, failures, state: client.clock?.state, positionMs: client.clock?.positionMs, midiSent: client.clock?.midiSent, midiError: client.clock?.midiError,
      midiInterruptions: client.clock?.midiInterruptions, midiInterruption: client.clock?.midiInterruption, maxMidiLatenessMs: client.clock?.maxMidiLatenessMs }));
    await client.close();
  }
}, 20_000);
