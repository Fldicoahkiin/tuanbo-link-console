import { describe, expect, it } from 'vitest';
import { deriveShowState, isShowWait, showGate, showOperationRules, SHOW_WAIT_CLOCK_MOVING, type ShowInputs, type ShowState } from './show-state';

const none: ShowInputs = { internal: null, p1: null, preview: false, program: null };
const internal = (status: NonNullable<ShowInputs['internal']>['status'], extra: Partial<NonNullable<ShowInputs['internal']>> = {}): ShowInputs =>
  ({ ...none, internal: { status, itemId: 'a', positionMs: 1_000, durationMs: 60_000, lightingOffOwed: false, ...extra } });

describe('deriveShowState', () => {
  it('没有任何来源时是空闲', () => {
    expect(deriveShowState(none)).toEqual({ phase: 'idle', program: null });
    expect(deriveShowState(internal('stopped'))).toEqual({ phase: 'idle', program: null });
    expect(deriveShowState({ ...none, p1: { state: 'idle', itemId: null } })).toEqual({ phase: 'idle', program: null });
  });

  it('联动台播放：各状态按设计对应', () => {
    expect(deriveShowState(internal('playing'))).toMatchObject({ phase: 'running', source: 'internal', itemId: 'a' });
    expect(deriveShowState(internal('preparing'))).toMatchObject({ phase: 'preparing', source: 'internal' });
    expect(deriveShowState(internal('paused'))).toMatchObject({ phase: 'held', reason: 'paused' });
    expect(deriveShowState(internal('paused', { positionMs: 60_000 }))).toMatchObject({ phase: 'held', reason: 'ended' });
    expect(deriveShowState(internal('paused', { positionMs: 0, durationMs: 0 }))).toMatchObject({ phase: 'held', reason: 'paused' });
    expect(deriveShowState(internal('error'))).toMatchObject({ phase: 'held', reason: 'error', itemId: 'a' });
    expect(deriveShowState(internal('error', { itemId: null }))).toEqual({ phase: 'idle', program: null });
  });

  it('停止欠着的关灯还在发时算停止中', () => {
    expect(deriveShowState(internal('stopped', { lightingOffOwed: true }))).toMatchObject({ phase: 'stopping', source: 'internal' });
    expect(deriveShowState(internal('error', { itemId: null, lightingOffOwed: true }))).toMatchObject({ phase: 'stopping' });
  });

  it('P1 跟随：各状态按设计对应', () => {
    const p1 = (state: NonNullable<ShowInputs['p1']>['state']) => deriveShowState({ ...none, p1: { state, itemId: 'b' } });
    expect(p1('preflight')).toMatchObject({ phase: 'preparing', source: 'p1', itemId: 'b' });
    expect(p1('running')).toMatchObject({ phase: 'running', source: 'p1' });
    expect(p1('stopping')).toMatchObject({ phase: 'stopping', source: 'p1' });
    expect(p1('armed')).toMatchObject({ phase: 'held', reason: 'p1-waiting' });
    expect(p1('paused')).toMatchObject({ phase: 'held', reason: 'p1-waiting' });
    expect(p1('timecodeLost')).toMatchObject({ phase: 'held', reason: 'timecode-lost' });
    expect(p1('error')).toMatchObject({ phase: 'held', reason: 'error' });
  });

  it('本地预览在放算在走', () => {
    expect(deriveShowState({ ...none, preview: true })).toMatchObject({ phase: 'running', source: 'preview', itemId: null });
  });

  it('几个来源同时在时取最忙的，一样忙取前面的', () => {
    expect(deriveShowState({ ...internal('paused'), preview: true })).toMatchObject({ phase: 'running', source: 'preview' });
    expect(deriveShowState({ ...internal('paused'), p1: { state: 'preflight', itemId: 'b' } })).toMatchObject({ phase: 'preparing', source: 'p1' });
    expect(deriveShowState({ ...internal('playing'), p1: { state: 'running', itemId: 'b' }, preview: true })).toMatchObject({ phase: 'running', source: 'internal' });
  });

  it('后台节目的信息原样带上', () => {
    const program = { projectPath: 'C:/show.tblink', projectId: 'p', watched: false };
    expect(deriveShowState({ ...none, program })).toEqual({ phase: 'idle', program });
    expect(deriveShowState({ ...internal('playing'), program })).toMatchObject({ phase: 'running', program });
  });
});

describe('showGate', () => {
  const running: ShowState = { phase: 'running', source: 'internal', itemId: 'a', program: null };
  const held: ShowState = { phase: 'held', source: 'internal', itemId: 'a', reason: 'paused', program: null };
  const idle: ShowState = { phase: 'idle', program: null };

  it('只在停止时能做的操作，暂停时也等', () => {
    expect(showGate('document.replace', idle)).toEqual({ kind: 'allow' });
    expect(showGate('document.replace', held)).toMatchObject({ kind: 'wait', until: 'idle' });
    expect(showGate('rundown.reorder', held)).toMatchObject({ kind: 'wait', until: 'idle' });
    expect(showGate('rundown.reorder', idle)).toEqual({ kind: 'allow' });
  });

  it('退出在演出中先确认', () => {
    expect(showGate('app.quit', idle)).toEqual({ kind: 'allow' });
    expect(showGate('app.quit', held)).toMatchObject({ kind: 'confirm' });
  });

  it('改歌的音频只挡在台上的那首；不知道是哪首时都挡', () => {
    expect(showGate('song.audio.edit', running, 'b')).toEqual({ kind: 'allow' });
    expect(showGate('song.audio.edit', running, 'a')).toMatchObject({ kind: 'wait', until: 'idle' });
    expect(showGate('song.audio.edit', running)).toMatchObject({ kind: 'wait' });
    expect(showGate('song.audio.edit', { ...running, itemId: null }, 'b')).toMatchObject({ kind: 'wait' });
    expect(showGate('song.remove', held, 'a')).toMatchObject({ kind: 'wait' });
    expect(showGate('song.audio.edit', idle, 'a')).toEqual({ kind: 'allow' });
  });

  it('等待文案说明要做的事', () => {
    expect(showGate('ma2.sync.write', running)).toEqual({ kind: 'wait', until: 'clock-stopped', message: `${SHOW_WAIT_CLOCK_MOVING}暂停或停止后再同步控台。` });
  });

  it('每个操作都在表里，查询不会抛错', () => {
    const shows: ShowState[] = [idle, running, held, { phase: 'preparing', source: 'p1', itemId: null, program: null }, { phase: 'stopping', source: 'internal', itemId: 'a', program: null }];
    for (const op of Object.keys(showOperationRules) as Array<keyof typeof showOperationRules>) for (const show of shows) expect(showGate(op, show, 'a').kind).toMatch(/^(allow|wait|confirm)$/);
  });
});

describe('isShowWait', () => {
  it('认出等待，包括经 Electron 包装的', () => {
    const wait = showGate('ma2.check', { phase: 'running', source: 'p1', itemId: null, program: null });
    if (wait.kind !== 'wait') throw new Error('应当等待');
    expect(isShowWait(new Error(wait.message))).toBe(true);
    expect(isShowWait({ message: `Error invoking remote method 'link:ma2-check': Error: ${wait.message}` })).toBe(true);
    expect(isShowWait(new Error('控台远程登录未开启'))).toBe(false);
  });
});
