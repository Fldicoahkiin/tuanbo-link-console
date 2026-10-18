import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject, type LinkProject } from '@tb/schema';
import { expectedMa2Shows, ma2ShowMismatch } from './ma2-show-identity';

function project(show: string | undefined, events: 'ma2' | 'none'): LinkProject {
  const track = lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 5000, timeLock: 'time', muted: false,
      events: events === 'ma2' ? [{ id: 'cue', at: 1000, kind: 'ma2', sequence: 7, cue: '6.000', executor: '', label: '副歌', action: 'goto' }] : [] }] });
  const lighting = { ...createLightingDocument(), outputMode: 'network' as const, tracks: [track],
    ...(show ? { ma2Library: { show, readAt: '2026-10-13T00:00:00.000Z', sequences: [] } } : {}) };
  return parseLinkProject({ ...createEmptyLinkProject('灯光工程'), schemaVersion: 2, rundown: [{ id: 'song', title: '第一首', lighting }] });
}

describe('MA2 show 身份', () => {
  it('只有发送 MA2 Cue 的节目才有依据的 show；模板来源不计入', () => {
    expect(expectedMa2Shows(project('2hao', 'ma2'), 'song')).toEqual(['2hao']);
    expect(expectedMa2Shows(project('2hao', 'none'), 'song')).toEqual([]);
    expect(expectedMa2Shows(project(undefined, 'ma2'), 'song')).toEqual([]);
  });
  it('控台 show 与依据不一致时写清两边名称（2026-10-13/14 现场：2hao 的 Cue 发到 tblink_ui100）', () => {
    expect(ma2ShowMismatch(['2hao'], '2hao')).toBeNull();
    expect(ma2ShowMismatch([], 'tblink_ui100_20261007')).toBeNull();
    expect(ma2ShowMismatch(['2hao'], 'tblink_ui100_20261007')).toBe('控台当前加载的 show 是“tblink_ui100_20261007”，灯光 Cue 依据“2hao”编写，Cue 编号可能不存在或指向其他对象。请在控台加载对应 show，或在灯光工作台重新读取素材后核对。');
  });
});
