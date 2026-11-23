import { beforeEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LinkProject, type Ma2ExecutorObservation, type Ma2ExecutorObserveRequest } from '@tb/schema';
import type { ConsoleFollow } from '@tb/core/link';
import { CONSOLE_FOLLOW_IDLE, ConsoleFollowMonitor } from './console-follow-monitor';
import type { Ma2ConnectionMethod } from '../stores/ma2-mode-store';

const network = { host: '192.0.2.10', port: 30000, monitorPort: 30001, username: 'tblink' };
function project(): LinkProject {
  const value = createEmptyLinkProject('控台在跟'); value.schemaVersion = 2;
  const lighting = createLightingDocument();
  lighting.consoleSong = { endpoint: '192.0.2.10:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 501, name: 'GeQu', baselineXml: '<MA/>',
    points: [{ id: 'a', cue: '1', atMs: 2000 }, { id: 'b', cue: '2', atMs: 6000 }], timecode: { number: 501, offset: 14_400, slot: 'TC Slot 1', revision: 'b'.repeat(64) } };
  value.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting,
    referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 40_000 },
    playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: 480_000, shortcut: '' } }];
  return value;
}
let shown: ConsoleFollow[] = [];
let method: Ma2ConnectionMethod = 'network';
let connected: typeof network | null = network;
const observe = vi.fn<(request: Ma2ExecutorObserveRequest) => Promise<Ma2ExecutorObservation>>();
const release = vi.fn(() => Promise.resolve());
const log = vi.fn();
let value = project();
const monitor = () => new ConsoleFollowMonitor({ project: () => value, method: () => method, network: () => Promise.resolve(connected), observe, release,
  publish: follow => { shown.push(follow); }, log });
const clockAt = (positionMs: number, sending = true) => () => ({ positionMs, mtcSentPositionMs: sending ? positionMs : null });
const last = (): ConsoleFollow | undefined => shown.at(-1);
const running = (cue: string): Ma2ExecutorObservation => ({ kind: 'executor', running: true, cue, name: 'GeQu' });
beforeEach(() => { shown = []; method = 'network'; connected = network; value = project(); vi.clearAllMocks(); });

it('第一个点之前等；点触发一秒后读回本曲执行器，Cue 对上就是在跟', async () => {
  const follow = monitor(); follow.start('song', 0);
  expect(release).toHaveBeenCalledOnce();
  await follow.tick(clockAt(1000));
  expect(observe).not.toHaveBeenCalled(); expect(last()).toMatchObject({ state: 'checking', detail: '还没到这次播放的第一个灯光点' });
  observe.mockResolvedValue(running('    1 Kai'));
  await follow.tick(clockAt(3100));
  expect(observe).toHaveBeenCalledWith({ network, page: 1000, slot: 101 });
  expect(last()).toMatchObject({ state: 'following', detail: '执行器 1000.101 在 Cue 1，和时间线一致' });
  await follow.tick(clockAt(4100));
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('info', '控台执行器读回：执行器 1000.101 在 Cue 1，和时间线一致', 'song');
});

it('连续两次对不上显示没在跟并记日志；跟上后再记一笔', async () => {
  const follow = monitor(); follow.start('song', 0);
  observe.mockResolvedValue({ kind: 'executor', running: false, cue: '', name: 'GeQu' });
  await follow.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'checking', misses: 1 });
  await follow.tick(clockAt(4100));
  expect(last()?.state).toBe('not-following'); expect(last()?.detail).toContain('没在跑');
  await follow.tick(clockAt(5000));
  expect(log).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledWith('warning', expect.stringContaining('控台没在跟'), 'song');
  observe.mockResolvedValue(running('    2 Ge'));
  await follow.tick(clockAt(7100));
  expect(last()).toMatchObject({ state: 'following' });
  expect(log).toHaveBeenLastCalledWith('info', expect.stringContaining('控台又跟上了'), 'song');
});

it('本机模式只在已连接本机 onPC 时读取执行器，按实际 Cue 显示跟随', async () => {
  method = 'local';
  const follow = monitor();
  follow.start('song', 0);
  await follow.tick(clockAt(3100));
  expect(observe).not.toHaveBeenCalled();
  expect(last()?.state).toBe('unknown');
  connected = { ...network, host: '127.0.0.1' };
  observe.mockResolvedValue(running('    1 Kai'));
  await follow.tick(clockAt(3100));
  expect(observe).toHaveBeenCalledWith({ network: connected, page: 1000, slot: 101 });
  expect(last()?.state).toBe('following');
});

it('下一个点已到或新读回对不上时，不继续显示上一步已经确认的 Cue', async () => {
  const follow = monitor();
  follow.start('song', 0);
  observe.mockResolvedValue(running('1 Kai'));
  await follow.tick(clockAt(3100));
  expect(last()?.state).toBe('following');
  await follow.tick(clockAt(6100));
  expect(last()).toMatchObject({ state: 'checking', detail: '灯光点刚触发，稍后核对' });
  expect(observe).toHaveBeenCalledTimes(1);
  await follow.tick(clockAt(7100));
  expect(last()).toMatchObject({ state: 'checking', misses: 1 });
  expect(last()?.detail).toContain('应该在 Cue 2');
  await follow.tick(clockAt(8100));
  expect(last()?.state).toBe('not-following');
});

it('同一个点从跟随变为首次不一致时，显示刚读回的情况', async () => {
  const follow = monitor();
  follow.start('song', 0);
  observe.mockResolvedValueOnce(running('1 Kai')).mockResolvedValueOnce(running('2 Ge'));
  await follow.tick(clockAt(3100));
  await follow.tick(clockAt(4100));
  expect(last()).toMatchObject({ state: 'checking', misses: 1 });
  expect(last()?.detail).toContain('现在在 Cue 2');
  expect(log).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('info', expect.stringContaining('控台执行器读回'), 'song');
});

it('只接 MIDI、时间码没发出、网络没连上：如实写无法确认，条件恢复后接着核对', async () => {
  const follow = monitor(); follow.start('song', 0);
  method = 'midi'; await follow.tick(clockAt(3100));
  expect(last()?.state).toBe('unknown'); expect(last()?.detail).toContain('只接了 MIDI 线');
  method = 'network'; await follow.tick(clockAt(3100, false));
  expect(last()).toMatchObject({ state: 'unknown', detail: '时间码没有发出，控台不会跟着跑' });
  connected = null; await follow.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'unknown', detail: '控台网络没连上，读不到控台' });
  await follow.tick(clockAt(4100));
  expect(log.mock.calls.filter(([, message]) => String(message).includes('控台网络没连上'))).toHaveLength(1);
  expect(log).toHaveBeenCalledWith('info', '无法确认控台执行器：只接了 MIDI 线，联动台读不到控台；控台在不在跑灯请看控台', 'song');
  connected = network; observe.mockResolvedValue(running('    1 Kai'));
  await follow.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'following' });
  expect(observe).toHaveBeenCalledOnce();
});

it('读不到执行器：这首歌不再读，不自动重试；下一首重新开始', async () => {
  const follow = monitor(); follow.start('song', 0);
  observe.mockRejectedValueOnce(new Error('实时推杆读取超时，请重新连接'));
  await follow.tick(clockAt(3100));
  expect(last()).toEqual({ state: 'unknown', detail: '读不到控台执行器状态：实时推杆读取超时，请重新连接。这首歌不再核对', misses: 0 });
  await follow.tick(clockAt(4100));
  expect(observe).toHaveBeenCalledOnce();
  follow.start('song', 0);
  expect(release).toHaveBeenCalledOnce();
  follow.idle(); expect(last()).toEqual(CONSOLE_FOLLOW_IDLE);
  follow.start('song', 0); expect(release).toHaveBeenCalledTimes(2);
  observe.mockResolvedValue(running('    1 Kai'));
  await follow.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'following' });
});

it('没连过网页遥控、控台上还没有本曲节目：说明原因', async () => {
  const follow = monitor(); follow.start('song', 0);
  observe.mockResolvedValue({ kind: 'unavailable', reason: '这台控台还没连过网页遥控（灯光工作台推杆页的“连接”）' });
  await follow.tick(clockAt(3100));
  expect(last()?.state).toBe('unknown'); expect(last()?.detail).toContain('网页遥控');
  expect(log).toHaveBeenCalledWith('info', expect.stringContaining('无法确认控台执行器：这台控台还没连过网页遥控'), 'song');
  value = project(); delete value.rundown[0]!.lighting!.consoleSong!.timecode;
  const other = monitor(); other.start('song', 0); await other.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'unknown', detail: '控台上还没有这首歌的时间码节目' });
});

it('定位后只核对这次经过的点', async () => {
  const follow = monitor(); follow.start('song', 0);
  follow.start('song', 4000);
  await follow.tick(clockAt(5000));
  expect(observe).not.toHaveBeenCalled(); expect(last()).toMatchObject({ state: 'checking' });
});

it('同一首歌读执行器期间已到下一步，迟到的上一步回执不算确认', async () => {
  const follow = monitor(); follow.start('song', 0);
  let reply!: (observation: Ma2ExecutorObservation) => void;
  observe.mockImplementationOnce(() => new Promise(resolve => { reply = resolve; }));
  let clock = clockAt(3100);
  const first = follow.tick(() => clock());
  await Promise.resolve();
  clock = clockAt(7100);
  reply(running('1 Kai'));
  await first;
  expect(last()?.state).toBe('checking');
  expect(log).not.toHaveBeenCalled();
  observe.mockResolvedValue(running('2 Ge'));
  await follow.tick(clockAt(7200));
  expect(last()).toMatchObject({ state: 'following', detail: '执行器 1000.101 在 Cue 2，和时间线一致' });
});

it('已经切到下一首时，上一轮关闭读取的迟到错误不再影响当前歌曲', async () => {
  let rejectRelease!: (error: Error) => void;
  release.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectRelease = reject; }));
  const follow = monitor();
  follow.start('上一首', 0);
  follow.start('song', 0);
  rejectRelease(new Error('旧连接已关闭'));
  await Promise.resolve();
  observe.mockResolvedValue(running('1'));
  await follow.tick(clockAt(3100));
  expect(last()).toMatchObject({ state: 'following' });
});
