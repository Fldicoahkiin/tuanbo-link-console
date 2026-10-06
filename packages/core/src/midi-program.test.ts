import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { MidiProgramSession } from './midi-program';

const note = (id: string, durationMs = 100): LinkAction => ({ id, label: id, kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100, durationMs });
function fixture(cues: { frame: number; actions: LinkAction[] }[]) {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台 MIDI'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲',
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, name: `Cue ${index}`, timecode: frameNumberToTimecode(cue.frame, '30'), actions: cue.actions })) }] });
  let now = 1000;
  const sent: number[][] = [], errors: Error[] = [];
  const send = vi.fn<(port: string, bytes: readonly number[], deadline: number) => Promise<void>>((_port, bytes) => { sent.push([...bytes]); return Promise.resolve(); });
  const prepare = vi.fn<(ports: readonly string[], signal: AbortSignal) => Promise<void>>(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve()), reported = vi.fn();
  const session = new MidiProgramSession(project, 'song', { prepare, send, close, now: () => now, sent: reported, failed: error => errors.push(error) });
  const clock = async (position: number) => { now = 1000 + position; session.clock(position, now); await session.settled(); };
  return { session, send, sent, errors, prepare, close, reported, clock, time: (value: number) => { now = value; } };
}

it('依音频位置释放脉冲，中间的其他 Cue 不被 Note 持续时长阻塞，也不发送 OBS 动作', async () => {
  const f = fixture([{ frame: 0, actions: [note('pulse', 200), { id: 'obs', label: '画面', kind: 'obs.setProgramScene', sceneName: '机位' }] },
    { frame: 3, actions: [{ id: 'cc', label: 'CC', kind: 'midi.controlChange', portProfileId: 'out', channel: 2, controller: 7, value: 64 }] }]);
  await f.session.prepare(0); expect(f.prepare.mock.calls[0]?.[0]).toEqual(['out']);
  expect(f.sent).toEqual([]); await f.clock(0); await f.clock(100);
  expect(f.sent).toEqual([[0x90, 60, 100], [0xb1, 7, 64]]);
  await f.clock(199); expect(f.sent).toHaveLength(2); await f.clock(200);
  expect(f.sent.at(-1)).toEqual([0x80, 60, 0]); expect(f.errors).toEqual([]); await f.session.close();
});

it('同音高重叠脉冲不会在前一脉冲结束时误关后一脉冲', async () => {
  const f = fixture([{ frame: 0, actions: [note('first', 200)] }, { frame: 3, actions: [note('second', 200)] }]);
  await f.session.prepare(0); await f.clock(0); await f.clock(100); await f.clock(200);
  expect(f.sent).toEqual([[0x90, 60, 100], [0x90, 60, 100]]);
  await f.clock(300); expect(f.sent.at(-1)).toEqual([0x80, 60, 0]); await f.session.close();
});

it('从中间准备不补发 Note On，也不发送其未来的无主释放；时钟重复不重发', async () => {
  const f = fixture([{ frame: 0, actions: [note('past', 200)] }, { frame: 9, actions: [note('future', 100)] }]);
  await f.session.prepare(100); await f.clock(200); expect(f.sent).toEqual([]);
  await f.clock(300); await f.clock(300); await f.clock(400);
  expect(f.sent).toEqual([[0x90, 60, 100], [0x80, 60, 0]]); await f.session.close();
});

it('停止立即取消未发队列，旧确认和未来释放不能污染下一节目', async () => {
  const f = fixture([{ frame: 0, actions: [note('a'), note('b')] }]);
  let resolve: (() => void) | undefined;
  f.send.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  await f.session.prepare(0); f.session.clock(0, 1000); await Promise.resolve();
  const closing = f.session.close(); await Promise.resolve(); expect(f.close).toHaveBeenCalledOnce();
  resolve!(); await closing; await f.clock(100);
  expect(f.send).toHaveBeenCalledOnce(); expect(f.reported).not.toHaveBeenCalled(); expect(f.session.pendingCount).toBe(0);
});

it('过期或倒退时钟会关闭通道，不在恢复后的播放头补发', async () => {
  const f = fixture([{ frame: 0, actions: [note('a')] }]); await f.session.prepare(0);
  f.time(1101); f.session.clock(0, 1000); await f.session.settled(); await f.session.close();
  expect(f.errors[0]?.message).toContain('过期'); expect(f.send).not.toHaveBeenCalled();
  const backwards = fixture([{ frame: 0, actions: [note('a')] }]); await backwards.session.prepare(100);
  await backwards.clock(99); expect(backwards.errors[0]?.message).toContain('倒退'); await backwards.session.close();
});

it('设备时钟虽新但跨过动作截止边界，也不能补发历史 Cue', async () => {
  const f = fixture([{ frame: 0, actions: [note('a')] }]); await f.session.prepare(0);
  await f.clock(101); expect(f.send).not.toHaveBeenCalled(); expect(f.errors[0]?.message).toContain('100ms'); await f.session.close();
});

it('输出失败清除本轮队列，不将后续动作报告成功、不自动重试', async () => {
  const f = fixture([{ frame: 0, actions: [note('a'), note('b')] }]);
  f.send.mockRejectedValueOnce(new Error('驱动断开')); await f.session.prepare(0); await f.clock(0); await f.session.close();
  expect(f.send).toHaveBeenCalledOnce(); expect(f.reported).not.toHaveBeenCalled(); expect(f.errors[0]?.message).toBe('驱动断开');
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});
