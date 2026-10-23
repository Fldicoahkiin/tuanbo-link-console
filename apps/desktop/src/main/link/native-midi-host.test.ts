import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativePlayerStatus } from '@tb/schema';
import { NativeMidiHost, type NativeMidiChannelState } from './native-midi-host';
import { frameNumberToTimecode } from '@tb/core/link';

function fixture() {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台 MIDI 宿主'), playbackSource: 'internal', rundown: [{ id: 'song', title: '节目',
    cues: [{ id: 'cue', name: '动作', timecode: frameNumberToTimecode(0, '30'), actions: [{ id: 'pc', label: 'PC', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 1 }] }] }] });
  let audio: NativePlayerStatus = { version: 1, sessionId: '4d081ed2-7f76-44c8-9c45-b0e06e860870', generation: 1, itemId: 'song',
    status: 'ready', positionMs: 0, offsetMs: 480000, sampleRate: 48000, enginePid: 1, engineTitle: '验收',
    mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null, underruns: 0, mtcInterruptions: 0, gain: 1, analysis: null };
  const identity = { sessionId: audio.sessionId, generation: audio.generation, itemId: audio.itemId };
  const ports = { prepare: vi.fn<() => Promise<void>>(() => Promise.resolve()), send: vi.fn<() => Promise<void>>(() => Promise.resolve()), close: vi.fn<() => Promise<void>>(() => Promise.resolve()) };
  const states: NativeMidiChannelState[] = [], errors: string[] = [], faults: [string, string][] = [];
  const host = new NativeMidiHost({ audio: () => audio, profile: () => null, executable: 'unused', now: () => 1000,
    authorize: () => Promise.resolve(), ports: () => ports, changed: state => states.push(state), error: message => errors.push(message),
    fault: (message, itemId) => faults.push([message, itemId]) });
  const observe = (patch: Partial<NativePlayerStatus>, qpc: string | null = '10000000') => { audio = { ...audio, ...patch }; host.observe(audio, qpc); };
  return { project, host, identity, ports, states, errors, faults, observe, audio: () => audio };
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
  await expect(f.host.prepare(f.project, { ...f.identity, generation: 9 })).rejects.toThrow('不属于当前');
  expect(f.host.status?.state).toBe('running'); expect(f.ports.close).not.toHaveBeenCalled(); await f.host.stop();
});

it('准备未完成便播放时明确拒绝参与；晚到准备结果不会启用通道', async () => {
  const f = fixture(); let complete: (() => void) | undefined;
  f.ports.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const prepared = expect(f.host.prepare(f.project, f.identity)).rejects.toThrow('取消');
  await vi.waitFor(() => expect(f.ports.prepare).toHaveBeenCalledOnce());
  f.observe({ status: 'playing', generation: 2 }); complete!(); await prepared;
  expect(f.errors[0]).toContain('准备完成前音频已改变'); expect(f.ports.send).not.toHaveBeenCalled(); await f.host.stop();
});

it('新音频会话替换及停止使旧 MIDI 队列失效，不依赖界面转发', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.observe({ sessionId: 'new', status: 'preparing' }); await f.host.stop();
  expect(f.ports.close).toHaveBeenCalledOnce(); expect(f.ports.send).not.toHaveBeenCalled();
});

it('主进程卡顿后迟到的设备位置：错过的动作标红记录，通道继续运行', async () => {
  const f = fixture(); await f.host.prepare(f.project, f.identity);
  f.observe({ status: 'playing', generation: 2, positionMs: 20 }, '8000000');
  expect(f.faults).toEqual([['播放位置更新中断，错过 1 个 MIDI 动作，未补发', 'song']]);
  expect(f.ports.send).not.toHaveBeenCalled(); expect(f.errors).toEqual([]); expect(f.host.status?.state).toBe('running');
  await f.host.stop();
});
