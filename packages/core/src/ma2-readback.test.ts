import { describe, expect, it } from 'vitest';
import { createLightingDocument, type LightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { matchMa2Readback } from './ma2-readback';

function read(events: Array<{ id: string; time: number; cueIndex: number }>): Ma2TimecodePreview {
  const document = createLightingDocument();
  document.tracks = [{ id: 'track', kind: 'ma2', name: '灯光', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '编排', start: 0, duration: 100000, timeLock: 'time', muted: false, events: events.map((event) => ({ id: event.id, kind: 'ma2', at: event.time, cue: String(event.cueIndex), label: 'Cue', executor: '1.5', sequence: 2, action: 'goto' })) }] }];
  return { target: 9, name: 'Timecode', readAt: '2026-09-11T00:00:00.000Z', sourceXml: '<MA/>', document, warnings: [], unconverted: [], mappings: events.map((event, index) => ({ eventId: event.id, trackId: 'track', clipId: 'clip', path: `Event:${index}`, executor: '1.5', sequence: 2, cueIndex: event.cueIndex })) };
}
function baseline(preview: Ma2TimecodePreview): NonNullable<LightingDocument['ma2Bindings']>[number] {
  return { id: 'binding', timecode: preview.target, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, mappings: preview.mappings, baselineTracks: preview.document.tracks };
}
const cue1 = (entries: Array<[string, number]>) => entries.map(([id, time]) => ({ id, time, cueIndex: 1 }));
const pairs = (base: Array<[string, number]>, remote: Array<[string, number]>) => matchMa2Readback(baseline(read(cue1(base))), read(cue1(remote)));

describe('MA2 回读事件身份', () => {
  it('移动时间或插入导致索引变化时，按唯一 Cue 引用对应原事件', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 2000, cueIndex: 2 }]));
    const remote = read([{ id: 'new', time: 0, cueIndex: 3 }, { id: 'rb', time: 3000, cueIndex: 2 }, { id: 'ra', time: 4000, cueIndex: 1 }]);
    expect(matchMa2Readback(base, remote)).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'b', remoteEventId: 'rb' }], added: ['new'], deleted: [] });
  });
  // 2026-11-11 现场（natural.mp4，Timecode 63）：同一个 Cue 触发两次，控台上挪了其中一次，同步一直报“对不上”。
  // 用户原话：“我要的是软件能实时同步控台做出的修改”。同一组的点都是同一个 Cue 调用，配对只决定哪个本地点留着哪个身份，不用人确认。
  it('同一个 Cue 触发两次、控台上挪了其中一次：时间没变的那次对上原点，挪了的那次对上另一个点，不留待确认', () => {
    expect(pairs([['a', 1000], ['b', 2000]], [['ra', 1000], ['rx', 3000]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'b', remoteEventId: 'rx' }], added: [], deleted: [] });
  });
  it('两次触发都挪了：按时间先后一一对上', () => {
    expect(pairs([['a', 1000], ['b', 2000]], [['r2', 2500], ['r1', 1500]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r1' }, { baselineEventId: 'b', remoteEventId: 'r2' }], added: [], deleted: [] });
  });
  it('删了一次、挪了另一次：留下的那次对上离它最近的原点，另一个原点算删除', () => {
    expect(pairs([['a', 1000], ['b', 2000]], [['r', 2100]])).toEqual({ matches: [{ baselineEventId: 'b', remoteEventId: 'r' }], added: [], deleted: ['a'] });
    expect(pairs([['a', 1000], ['b', 2000]], [['r', 900]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r' }], added: [], deleted: ['b'] });
  });
  it('控台上多加了一次触发：原来的两次对上，多出的那次算新增', () => {
    expect(pairs([['a', 1000], ['b', 2000]], [['ra', 1000], ['rc', 1500], ['rb', 2000]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'b', remoteEventId: 'rb' }], added: ['rc'], deleted: [] });
    // 挪了一次又加了一次：顺序不变、总距离最小的配法。
    expect(pairs([['a', 1000], ['b', 2000]], [['r1', 1100], ['r2', 5000], ['r3', 2100]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r1' }, { baselineEventId: 'b', remoteEventId: 'r3' }], added: ['r2'], deleted: [] });
  });
  it('三次触发挪了中间一次：另外两次按时间对上，中间那次对上挪过的', () => {
    expect(pairs([['a', 1000], ['b', 2000], ['c', 3000]], [['ra', 1000], ['rb', 2500], ['rc', 3000]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'c', remoteEventId: 'rc' }, { baselineEventId: 'b', remoteEventId: 'rb' }], added: [], deleted: [] });
  });
  it('两边次数不同：保持先后顺序、总距离最小，多出来的算新增或删除', () => {
    expect(pairs([['a', 1000], ['b', 2000], ['c', 3000]], [['r1', 1900], ['r2', 3100]])).toEqual({ matches: [{ baselineEventId: 'b', remoteEventId: 'r1' }, { baselineEventId: 'c', remoteEventId: 'r2' }], added: [], deleted: ['a'] });
    expect(pairs([['a', 1000]], [['r1', 900], ['r2', 5000]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r1' }], added: ['r2'], deleted: [] });
  });
  it('两边次数不同、离得一样远：对上前面那次，后面的算新增或删除，结果不看控台的事件编号', () => {
    expect(pairs([['a', 1000]], [['r1', 900], ['r2', 1100]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r1' }], added: ['r2'], deleted: [] });
    expect(pairs([['a', 900], ['b', 1100]], [['r1', 1000]])).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'r1' }], added: [], deleted: ['b'] });
  });
  it('同时间同 Cue 的重复点按顺序对上，不再等人确认', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 1000, cueIndex: 1 }, { id: 'removed', time: 2000, cueIndex: 2 }]));
    const result = matchMa2Readback(base, read([{ id: 'ra', time: 1000, cueIndex: 1 }, { id: 'rb', time: 1000, cueIndex: 1 }, { id: 'new', time: 5000, cueIndex: 3 }]));
    expect(result.matches).toEqual([{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'b', remoteEventId: 'rb' }]);
    expect(result.added).toEqual(['new']); expect(result.deleted).toEqual(['removed']);
  });
  it('错对象与不完整映射不产生可用匹配结果；软件不转换的控台动作不参与匹配（2026-10-26）', () => {
    const remote = read([{ id: 'a', time: 1000, cueIndex: 1 }]); const base = baseline(remote);
    expect(() => matchMa2Readback(base, { ...remote, target: 10 })).toThrow('和节目绑定对不上');
    expect(matchMa2Readback(base, { ...remote, unconverted: [{ path: 'x', reason: '未支持' }] }).matches).toHaveLength(1);
    expect(() => matchMa2Readback(base, { ...remote, mappings: [] })).toThrow('未映射');
  });
});
