import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, type LightingEvent } from '@tb/schema';
import { compileLightingNetworkActions, compileLightingPackets } from './lighting-playback';

function cue(id: string, sequence: number, at: number, runMode?: 'independent' | 'follow', group?: string): LightingEvent {
  return { id, kind: 'ma2', at, sequence, cue: '1', executor: `1.${100 + sequence}`, action: 'goto', label: id, runMode, ...(group ? { effectGroupId: group } : {}) };
}
function document(events: LightingEvent[]) { return lightingDocumentSchema.parse({ ...createLightingDocument(), version: 2, tracks: [{ id: 'track', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '曲', start: 0, duration: 10000, timeLock: 'time', muted: false, events }] }] }); }
it('试听：单独运行先关闭此前组合，跟随保留，旧工程行为不改变', () => {
  const result = compileLightingNetworkActions(document([cue('a', 1, 0), cue('b', 2, 100, 'follow'), cue('c', 3, 200, 'independent')]));
  expect(result.map(value => [value.atMs, value.action.action, value.action.target === 'executor' ? value.action.executor : ''])).toEqual([[0,'goto','1.101'],[100,'goto','1.102'],[200,'off','1.101'],[200,'off','1.102'],[200,'goto','1.103']]);
  expect(compileLightingNetworkActions(document([cue('a',1,0),cue('b',2,100)])).map(value => value.action.action)).toEqual(['goto','goto']);
});
it('组合只切换一次、取消前组迟到素材，同一时间的独立 Cue 不互相关闭', () => {
  const values = compileLightingNetworkActions(document([cue('a',1,0,'independent','a'),cue('a-late',2,300,'independent','a'),cue('b',3,100,'independent','b'),cue('b-late',4,200,'independent','b'),cue('c',5,100,'independent')]));
  expect(values.map(value => value.action.target === 'executor' ? `${value.action.action}:${value.action.executor}` : '')).toEqual(['goto:1.101','off:1.101','goto:1.103','goto:1.105','goto:1.104']);
});
it('埋步切换整组，静音轨道不参与', () => {
  const prepared = cue('b',2,2000,'independent'); if (prepared.kind !== 'ma2') throw new Error('fixture'); prepared.preparation = { cue: '0.5', leadMs: 500 };
  const value = document([cue('a',1,0), prepared]);
  expect(compileLightingNetworkActions(value).map(entry => [entry.atMs,entry.action.action])).toEqual([[0,'goto'],[1500,'off'],[1500,'goto'],[2000,'goto']]);
  expect(compileLightingNetworkActions({ ...value, tracks: value.tracks.map(track => ({ ...track, muted: true })) })).toEqual([]);
});
it('MIDI 编码：单独运行在同一时刻先 Off 前一个执行器再 Go', () => {
  const packets = compileLightingPackets(document([cue('a',1,0),cue('b',2,100,'independent')]));
  expect(packets.map(value => [value.atMs, value.bytes[5]])).toEqual([[0,1],[100,11],[100,1]]);
});
