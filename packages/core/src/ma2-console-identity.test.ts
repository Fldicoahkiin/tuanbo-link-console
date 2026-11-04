import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type LinkProject, type Ma2SongBinding } from '@tb/schema';
import { retargetMa2References } from './ma2-console-identity';
import { saveMa2MaterialLibraryCommand } from './ma2-program-import';
import { libraryReferenceIssue } from './lighting-library';

const OLD = { endpoint: '192.0.2.10:30000', show: '1hao 10.16' };
const NEW = { endpoint: '192.0.2.20:30000', show: '1hao 10.28' };
const track: LightingTrack = { id: 'track', name: '开场', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [],
  cueStamp: { mode: 'fixed', sequence: 12, cue: '1.000', executor: '' } };
const song = (sequence: number, name: string): Ma2SongBinding => ({ ...OLD, layout: null, executor: '1000.101', sequence, name, baselineXml: '<MA/>', points: [] });

function project(): LinkProject {
  const value = createEmptyLinkProject('换 Show');
  value.schemaVersion = 2;
  value.ma2MaterialLibrary = { version: 2, source: OLD.endpoint,
    library: { directory: { show: OLD.show, generation: 'monday', version: '3.3.4.3', entries: [{ target: 12, name: 'Wash' }, { target: 101, name: 'GeQu' }] },
      readAt: '2026-10-16T00:00:00.000Z', sequences: [{ sequence: 12, name: 'Wash', cues: [{ index: 0, number: '1.000', name: '开场' }] }], fixtureUsage: [], errors: [] },
    userLibrary: { version: 1, categories: [], entries: [{ id: 'wash', name: '开场', originalName: '开场', revision: 1, kind: 'single', categoryIds: [], favorite: false, source: { ...OLD, verified: true }, track }],
      consoleRenames: [{ ...OLD, sequence: 12, kind: 'single', cue: '1', name: '开场亮', confirmedName: '开场' }],
      hiddenConsoleCues: [{ ...OLD, sequence: 12, cue: '2', kind: 'single' }] } };
  value.rundown = ['甲', '乙', '丙'].map((id, index) => {
    const lighting = createLightingDocument();
    lighting.consoleSong = song(101 + index, index === 1 ? 'YiGe' : 'GeQu');
    lighting.ma2Library = { show: OLD.show, readAt: '2026-10-16T00:00:00.000Z', sequences: [] };
    lighting.fixtureCategories = [{ show: OLD.show, category: '面光', fixtureIds: [1] }];
    lighting.templates = [{ id: 'template', name: '开场', track, sourceShow: OLD.show }];
    return { id, title: id, enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting };
  });
  return value;
}

describe('控台按编号认：Show 另存新名字、换了 IP，工程里的引用跟着走', () => {
  it('素材、改名记录、隐藏的 Cue、每首歌的素材库和分类都改到新的地址和 Show 名', () => {
    const next = retargetMa2References(project(), OLD, NEW, [{ target: 12, name: 'Wash' }, { target: 101, name: 'GeQu' }]);
    const user = next.ma2MaterialLibrary!.userLibrary!;
    expect(user.entries[0]!.source).toEqual({ ...NEW, verified: true });
    expect(user.consoleRenames![0]).toMatchObject(NEW);
    expect(user.hiddenConsoleCues![0]).toMatchObject(NEW);
    for (const item of next.rundown) {
      expect(item.lighting!.ma2Library!.show).toBe(NEW.show);
      expect(item.lighting!.fixtureCategories).toEqual([{ show: NEW.show, category: '面光', fixtureIds: [1] }]);
      expect(item.lighting!.templates[0]!.sourceShow).toBe(NEW.show);
    }
  });

  it('自己的序列：控台上同号同名、或者已经没有了才跟过去；同号换了名字的留在原处，同步时会说明', () => {
    const next = retargetMa2References(project(), OLD, NEW, [{ target: 101, name: 'GeQu' }, { target: 102, name: '别人的序列' }]);
    expect(next.rundown.map(item => item.lighting!.consoleSong!.show)).toEqual([NEW.show, OLD.show, NEW.show]);
    expect(next.rundown[0]!.lighting!.consoleSong!.endpoint).toBe(NEW.endpoint);
  });

  it('另一台控台、另一个 Show 留下的引用不动；地址和 Show 都没变时原样返回', () => {
    const value = project();
    value.ma2MaterialLibrary!.userLibrary!.entries[0]!.source = { endpoint: '192.0.2.99:30000', show: '别的 Show', verified: true };
    expect(retargetMa2References(value, OLD, NEW, []).ma2MaterialLibrary!.userLibrary!.entries[0]!.source.show).toBe('别的 Show');
    expect(retargetMa2References(value, OLD, OLD, [])).toBe(value);
  });

  it('两个 Show 名下都有同一个分类时保留新 Show 的，不出现重复', () => {
    const value = project();
    value.rundown[0]!.lighting!.fixtureCategories = [{ show: OLD.show, category: '面光', fixtureIds: [1] }, { show: NEW.show, category: '面光', fixtureIds: [2] }];
    expect(retargetMa2References(value, OLD, NEW, []).rundown[0]!.lighting!.fixtureCategories).toEqual([{ show: NEW.show, category: '面光', fixtureIds: [2] }]);
  });

  it('保存新读到的素材目录时自动跟过去：素材不再提示“来自另一个 Show”', () => {
    const value = project();
    const library = { ...value.ma2MaterialLibrary!.library!, directory: { ...value.ma2MaterialLibrary!.library!.directory, show: NEW.show, generation: 'tuesday' } };
    const next = saveMa2MaterialLibraryCommand(NEW.endpoint, library).execute(value);
    const entry = next.ma2MaterialLibrary!.userLibrary!.entries[0]!;
    expect(entry.source).toEqual({ ...NEW, verified: true });
    expect(libraryReferenceIssue(next, entry)).toBeNull();
    expect(libraryReferenceIssue(value, value.ma2MaterialLibrary!.userLibrary!.entries[0]!)).toBeNull();
  });
});
