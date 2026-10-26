import { describe, expect, it } from 'vitest';
import { createLightingDocument, type LightingDocument, type Ma2TimecodePreview } from '@tb/schema';
import { matchMa2Readback, resolveMa2Readback } from './ma2-readback';

function read(events: Array<{ id: string; time: number; cueIndex: number }>): Ma2TimecodePreview {
  const document = createLightingDocument();
  document.tracks = [{ id: 'track', kind: 'ma2', name: '灯光', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '编排', start: 0, duration: 100000, timeLock: 'time', muted: false, events: events.map((event) => ({ id: event.id, kind: 'ma2', at: event.time, cue: String(event.cueIndex), label: 'Cue', executor: '1.5', sequence: 2, action: 'goto' })) }] }];
  return { target: 9, name: 'Timecode', readAt: '2026-09-11T00:00:00.000Z', sourceXml: '<MA/>', document, warnings: [], unconverted: [], mappings: events.map((event, index) => ({ eventId: event.id, trackId: 'track', clipId: 'clip', path: `Event:${index}`, executor: '1.5', sequence: 2, cueIndex: event.cueIndex })) };
}
function baseline(preview: Ma2TimecodePreview): NonNullable<LightingDocument['ma2Bindings']>[number] {
  return { id: 'binding', timecode: preview.target, name: preview.name, readAt: preview.readAt, sourceXml: preview.sourceXml, mappings: preview.mappings, baselineTracks: preview.document.tracks };
}

describe('MA2 回读事件身份', () => {
  it('逐点确认对应或新增后保留未使用旧点为删除，拒绝重复和过期选择', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 2000, cueIndex: 1 }]));
    const remote = read([{ id: 'ra', time: 3000, cueIndex: 1 }, { id: 'rb', time: 4000, cueIndex: 1 }]);
    const choices = new Map<string, string | null>([['ra', 'a'], ['rb', null]]);
    expect(resolveMa2Readback(base, remote, choices)).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }], added: ['rb'], deleted: ['b'], ambiguous: [] });
    expect(() => resolveMa2Readback(base, remote, new Map([['ra', 'a']]))).toThrow('所有');
    expect(() => resolveMa2Readback(base, remote, new Map([['ra', 'a'], ['rb', 'a']]))).toThrow('多个');
    expect(() => resolveMa2Readback(base, remote, new Map([['ra', 'wrong'], ['rb', 'b']]))).toThrow('候选');
    expect(() => resolveMa2Readback(base, remote, new Map([...choices, ['old-read', null]]))).toThrow('过期');
    expect(matchMa2Readback(base, remote).ambiguous).toHaveLength(1);
  });
  it('移动时间或插入导致索引变化时，按唯一 Cue 引用对应原事件', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 2000, cueIndex: 2 }]));
    const remote = read([{ id: 'new', time: 0, cueIndex: 3 }, { id: 'rb', time: 3000, cueIndex: 2 }, { id: 'ra', time: 4000, cueIndex: 1 }]);
    expect(matchMa2Readback(base, remote)).toEqual({ matches: [{ baselineEventId: 'a', remoteEventId: 'ra' }, { baselineEventId: 'b', remoteEventId: 'rb' }], added: ['new'], deleted: [], ambiguous: [] });
  });
  it('重复 Cue 按唯一时间匹配，无法确定的移动保持待确认而非按索引猜测', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 2000, cueIndex: 1 }]));
    const remote = read([{ id: 'rb', time: 2000, cueIndex: 1 }, { id: 'rx', time: 3000, cueIndex: 1 }]);
    const result = matchMa2Readback(base, remote);
    expect(result.matches).toEqual([{ baselineEventId: 'b', remoteEventId: 'rb' }]);
    expect(result.ambiguous[0]).toMatchObject({ baselineEventIds: ['a'], remoteEventIds: ['rx'] });
    expect(result.added).toEqual([]); expect(result.deleted).toEqual([]);
  });
  it('同时间同 Cue 的重复点不任意配对，明确区分新增与删除', () => {
    const base = baseline(read([{ id: 'a', time: 1000, cueIndex: 1 }, { id: 'b', time: 1000, cueIndex: 1 }, { id: 'removed', time: 2000, cueIndex: 2 }]));
    const result = matchMa2Readback(base, read([{ id: 'ra', time: 1000, cueIndex: 1 }, { id: 'rb', time: 1000, cueIndex: 1 }, { id: 'new', time: 5000, cueIndex: 3 }]));
    expect(result.matches).toEqual([]); expect(result.ambiguous).toHaveLength(1);
    expect(result.added).toEqual(['new']); expect(result.deleted).toEqual(['removed']);
  });
  it('错对象、未转换事件与不完整映射均不产生可用匹配结果', () => {
    const remote = read([{ id: 'a', time: 1000, cueIndex: 1 }]); const base = baseline(remote);
    expect(() => matchMa2Readback(base, { ...remote, target: 10 })).toThrow('和节目绑定对不上');
    expect(() => matchMa2Readback(base, { ...remote, unconverted: [{ path: 'x', reason: '未支持' }] })).toThrow('还不支持的事件');
    expect(() => matchMa2Readback(base, { ...remote, mappings: [] })).toThrow('未映射');
  });
});
