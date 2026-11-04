import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type LinkProject, type Ma2Catalog } from '@tb/schema';
import { reconcileMa2ReadState } from './ma2-pairing-state';
import { consoleFollowTarget, consoleFollowVerdict, consoleTriggers, nextConsoleFollow, type ConsoleFollow, type ConsoleTrigger } from './console-follow';

const START_MS = 480_000;
const TICKS = START_MS * 30 / 1000;

function catalog(shows: Array<{ target: number; ticks: number }>): Ma2Catalog {
  return { directory: { show: 'Show', generation: 'session', version: '3.3.4.3', entries: shows.map(entry => ({ target: entry.target, name: `灯光 ${entry.target}` })) }, readAt: '2026-10-30T00:00:00.000Z',
    entries: shows.map(entry => ({ target: entry.target, name: `灯光 ${entry.target}`, eventCount: 3, frameFormat: '30 FPS', offset: String(entry.ticks), slot: 'TC Slot 1',
      events: [{ path: '1', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: '开场' }, { path: '2', time: '150', action: 'Flash', executor: '1.102', cue: null, name: null },
        { path: '3', time: '300', action: 'Off', executor: '1.101', cue: null, name: '收' }], error: null, warnings: [] })) };
}
function project(shows = [{ target: 7, ticks: TICKS }]): LinkProject {
  const value = createEmptyLinkProject('控台在跟'); value.schemaVersion = 2;
  value.rundown = [{ id: '甲', title: '歌曲甲', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [],
    referenceAudio: { assetId: 'a', relativePath: 'a.wav', sha256: 'a'.repeat(64), durationMs: 40_000 },
    playback: { volume: 100, endAction: 'stop', startMs: 0, endMs: 0, mtcOffsetMs: START_MS, shortcut: '' } }];
  value.ma2ReadState = reconcileMa2ReadState(value, '192.0.2.10:30000', catalog(shows));
  return value;
}
const track = (at: number, cue: string): LightingTrack => ({ id: 'track', name: '灯光', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {},
  clips: [{ id: 'clip', name: '原编排', start: 2000, duration: 30_000, timeLock: 'time', muted: false, events: [{ id: 'cue', kind: 'ma2', at, sequence: 1, executor: '1.101', cue, action: 'goto', label: '主歌' }] }] });

describe('控台上这首歌的触发点：只看控台上已有的版本', () => {
  it('没拿过 Cue 的歌用最近读到的控台时间码节目，只认 Go、Goto、Off', () => {
    expect(consoleTriggers(project(), '甲')).toEqual({ triggers: [
      { atMs: 1000, executor: '1.101', action: 'goto', cue: '1', label: '开场' },
      { atMs: 10_000, executor: '1.101', action: 'off', cue: null, label: '收' }] });
  });

  it('拿了 Cue 的歌用控台确认过的基线，不用还没同步的本地修改', () => {
    const value = project();
    const lighting = createLightingDocument(); lighting.tracks = [track(500, '9')];
    lighting.ma2Bindings = [{ id: 'binding', timecode: 7, name: '灯光 7', readAt: '2026-10-30T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [track(1000, '2')], mappings: [], playback: 'editable', timeOriginMs: START_MS }];
    value.rundown[0]!.lighting = lighting;
    expect(consoleTriggers(value, '甲')).toEqual({ triggers: [{ atMs: 3000, executor: '1.101', action: 'goto', cue: '2', label: '主歌' }] });
    lighting.ma2Bindings[0]!.timeOriginMs = START_MS + 1000;
    const held = consoleTriggers(value, '甲');
    expect('reason' in held && held.reason).toContain('起点');
  });

  it('联动台建的歌用上次写到控台的点和它的执行器', () => {
    const value = project([]);
    const lighting = createLightingDocument();
    lighting.consoleSong = { endpoint: '192.0.2.10:30000', show: 'Show', layout: null, executor: '1000.101', sequence: 501, name: 'GeQu', baselineXml: '<MA/>',
      points: [{ id: 'a', cue: '1', atMs: 2000 }, { id: 'b', cue: '2' }],
      timecode: { number: 501, offset: TICKS, slot: 'TC Slot 1', revision: 'b'.repeat(64) } };
    value.rundown[0]!.lighting = lighting;
    expect(consoleTriggers(value, '甲')).toEqual({ triggers: [{ atMs: 2000, executor: '1000.101', action: 'goto', cue: '1', label: 'Cue 1' }] });
    delete lighting.consoleSong.timecode;
    expect(consoleTriggers(value, '甲')).toEqual({ reason: '控台上还没有这首歌的时间码节目' });
  });

  it('控台上没有同起点的节目、或两个节目同起点：说明原因，不猜', () => {
    expect('reason' in consoleTriggers(project([]), '甲')).toBe(true);
    const duplicate = consoleTriggers(project([{ target: 7, ticks: TICKS }, { target: 8, ticks: TICKS }]), '甲');
    expect('reason' in duplicate && duplicate.reason).toContain('Timecode 7、8');
  });
});

describe('什么时候核对哪个执行器', () => {
  const triggers: ConsoleTrigger[] = [
    { atMs: 1000, executor: '1.101', action: 'goto', cue: '1', label: '开场' },
    { atMs: 5000, executor: '1000.101', action: 'goto', cue: '3', label: '副歌' },
    { atMs: 5500, executor: '1000.101', action: 'goto', cue: '4', label: '尾声' }];

  it('第一个点之前、刚触发不到一秒：先等', () => {
    expect(consoleFollowTarget(triggers, 500, 0)).toMatchObject({ kind: 'wait' });
    expect(consoleFollowTarget(triggers, 1500, 0)).toMatchObject({ kind: 'wait' });
  });
  it('触发一秒后核对它的执行器；同一执行器后面又触发、还在一秒内时先等', () => {
    expect(consoleFollowTarget(triggers, 2100, 0)).toMatchObject({ kind: 'executor', page: 1, slot: 101, trigger: { cue: '1' } });
    expect(consoleFollowTarget(triggers, 6100, 0)).toMatchObject({ kind: 'wait' });
    expect(consoleFollowTarget(triggers, 6600, 0)).toMatchObject({ kind: 'executor', page: 1000, slot: 101, trigger: { cue: '4' } });
  });
  it('从中间开始播放时只核对这次播放经过的点', () => {
    expect(consoleFollowTarget(triggers, 3000, 2500)).toMatchObject({ kind: 'wait', reason: '还没到这次播放的第一个灯光点' });
  });
  it('没有触发执行器的点：无法确认', () => {
    expect(consoleFollowTarget([], 3000, 0)).toMatchObject({ kind: 'unknown' });
  });
});

describe('控台在不在跟', () => {
  const goto: ConsoleTrigger = { atMs: 1000, executor: '1000.101', action: 'goto', cue: '5', label: '副歌' };
  it('执行器在跑、Cue 编号一致才算在跟', () => {
    expect(consoleFollowVerdict(goto, { running: true, cue: '    5 FuGe', name: 'Song' })).toMatchObject({ following: true });
    expect(consoleFollowVerdict(goto, { running: true, cue: '  5.0 FuGe', name: 'Song' })).toMatchObject({ following: true });
    expect(consoleFollowVerdict(goto, { running: true, cue: '    3 ZhuGe', name: 'Song' })).toEqual({ following: false, detail: '执行器 1000.101 现在在 Cue 3，按时间线应该在 Cue 5（副歌）' });
    expect(consoleFollowVerdict(goto, { running: false, cue: '', name: 'Song' })).toEqual({ following: false, detail: '执行器 1000.101 没在跑，按时间线这时应该在跑“副歌”' });
    expect(consoleFollowVerdict(goto, null).following).toBe(false);
    // Running without a readable Cue number is not called a miss.
    expect(consoleFollowVerdict(goto, { running: true, cue: '', name: 'Song' })).toEqual({ following: true, detail: '执行器 1000.101 在跑（读不出当前 Cue 编号）' });
  });
  it('关闭点：执行器应该已经停了', () => {
    const off: ConsoleTrigger = { ...goto, action: 'off', cue: null, label: '收' };
    expect(consoleFollowVerdict(off, { running: false, cue: '', name: 'Song' }).following).toBe(true);
    expect(consoleFollowVerdict(off, { running: true, cue: '    5 FuGe', name: 'Song' }).following).toBe(false);
  });
  it('连续两次对不上才显示没在跟；对上一次就恢复', () => {
    const start: ConsoleFollow = { state: 'checking', detail: '等第一个灯光点', misses: 0 };
    const miss = { following: false, detail: '没在跑' };
    const once = nextConsoleFollow(start, miss);
    expect(once).toMatchObject({ state: 'checking', misses: 1 });
    expect(nextConsoleFollow(once, miss)).toEqual({ state: 'not-following', detail: '没在跑', misses: 2 });
    expect(nextConsoleFollow(nextConsoleFollow(once, miss), { following: true, detail: '在跑' })).toEqual({ state: 'following', detail: '在跑', misses: 0 });
  });
});
