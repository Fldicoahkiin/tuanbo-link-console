import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import { frameNumberToTimecode } from './mtc-timecode';
import { MidiProgramSession } from './midi-program';
import { MidiMessageSkipped } from './midi-late-rule';
import type { OutputMode } from './output-failure';

const note = (id: string, durationMs = 100): LinkAction => ({ id, label: id, kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100, durationMs });
function fixture(cues: { frame: number; actions: LinkAction[] }[], mode: OutputMode = 'live') {
  const project = parseLinkProject({ ...createEmptyLinkProject('后台 MIDI'), playbackSource: 'internal', rundown: [{ id: 'song', title: '歌曲',
    cues: cues.map((cue, index) => ({ id: `cue-${index}`, name: `Cue ${index}`, timecode: frameNumberToTimecode(cue.frame, '30'), actions: cue.actions })) }] });
  let now = 1000;
  const sent: number[][] = [], errors: Error[] = [], missed: string[] = [], late: string[] = [];
  const send = vi.fn<(port: string, bytes: readonly number[], deadline: number) => Promise<void>>((_port, bytes) => { sent.push([...bytes]); return Promise.resolve(); });
  const prepare = vi.fn<(ports: readonly string[], signal: AbortSignal) => Promise<void>>(() => Promise.resolve());
  const close = vi.fn(() => Promise.resolve()), reported = vi.fn();
  const session = new MidiProgramSession(project, 'song', { prepare, send, close, now: () => now, sent: reported,
    missed: message => missed.push(message), late: message => late.push(message), failed: error => errors.push(error) }, mode);
  const clock = async (position: number) => { now = 1000 + position; session.clock(position, now); await session.settled(); };
  return { session, send, sent, errors, missed, late, prepare, close, reported, clock, time: (value: number) => { now = value; } };
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

it('过期时钟错过的动作记录且不补发，通道继续发送之后的动作；倒退时钟关闭通道', async () => {
  const f = fixture([{ frame: 0, actions: [note('a')] }, { frame: 9, actions: [note('b')] }]); await f.session.prepare(0);
  f.time(1101); f.session.clock(0, 1000); await f.session.settled();
  expect(f.send).not.toHaveBeenCalled(); expect(f.missed).toEqual(['播放位置更新中断，错过了 1 个 MIDI 动作，没有补发']);
  await f.clock(300); expect(f.sent).toEqual([[0x90, 60, 100]]); expect(f.errors).toEqual([]); await f.session.close();
  const backwards = fixture([{ frame: 0, actions: [note('a')] }]); await backwards.session.prepare(100);
  await backwards.clock(99); expect(backwards.errors[0]?.message).toContain('倒退'); await backwards.session.close();
});

it('设备时钟虽新但跨过动作截止边界，也不能补发历史 Cue；已发音符的释放迟到仍发送', async () => {
  const f = fixture([{ frame: 0, actions: [note('a', 50)] }, { frame: 3, actions: [note('b')] }]); await f.session.prepare(0);
  await f.clock(0); expect(f.sent).toEqual([[0x90, 60, 100]]);
  await f.clock(400);
  expect(f.sent).toEqual([[0x90, 60, 100], [0x80, 60, 0]]); expect(f.send.mock.calls[1]?.[2]).toBe(1500);
  expect(f.missed).toEqual(['播放位置更新中断，错过了 1 个 MIDI 动作，没有补发']); expect(f.errors).toEqual([]); await f.session.close();
});

// 2026-11-10 第 6 题改了这条：以前排队晚了的 CC 也不发；现在 Program Change、Control Change 晚了照发并标红，只有 Note On 一类晚 100 ms 以上才跳过。
it('排队等待超过执行边界：Note On 不发送并记录，CC 晚了照发并标红，之后的动作照常', async () => {
  const f = fixture([{ frame: 0, actions: [note('a', 500), note('b', 500), { id: 'cc', label: 'CC 7', kind: 'midi.controlChange', portProfileId: 'out', channel: 2, controller: 7, value: 64 }] },
    { frame: 9, actions: [{ id: 'pc', label: 'PC', kind: 'midi.programChange', portProfileId: 'out', channel: 1, program: 3 }] }]);
  f.send.mockImplementationOnce((_port, bytes) => { f.sent.push([...bytes]); f.time(1200); return Promise.resolve(); });
  await f.session.prepare(0); await f.clock(0);
  expect(f.sent).toEqual([[0x90, 60, 100], [0xb1, 7, 64]]); expect(f.send.mock.calls[1]?.[2]).toBe(2200);
  expect(f.missed).toEqual(['MIDI 动作晚了超过 100 ms，没有补发：b']);
  expect(f.late).toHaveLength(1); expect(f.late[0]).toContain('MIDI 动作晚了 200 ms 才发出：CC 7');
  await f.clock(300); expect(f.sent.at(-1)).toEqual([0xc0, 3]); expect(f.errors).toEqual([]); await f.session.close();
});

it('输出失败清除本轮队列，不将后续动作报告成功、不自动重试', async () => {
  const f = fixture([{ frame: 0, actions: [note('a'), note('b')] }]);
  f.send.mockRejectedValueOnce(new Error('驱动断开')); await f.session.prepare(0); await f.clock(0); await f.session.close();
  expect(f.send).toHaveBeenCalledOnce(); expect(f.reported).not.toHaveBeenCalled(); expect(f.errors[0]?.message).toBe('驱动断开');
  expect(f.prepare).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce();
});

it('接口恢复后从当前位置开始：准备期间经过的动作属于中断，既不发送也不记为错过', async () => {
  const pc = (id: string, program: number): LinkAction => ({ id, label: id, kind: 'midi.programChange', portProfileId: 'out', channel: 1, program });
  const f = fixture([{ frame: 45, actions: [pc('during', 1)] }, { frame: 90, actions: [pc('after', 2)] }]);
  await f.session.prepare(1000);
  expect(f.session.resumeFrom(2500, 1200)).toBe(1);
  await f.clock(2510); expect(f.sent).toEqual([]); expect(f.missed).toEqual([]);
  await f.clock(3000); expect(f.sent).toEqual([[0xc0, 2]]);
  expect(() => f.session.resumeFrom(4000, 0)).toThrow('恢复位置无效'); expect(f.errors).toEqual([]);
  await f.session.close();
});

it('发送失败的会话记下中断起点：第一条没发出的动作，其后排队的动作不算起点', async () => {
  const pc = (id: string, program: number): LinkAction => ({ id, label: id, kind: 'midi.programChange', portProfileId: 'out', channel: 1, program });
  const f = fixture([{ frame: 30, actions: [pc('lost', 1)] }, { frame: 31, actions: [pc('queued', 2)] }]);
  await f.session.prepare(0); await f.clock(500); expect(f.session.outageStartMs).toBe(500);
  f.send.mockRejectedValueOnce(new Error('MIDI 输出失败：接口已断开（错误码 6）'));
  f.time(1050); f.session.clock(1050, 1050); await f.session.settled(); await f.session.close();
  expect(f.session.error?.message).toContain('错误码 6'); expect(f.session.outageStartMs).toBe(1000); expect(f.sent).toEqual([]);
});

const pc = (id: string, program: number): LinkAction => ({ id, label: id, kind: 'midi.programChange', portProfileId: 'out', channel: 1, program });

it('PC、CC 晚 2 秒照发并标红写明晚了多少，交给接口的截止时间从发送时起 1 秒', async () => {
  const f = fixture([{ frame: 0, actions: [pc('pc', 4), { id: 'cc', label: 'CC 7', kind: 'midi.controlChange', portProfileId: 'out', channel: 1, controller: 7, value: 1 }] }]);
  await f.session.prepare(0); f.time(3000); f.session.clock(0, 1000); await f.session.settled();
  expect(f.sent).toEqual([[0xc0, 4], [0xb0, 7, 1]]); expect(f.send.mock.calls.map(call => call[2])).toEqual([4000, 4000]);
  expect(f.late).toEqual(['MIDI 动作晚了 2000 ms 才发出：pc、CC 7。请看一下接收的设备有没有切过去；经常这样时，检查电脑是否太忙']);
  expect(f.missed).toEqual([]); expect(f.errors).toEqual([]); expect(f.reported).toHaveBeenCalledTimes(2); await f.session.close();
});

it('Note On 晚 150 ms 只跳过这一条记为错过，下一条照发；Note Off 晚多少都发', async () => {
  const off: LinkAction = { id: 'off', label: 'off', kind: 'midi.noteOff', portProfileId: 'out', channel: 1, note: 61, velocity: 0 };
  const f = fixture([{ frame: 0, actions: [{ id: 'on', label: 'on', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 90 }, off] },
    { frame: 30, actions: [note('next')] }]);
  await f.session.prepare(0); f.time(1150); f.session.clock(0, 1000); await f.session.settled();
  expect(f.sent).toEqual([[0x80, 61, 0]]); expect(f.missed).toEqual(['播放位置更新中断，错过了 1 个 MIDI 动作，没有补发']);
  await f.clock(1000); expect(f.sent.at(-1)).toEqual([0x90, 60, 100]); expect(f.errors).toEqual([]); await f.session.close();
});

it('接口只拒绝这一条（过期、SysEx 没发完）：记为没发出，后面的动作照发，通道不停', async () => {
  const f = fixture([{ frame: 0, actions: [pc('a', 1), pc('b', 2)] }, { frame: 3, actions: [pc('c', 3)] }]);
  f.send.mockRejectedValueOnce(new MidiMessageSkipped('上一条 SysEx 没有及时发完（错误码 -6）', -6));
  await f.session.prepare(0); await f.clock(0);
  expect(f.sent).toEqual([[0xc0, 2]]);
  expect(f.missed).toEqual(['MIDI 动作没有发出：a，后面的动作照常发送。原因：上一条 SysEx 没有及时发完（错误码 -6）']);
  await f.clock(100); expect(f.sent.at(-1)).toEqual([0xc0, 3]); expect(f.errors).toEqual([]); expect(f.session.error).toBeNull();
  await f.session.close(); expect(f.close).toHaveBeenCalledOnce();
});

it('驱动确认晚了的 Note On 可能已经发出：到时长照样发 Note Off', async () => {
  const f = fixture([{ frame: 0, actions: [note('a', 200)] }]);
  f.send.mockImplementationOnce((_port, bytes) => { f.sent.push([...bytes]); return Promise.reject(new MidiMessageSkipped('驱动确认晚了，这一条可能已经发出', null, true)); });
  await f.session.prepare(0); await f.clock(0); await f.clock(200);
  expect(f.sent).toEqual([[0x90, 60, 100], [0x80, 60, 0]]); expect(f.reported).toHaveBeenCalledOnce(); expect(f.errors).toEqual([]);
  await f.session.close();
});

it('排练时第一条没发出的动作挡住后面的动作（AGENTS §4.8），已发音符的 Note Off 照发', async () => {
  const f = fixture([{ frame: 0, actions: [note('held', 300), pc('refused', 1)] }, { frame: 3, actions: [pc('later', 2)] }], 'rehearsal');
  f.send.mockImplementation((_port, bytes) => {
    if (bytes[0] === 0xc0 && bytes[1] === 1) return Promise.reject(new MidiMessageSkipped('动作已过期，没有发送（错误码 -7）', -7));
    f.sent.push([...bytes]); return Promise.resolve();
  });
  await f.session.prepare(0); await f.clock(0); await f.clock(100); await f.clock(300);
  expect(f.sent).toEqual([[0x90, 60, 100], [0x80, 60, 0]]);
  expect(f.missed).toContain('排练时前面的 MIDI 动作没有发出，后面的 1 个动作不再发送。检查后重新播放这首歌');
  expect(f.errors).toEqual([]); await f.session.close();
  const live = fixture([{ frame: 0, actions: [pc('refused', 1)] }, { frame: 3, actions: [pc('later', 2)] }]);
  live.send.mockRejectedValueOnce(new MidiMessageSkipped('动作已过期，没有发送（错误码 -7）', -7));
  await live.session.prepare(0); await live.clock(0); await live.clock(100);
  expect(live.sent).toEqual([[0xc0, 2]]); await live.session.close();
});
