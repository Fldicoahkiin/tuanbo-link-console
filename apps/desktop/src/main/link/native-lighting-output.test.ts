import { expect, it, vi } from 'vitest';
import { createLightingDocument, lightingTrackSchema, type Ma2NetworkStatus } from '@tb/schema';
import { NativeLightingOutput } from './native-lighting-output';

function fixture() {
  const document = createLightingDocument(); document.outputMode = 'direct';
  document.tracks = [lightingTrackSchema.parse({ id: 'notes', name: '灯光音符', kind: 'midi', portProfileId: 'out', channel: 1,
    color: '#ffffff', group: '', muted: false, solo: false, locked: false, controller: 7, noteNames: {},
    clips: [{ id: 'clip', name: '脉冲', start: 0, duration: 2000, timeLock: 'time', muted: false, events: [
      { id: 'note', at: 0, kind: 'note', note: 60, velocity: 100, duration: 1000 }
    ] }] })];
  const ports = { prepare: vi.fn<() => Promise<void>>(() => Promise.resolve()), send: vi.fn<(port: string, bytes: number[], deadline: number) => Promise<void>>(() => Promise.resolve()), close: vi.fn<() => Promise<void>>(() => Promise.resolve()) };
  const errors: string[] = [];
  const status: Ma2NetworkStatus = { state: 'connected', settings: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false }, passwordSaved: false, version: null, error: null };
  const network = { getMa2NetworkStatus: vi.fn(() => Promise.resolve(status)), cancelMa2Playback: vi.fn<() => Promise<void>>(() => Promise.resolve()), playMa2Cue: vi.fn<() => Promise<void>>(() => Promise.resolve()) };
  let now = 1000;
  const output = new NativeLightingOutput({ executable: 'unused', network, now: () => now, authorize: () => Promise.resolve(), ports: () => ports, error: message => errors.push(message) });
  return { document, ports, output, errors, network, time: (value: number) => { now = value; } };
}

it('直接灯光由设备位置调用；曲尾提前释放使用当前位置，不沿用旧 Note On 截止时间', async () => {
  const f = fixture(); await f.output.prepare(f.document, null, 0);
  expect(f.ports.send).not.toHaveBeenCalled(); f.output.observe(0, 1000); f.output.tick(0);
  await vi.waitFor(() => expect(f.ports.send).toHaveBeenCalledOnce());
  f.output.observe(500, 1000); await f.output.finish(500);
  expect(f.ports.send.mock.calls).toEqual([['out', [0x90, 60, 100], 1100], ['out', [0x80, 60, 0], 1100]]);
  expect(f.errors).toEqual([]); await f.output.close();
});

it('时间码模式保留控台原生执行，不额外发送本地 MIDI 或网络灯光', async () => {
  const f = fixture(); f.document.outputMode = 'timecode';
  await f.output.prepare(f.document, null, 0); f.output.observe(500, 1000); f.output.tick(500);
  expect(f.output.takeFault()).toBeNull();
  await f.output.finish(500); expect(f.ports.prepare).toHaveBeenCalledWith([], expect.any(AbortSignal));
  expect(f.ports.send).not.toHaveBeenCalled(); expect(f.network.getMa2NetworkStatus).not.toHaveBeenCalled();
  expect(f.network.playMa2Cue).not.toHaveBeenCalled(); await f.output.close();
});

it('旧灯光清理完成前不打开下一轮，清理失败不能宣称下一首灯光就绪', async () => {
  const f = fixture(); await f.output.prepare(f.document, null, 0);
  let rejectClose: ((error: Error) => void) | undefined;
  f.ports.close.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectClose = reject; }));
  const next = expect(f.output.prepare(f.document, null, 0)).rejects.toThrow('驱动未退出');
  await vi.waitFor(() => expect(f.ports.close).toHaveBeenCalledOnce());
  expect(f.ports.prepare).toHaveBeenCalledOnce(); rejectClose!(new Error('驱动未退出')); await next;
  await expect(f.output.close()).rejects.toThrow('驱动未退出'); expect(f.ports.prepare).toHaveBeenCalledOnce();
});

it('端口准备途中停止不会产生迟到灯光；关闭等待已打开的驱动', async () => {
  const f = fixture(); let complete: (() => void) | undefined;
  f.ports.prepare.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const prepared = expect(f.output.prepare(f.document, null, 0)).rejects.toThrow('已取消');
  await vi.waitFor(() => expect(f.ports.prepare).toHaveBeenCalledOnce());
  f.output.stop(); complete!(); await prepared; await f.output.close(); expect(f.ports.send).not.toHaveBeenCalled();
});

it('过期位置本次不发送并标红，通道继续；与音频不一致的位置仍拒绝，不让 UI 的播放头成为输出时钟', async () => {
  const f = fixture(); await f.output.prepare(f.document, null, 0); f.output.observe(0, 899);
  expect(() => f.output.tick(0)).not.toThrow(); expect(f.ports.send).not.toHaveBeenCalled();
  expect(f.output.takeFault()).toContain('晚了'); expect(f.output.takeFault()).toBeNull();
  f.output.observe(0, 1000); expect(() => f.output.tick(1)).toThrow('对不上');
  await f.output.close();
});

it('驱动拒绝某条发送时标红并继续，曲尾照常完成，错误不被吞掉', async () => {
  const f = fixture(); f.ports.send.mockRejectedValueOnce(new Error('端口已拔除')); await f.output.prepare(f.document, null, 0);
  f.output.observe(1, 1000); await expect(f.output.finish(1)).resolves.toBeUndefined();
  expect(f.output.takeFault()).toContain('端口已拔除'); await f.output.close();
});

it('卡顿后按当前位置重建并标红：仍应按住的音符此刻发出，中间事件不补发，之后照常释放', async () => {
  const f = fixture(); await f.output.prepare(f.document, null, 0);
  f.time(1500); f.output.observe(500, 1450); f.output.tick(500);
  expect(f.ports.send.mock.calls).toEqual([['out', [0x90, 60, 100], 1550]]);
  expect(f.output.takeFault()).toBe('灯光位置更新中断了 500 ms，已按当前位置恢复（发送 1 条），中间错过的事件不补发');
  f.time(2100); f.output.observe(1100, 2050); f.output.tick(1100);
  expect(f.ports.send.mock.calls[1]).toEqual(['out', [0x80, 60, 0], 2150]);
  await f.output.close();
});

it('暂停后继续按当前位置重建：补发仍按住的音符，控台上已在的执行器 Cue 不重发；停止后下一次播放不沿用', async () => {
  const f = fixture();
  f.document.tracks[0]!.clips[0]!.events.push({ id: 'cue', kind: 'ma2', at: 0, action: 'goto', cue: '1', sequence: 1, executor: '1.101', label: 'A' });
  await f.output.prepare(f.document, null, 0); f.output.observe(0, 1000); f.output.tick(0);
  f.output.observe(80, 1000); f.output.tick(80); expect(f.ports.send).toHaveBeenCalledTimes(2);
  f.output.stop(); f.ports.send.mockClear();
  await f.output.prepare(f.document, null, 80);
  expect(f.ports.send.mock.calls.map(call => call[1])).toEqual([[0x90, 60, 100]]);
  expect(f.output.takeFault()).toBe('灯光已按播放位置恢复（发送 1 条），中间错过的事件不补发');
  f.output.stop(); await f.output.release(); f.ports.send.mockClear();
  await f.output.prepare(f.document, null, 80);
  expect(f.ports.send.mock.calls.map(call => call[1][0])).toEqual([0x90, 0xf0]);
  await f.output.close();
});
