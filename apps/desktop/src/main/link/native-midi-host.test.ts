import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type ActionMidiRecovery, type NativeMidiChannelState } from './native-midi-host';
import { MidiOutputFailure } from './native-midi-output';
import { frameNumberToTimecode } from '@tb/core/link';

function fixture(cueFrames: readonly number[] = [0]) {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台 MIDI 宿主'), playbackSource: 'internal', rundown: [{ id: 'song', title: '节目',
    cues: cueFrames.map((frame, index) => ({ id: `cue-${index}`, name: `动作 ${index + 1}`, timecode: frameNumberToTimecode(frame, '30'),
      actions: [{ id: `pc-${index}`, label: `PC ${index + 1}`, kind: 'midi.programChange' as const, portProfileId: 'out', channel: 1, program: index + 1 }] })) }] });
  let audio: NativePlayerStatus = { version: 1, sessionId: '4d081ed2-7f76-44c8-9c45-b0e06e860870', generation: 1, itemId: 'song',
    status: 'ready', positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '验收',
    mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  const identity = { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId };
  const ports = { prepare: vi.fn<() => Promise<void>>(() => Promise.resolve()), send: vi.fn<() => Promise<void>>(() => Promise.resolve()), close: vi.fn<() => Promise<void>>(() => Promise.resolve()) };
  const states: NativeMidiChannelState[] = [], errors: string[] = [], faults: [string, string][] = [], recovered: [ActionMidiRecovery, string][] = [];
  // The failure callback of the latest port session: what a driver helper reports when its port goes away.
  let failed: (error: Error) => void = () => undefined;
  const outputs = vi.fn<() => Promise<{ id: number; name: string }[]>>(() => Promise.resolve([{ id: 3, name: 'TBLINK CUE' }]));
  const host = new NativeMidiHost({ audio: () => audio, profile: () => null, executable: 'unused', now: () => 1000,
    authorize: () => Promise.resolve(), ports: report => { failed = report; return ports; }, changed: state => states.push(state), error: message => errors.push(message),
    fault: (message, itemId) => faults.push([message, itemId]), outputs, recovered: (report, itemId) => recovered.push([report, itemId]) });
  const observe = (patch: Partial<NativePlayerStatus>, qpc: string | null = '10000000') => { audio = { ...audio, ...patch }; host.observe(audio, qpc); };
  const unplug = (code = 6) => failed(new MidiOutputFailure(`MIDI 输出失败：接口已断开（错误码 ${code}）`, code, 'TBLINK CUE'));
  return { project, host, identity, ports, states, errors, faults, recovered, outputs, observe, unplug, audio: () => audio };
}

it('仅实际设备时钟开始通用 MIDI，音频原始偏移不重复加到歌曲 Cue', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  expect(f.host.status?.state).toBe('ready'); expect(f.ports.send).not.toHaveBeenCalled();
  f.observe({ status: 'playing', generation: 2 }, null); expect(f.ports.send).not.toHaveBeenCalled();
  f.observe({ status: 'playing', generation: 2, positionMs: 20 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  expect(f.ports.send).toHaveBeenCalledWith('out', [0xc0, 1], 1080);
  expect(f.host.status?.state).toBe('running'); expect(f.errors).toEqual([]); await f.host.stop();
});

it('暂停准备等待恢复，重复暂停遥测不撤销尚未开始的已准备通道', async () => {
  const f = fixture(); f.observe({ status: 'paused' }); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'paused' }); expect(f.host.status?.state).toBe('ready'); expect(f.ports.close).not.toHaveBeenCalled();
  f.observe({ status: 'playing', generation: 2 }); await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.host.interrupt({ version: 1, sessionId: f.identity.sessionId, generation: 3, kind: 'pause' });
  await f.host.stop(); expect(f.ports.close).toHaveBeenCalledOnce();
});

it('旧会话、旧代数和无效准备不会关闭当前通道', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity); f.observe({ status: 'playing', generation: 2 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.host.observe({ ...f.audio(), sessionId: 'old', status: 'stopped' }, null);
  f.host.observe({ ...f.audio(), generation: 1, status: 'stopped' }, null);
  f.host.interrupt({ version: 1, sessionId: f.identity.sessionId, generation: 1, kind: 'stop' });
  await expect(f.host.prepare(f.project, { ...f.identity, generation: 9 })).rejects.toThrow('不是当前要播放的这首歌');
  expect(f.host.status?.state).toBe('running'); expect(f.ports.close).not.toHaveBeenCalled(); await f.host.stop();
});

it('准备未完成便播放时明确拒绝参与；晚到准备结果不会启用通道', async () => {
  const f = fixture(); let complete: (() => void) | undefined;
  f.ports.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const prepared = expect(f.host.prepare(f.project, f.identity)).rejects.toThrow('取消');
  await vi.waitFor(() => expect(f.ports.prepare).toHaveBeenCalledOnce());
  f.observe({ status: 'playing', generation: 2 }); complete!(); await prepared;
  expect(f.errors[0]).toContain('还没准备好音频就变了'); expect(f.ports.send).not.toHaveBeenCalled(); await f.host.stop();
});

it('新音频会话替换及停止使旧 MIDI 队列失效，不依赖界面转发', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.observe({ sessionId: 'new', status: 'preparing' }); await f.host.stop();
  expect(f.ports.close).toHaveBeenCalledOnce(); expect(f.ports.send).not.toHaveBeenCalled();
});

it('主进程卡顿后迟到的设备位置：错过的动作标红记录，通道继续运行', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'playing', generation: 2, positionMs: 20 }, '8000000');
  expect(f.faults).toEqual([['播放位置更新中断，错过了 1 个 MIDI 动作，没有补发', 'song']]);
  expect(f.ports.send).not.toHaveBeenCalled(); expect(f.errors).toEqual([]); expect(f.host.status?.state).toBe('running');
  await f.host.stop();
});

it('MIDI 口断开使上一首关闭失败：只报告一次，后面的歌照常准备 MIDI', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.ports.close.mockRejectedValueOnce(new Error('MIDI 驱动服务异常退出：3'));
  await expect(f.host.stop()).rejects.toThrow('异常退出：3');
  await expect(f.host.stop()).resolves.toBeUndefined();
  f.observe({ generation: 2 }); await f.host.prepare(f.project, { ...f.identity, generation: 2 });
  expect(f.host.status?.state).toBe('ready'); expect(f.ports.prepare).toHaveBeenCalledTimes(2);
  // Switching songs while the old channel is open: its close failure is reported, the new song still prepares.
  f.ports.close.mockRejectedValueOnce(new Error('MIDI 驱动服务异常退出：3'));
  f.observe({ generation: 3 }); await f.host.prepare(f.project, { ...f.identity, generation: 3 });
  expect(f.host.status?.state).toBe('ready'); expect(f.ports.prepare).toHaveBeenCalledTimes(3);
  expect(f.errors).toEqual(['关闭上一首的 MIDI 失败：MIDI 驱动服务异常退出：3']);
  await f.host.stop();
});

it('播放中动作 MIDI 接口断开：同一接口回来后从当前位置起照常发送，中断期间的动作不补发', async () => {
  const f = fixture([0, 60, 120]); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'playing', generation: 2, positionMs: 20 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.outputs.mockResolvedValue([]);
  f.unplug();
  expect(f.faults).toEqual([['MIDI 输出失败：接口已断开（错误码 6）', 'song']]); expect(f.errors).toEqual([]); expect(f.host.status?.state).toBe('failed');
  // The action at 2 s falls into the outage; the port is back at 2.5 s.
  f.observe({ positionMs: 2010 }); f.observe({ positionMs: 2500 });
  f.outputs.mockResolvedValue([{ id: 4, name: 'TBLINK CUE' }]);
  await vi.waitFor(() => expect(f.recovered).toHaveLength(1), { timeout: 3000 });
  // The action at 2 s fell into the outage: one skipped, not sent later.
  expect(f.recovered[0]?.[0]).toMatchObject({ portName: 'TBLINK CUE', skippedActions: 1, fault: 'MIDI 输出失败：接口已断开（错误码 6）' });
  expect(f.recovered[0]?.[0].durationMs).toBeGreaterThanOrEqual(0); expect(f.recovered[0]?.[1]).toBe('song');
  expect(f.ports.prepare).toHaveBeenCalledTimes(2); expect(f.host.status?.state).toBe('ready');
  f.observe({ positionMs: 4010 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledTimes(2));
  expect(f.ports.send).toHaveBeenLastCalledWith('out', [0xc0, 3], 1090);
  expect(f.faults).toHaveLength(1); expect(f.errors).toEqual([]);
  await f.host.stop();
});

it('重新打开后首个动作发送失败：继续等待同一接口并再次打开，不当作永久故障', async () => {
  const f = fixture([0, 60, 120]); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'playing', generation: 2, positionMs: 20 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.unplug(); f.observe({ positionMs: 1500 });
  await vi.waitFor(() => expect(f.recovered).toHaveLength(1), { timeout: 3000 });
  // Seen on the dev PC: a port Windows is still creating opens, then its first message fails (error 1).
  f.ports.send.mockImplementationOnce(() => { f.unplug(1); return Promise.reject(new Error('MIDI 输出失败：Windows 错误 1')); });
  f.observe({ positionMs: 2010 }); await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledTimes(2));
  expect(f.faults[1]?.[0]).toContain('动作 MIDI 端口重新打开后，第一个动作没有发出（TBLINK CUE，错误码 1）');
  f.observe({ positionMs: 2500 });
  await vi.waitFor(() => expect(f.recovered).toHaveLength(2), { timeout: 3000 });
  f.observe({ positionMs: 4010 }); await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledTimes(3));
  expect(f.ports.send).toHaveBeenLastCalledWith('out', [0xc0, 3], 1090); expect(f.faults).toHaveLength(2); expect(f.errors).toEqual([]);
  expect(f.recovered[1]?.[0].fault).toContain('第一个动作没有发出');
  await f.host.stop();
});

it('接口断开后暂停或停止：不再等待该接口，也不打开端口', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'playing', generation: 2, positionMs: 20 });
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.unplug();
  f.host.interrupt({ version: 1, sessionId: f.identity.sessionId, generation: 3, kind: 'pause' });
  f.observe({ status: 'paused', generation: 3 });
  await new Promise(resolve => setTimeout(resolve, 1200));
  expect(f.ports.prepare).toHaveBeenCalledOnce(); expect(f.recovered).toEqual([]);
  await f.host.stop();
});
