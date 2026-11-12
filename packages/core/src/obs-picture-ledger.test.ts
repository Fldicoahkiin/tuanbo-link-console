import { describe, expect, it } from 'vitest';
import { ObsPictureLedger, pictureElementKey, showKey, type LedgerWrite } from './obs-picture-ledger';

const program = (scene: string): LedgerWrite => ({ element: 'program', value: { sceneName: scene, cueId: null }, target: scene });
const scene = (sceneName: string) => ({ sceneName, cueId: null });
const decoder = (clipId: string, mode: 'playing' | 'paused' | 'stopped' = 'playing'): LedgerWrite =>
  ({ element: 'decoder', key: 'M1', value: { clipId, mode, offsetMs: 0 }, target: `${clipId}:${mode}` });

describe('OBS 已确认的账：只记 OBS 回应或报告过的', () => {
  it('发出去是“等回应”，回应了才算确认；过时的回应不改账', () => {
    const ledger = new ObsPictureLedger();
    ledger.sent(program('机位甲'), 1);
    expect(ledger.state().program).toEqual({ state: 'pending', value: scene('机位甲'), target: '机位甲', since: 1 });
    ledger.sent(program('机位乙'), 2);
    ledger.ack(program('机位甲'), 3);
    expect(ledger.state().program.state).toBe('pending');
    ledger.ack(program('机位乙'), 4);
    expect(ledger.state().program).toEqual({ state: 'confirmed', value: scene('机位乙'), at: 4 });
  });

  it('同一个应有状态连续失败会累计次数，换了应有状态重新算', () => {
    const ledger = new ObsPictureLedger();
    ledger.sent(decoder('c1'), 1); ledger.fail(decoder('c1'), '被拒绝');
    ledger.sent(decoder('c1'), 2); ledger.fail(decoder('c1'), '又被拒绝');
    expect(ledger.state().decoders.get('M1')).toMatchObject({ state: 'failed', attempts: 2, target: 'c1:playing', reason: '又被拒绝' });
    ledger.sent(decoder('c2'), 3); ledger.fail(decoder('c2'), '被拒绝');
    expect(ledger.state().decoders.get('M1')).toMatchObject({ state: 'failed', attempts: 1, target: 'c2:playing' });
  });

  it('没回应记成“不确定”，保留最后的值和当时要的状态（0.5.9 R5：同一个应有状态下按失败补一次）', () => {
    const ledger = new ObsPictureLedger();
    ledger.sent(decoder('c1'), 1); ledger.unanswered(decoder('c1'), '2 秒没回应');
    expect(ledger.state().decoders.get('M1')).toEqual({ state: 'unknown', reason: '2 秒没回应', last: { clipId: 'c1', mode: 'playing', offsetMs: 0 }, target: 'c1:playing' });
    // A reconnect forgets what it was sent for: what follows is a restore, not a repair.
    ledger.invalidate('OBS 重新连接');
    expect(ledger.state().decoders.get('M1')).toEqual({ state: 'unknown', reason: 'OBS 重新连接', last: { clipId: 'c1', mode: 'playing', offsetMs: 0 } });
  });

  it('重连后全部不确定，手动接管也作废', () => {
    const ledger = new ObsPictureLedger();
    const show: LedgerWrite = { element: 'show', key: showKey({ sceneName: '机位甲', sourceName: '字幕', actionId: 'a' }), value: { enabled: true, sceneName: '机位甲', sourceName: '字幕', span: 'a' }, target: 'on:a' };
    for (const write of [program('机位甲'), decoder('c1'), show]) { ledger.sent(write, 1); ledger.ack(write, 2); }
    ledger.takeOver('手动场景', '机位甲', 3);
    ledger.invalidate('OBS 重新连接');
    const state = ledger.state();
    expect(state.takenOver).toBeNull();
    expect(state.program).toEqual({ state: 'unknown', reason: 'OBS 重新连接', last: scene('手动场景') });
    expect(state.decoders.get('M1')).toMatchObject({ state: 'unknown', last: { clipId: 'c1' } });
    expect(state.shows.get(show.key)).toMatchObject({ state: 'unknown', last: { enabled: true, sourceName: '字幕' } });
  });

  it('重连后确认停了的解码器还是停的；停止被拒绝或没回应的仍可能在播（R7）', () => {
    const ledger = new ObsPictureLedger();
    const other: LedgerWrite = { element: 'decoder', key: 'M2', value: { clipId: 'c2', mode: 'stopped', offsetMs: 0 }, target: 'c2:stopped' };
    ledger.sent(decoder('c1', 'stopped'), 1); ledger.ack(decoder('c1', 'stopped'), 2);
    ledger.sent(other, 1); ledger.fail(other, '被拒绝');
    ledger.invalidate('OBS 重新连接');
    expect(ledger.state().decoders.get('M1')).toMatchObject({ state: 'confirmed', value: { clipId: 'c1', mode: 'stopped' } });
    expect(ledger.state().decoders.get('M2')).toMatchObject({ state: 'unknown', last: { clipId: 'c2', mode: 'stopped' } });
  });

  it('解码器按最后一次换上的片段排先后：换了片段的排到最后，同一个片段的暂停、停止不挪位置（R7）', () => {
    const ledger = new ObsPictureLedger();
    const on = (key: string, clipId: string, mode: 'playing' | 'paused' | 'stopped' = 'playing'): LedgerWrite => ({ element: 'decoder', key, value: { clipId, mode, offsetMs: 0 }, target: `${clipId}:${mode}` });
    for (const write of [on('M1', 'a'), on('M2', 'b'), on('M1', 'a', 'paused'), on('M1', 'c'), on('M2', 'b', 'stopped')]) { ledger.sent(write, 1); ledger.ack(write, 2); }
    expect([...ledger.state().decoders.keys()]).toEqual(['M2', 'M1']);
  });

  it('手动接管记下当时的应有画面；联动台切过去被确认后接管结束', () => {
    const ledger = new ObsPictureLedger();
    ledger.takeOver('手动场景', '机位甲', 5);
    expect(ledger.state().takenOver).toEqual({ sceneName: '手动场景', since: 5, target: '机位甲' });
    ledger.sent(program('机位乙'), 6); ledger.ack(program('机位乙'), 7);
    expect(ledger.state().takenOver).toBeNull();
  });

  it('没发出去的撤回：回到发之前的样子；素材重新准备好以后忘掉失败，下一遍照应有的发', () => {
    const ledger = new ObsPictureLedger();
    ledger.sent(program('A'), 0); ledger.ack(program('A'), 1);
    ledger.sent(program('B'), 2); ledger.withdraw(program('B'));
    expect(ledger.state().program).toMatchObject({ state: 'confirmed', value: scene('A') });
    ledger.sent(decoder('c1'), 3); ledger.withdraw(decoder('c1'));
    expect(ledger.state().decoders.has('M1')).toBe(false);
    ledger.sent(decoder('c1'), 4); ledger.fail(decoder('c1'), 'OBS 拒绝了');
    ledger.forget(decoder('c1'), '素材准备好了');
    expect(ledger.state().decoders.get('M1')).toMatchObject({ state: 'unknown', last: { clipId: 'c1' } });
  });

  it('元素名在账、规划和次数里是同一个', () => {
    expect(pictureElementKey(program('x'))).toBe('program');
    expect(pictureElementKey(decoder('c1'))).toBe('decoder:M1');
  });
});
