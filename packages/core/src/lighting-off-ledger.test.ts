import { describe, expect, it } from 'vitest';
import { createLightingDocument, lightingMa2BindingSchema, lightingTrackSchema, type LightingDocument } from '@tb/schema';
import { LightingOffLedger, lightingExecutors, lightingReleaseActions, lightsLeftOnAfterResendText, lightsLeftOnText, owedOffTexts, songChangeOffs } from './lighting-off-ledger';

const off = (executor: string) => ({ target: 'executor', executor, action: 'off' }) as const;
const opening = { itemId: 'opening', title: '开场' }, encore = { itemId: 'encore', title: '返场' };

/** A song whose console timeline runs `executors` (track mappings) and whose own sequence sits on `own`. */
function song(executors: string[], own?: string): LightingDocument {
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return { ...createLightingDocument(), ma2Bindings: [binding],
    ...own ? { consoleSong: { endpoint: 'console', show: '现场', layout: null, executor: own, sequence: 36, name: '歌曲', baselineXml: '<MA/>', points: [] } } : {} };
}

describe('停止关哪些执行器（搬自 lighting-output-release.ts）', () => {
  it('播放只发时间码：停止只关时间码绑定的执行器和本曲控台序列的执行器，本地时间线上的 Cue 不发 Off；去重', () => {
    const document = { ...song([], '51.101') };
    document.tracks = [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {},
      clips: [{ id: 'clip', name: '歌曲', start: 0, duration: 180000, timeLock: 'time', muted: false, events: [100, 70000].map((at, index) => ({ id: `cue-${index}`, at, kind: 'ma2', action: 'goto', sequence: 36, cue: `${index + 1}`, executor: '1.105', label: '原灯光' })) }] })];
    expect(lightingReleaseActions(document)).toEqual([off('51.101')]);
    expect(lightingReleaseActions({ ...document, consoleSong: undefined })).toEqual([]);
    expect(lightingReleaseActions(song(['1.101', '1.102', '1.101'], '1.102'))).toEqual([off('1.101'), off('1.102')]);
    expect(lightingExecutors(null)).toEqual([]);
  });
});

describe('第 4 题：换歌只关上一首独有的执行器', () => {
  it('Off 等于上一首用到的减去下一首也用的；下一首不带灯光时上一首的全关', () => {
    expect(songChangeOffs(song(['1.101', '1.102'], '1.110'), song(['1.102', '1.103']))).toEqual([off('1.101'), off('1.110')]);
    expect(songChangeOffs(song(['1.101']), null)).toEqual([off('1.101')]);
    expect(songChangeOffs(song(['1.101']), song(['1.101']))).toEqual([]);
  });
});

describe('欠着的关灯清单', () => {
  it('正在用的执行器绝不关：开始的歌划掉欠它的 Off，用着的时候也不再欠', () => {
    const ledger = new LightingOffLedger();
    const sent = ledger.owe([off('1.101'), off('1.102')], opening, 'stop', null);
    expect(sent.map(entry => entry.executor)).toEqual(['1.101', '1.102']);
    ledger.fail('1.101', sent[0]!.attempt, '没有连接控台', null, null);
    ledger.use('program', ['1.101']);
    expect(ledger.owed().map(entry => entry.executor)).toEqual(['1.102']);
    expect(ledger.owe([off('1.101')], opening, 'song-change', null)).toEqual([]);
    // The preview's executors count as in use too, apart from the program's.
    ledger.use('window', ['1.103']);
    ledger.use('program', []);
    expect(ledger.owe([off('1.101'), off('1.103')], opening, 'stop', null).map(entry => entry.executor)).toEqual(['1.101']);
  });

  it('控台回应了就划掉；早先那次发送的回应不能划掉新欠的', () => {
    const ledger = new LightingOffLedger();
    const [first] = ledger.owe([off('1.101')], opening, 'stop', null);
    const [second] = ledger.owe([off('1.101')], encore, 'stop', null);
    expect(ledger.ack('1.101', first!.attempt)).toBe(false);
    expect(ledger.fail('1.101', first!.attempt, '迟到', null, null)).toBeNull();
    expect(ledger.owed()).toMatchObject([{ executor: '1.101', song: encore, state: 'sending' }]);
    expect(ledger.sending()).toBe(true);
    expect(ledger.ack('1.101', second!.attempt)).toBe(true);
    expect(ledger.owed()).toEqual([]);
  });

  it('没连上时留着，连上以后补发 1 次；同一次连接不补，补过一次还失败就留着等操作员', () => {
    const ledger = new LightingOffLedger();
    const [sent] = ledger.owe([off('1.101')], opening, 'stop', null);
    ledger.fail('1.101', sent!.attempt, '没有连接控台', null, null);
    expect(ledger.waiting()).toBe(true);
    const [resent] = ledger.onConnected(7, 0);
    expect(resent).toMatchObject({ executor: '1.101', resent: true });
    ledger.fail('1.101', resent!.attempt, 'MA2 没有回应', 7, null);
    expect(ledger.onConnected(7, 1)).toEqual([]);
    expect(ledger.onConnected(8, 2)).toEqual([]);
    expect(ledger.owed()).toMatchObject([{ executor: '1.101', state: 'failed', reason: 'MA2 没有回应', resent: true }]);
  });

  it('再按一次停止把没确认的全部重发，不占补发次数；正在发的不重复发', () => {
    const ledger = new LightingOffLedger();
    const sent = ledger.owe([off('1.101'), off('1.102')], opening, 'stop', null);
    ledger.fail('1.101', sent[0]!.attempt, '没有连接控台', null, null);
    expect(ledger.resendOnStop().map(entry => entry.executor)).toEqual(['1.101']);
    const [again] = ledger.owed().filter(entry => entry.executor === '1.101');
    ledger.fail('1.101', again!.attempt, '没有连接控台', null, null);
    expect(ledger.onConnected(3, 0).map(entry => entry.executor)).toEqual(['1.101']);
  });

  it('新欠的同一个执行器重新算补发次数', () => {
    const ledger = new LightingOffLedger();
    const [sent] = ledger.owe([off('1.101')], opening, 'stop', null);
    ledger.fail('1.101', sent!.attempt, 'x', null, null);
    const [resent] = ledger.onConnected(1, 0);
    ledger.fail('1.101', resent!.attempt, 'x', 1, null);
    const [fresh] = ledger.owe([off('1.101')], encore, 'stop', null);
    ledger.fail('1.101', fresh!.attempt, 'x', 1, null);
    expect(ledger.onConnected(2, 1)).toHaveLength(1);
  });

  it('文案：先说结果、再说原因、最后说怎么办；补发也失败时按恢复上限表说；退出时每首歌一句', () => {
    expect(lightsLeftOnText(opening, 'MA2 没有回应。')).toBe('「开场」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。请在控台上关掉这首歌的执行器。');
    expect(lightsLeftOnText(null, '')).toBe('这首歌的灯光没能完全关闭，控台上可能还亮着。原因：未知错误。请在控台上关掉这首歌的执行器。');
    expect(lightsLeftOnAfterResendText(opening, 'MA2 没有回应')).toBe('「开场」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。关灯补发了一次控台还是没确认，已留在还欠着的关灯里。请检查控台后再按一次停止。');
    const ledger = new LightingOffLedger();
    for (const [song, executor] of [[opening, '1.101'], [opening, '1.102'], [encore, '1.103']] as const) {
      const [sent] = ledger.owe([off(executor)], song, 'stop', null);
      ledger.fail(executor, sent!.attempt, '没有连接控台', null, null);
    }
    expect(owedOffTexts(ledger.owed())).toEqual([lightsLeftOnText(opening, '没有连接控台'), lightsLeftOnText(encore, '没有连接控台')]);
  });
});
