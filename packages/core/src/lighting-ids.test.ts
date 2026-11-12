import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, createLightingMusic, lightingDocumentSchema, parseLinkProject, type LightingDocument, type LightingEvent, type LightingTrack, type LinkProject, type Ma2Catalog } from '@tb/schema';
import { duplicateRundownItemCommand } from './link-command';
import { appendLightingDocument } from './lighting-import';
import { withNewLightingIds } from './lighting-ids';
import { ma2PendingChanges } from './ma2-pending-changes';
import { matchMa2Programs } from './ma2-program-matching';
import { ma2SongPoints } from './ma2-song-sequence';
import { songMtcOverlaps } from './mtc-start';

const cue = (id: string, at: number, extra: Partial<Extract<LightingEvent, { kind: 'ma2' }>> = {}): LightingEvent =>
  ({ id, kind: 'ma2', at, sequence: 2, cue: '1', executor: '1.101', action: 'goto', label: `点${id}`, ...extra });
const track = (id: string, events: LightingEvent[]): LightingTrack => ({ id, name: `轨道${id}`, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false,
  channel: 1, controller: 7, portProfileId: '', noteNames: {}, clips: [{ id: `${id}-clip`, name: '片段', start: 0, duration: 40_000, timeLock: 'time', muted: false, events }] });

/** Way 1: the Cues of console Timecode 1, with a baseline, mappings, track mappings and a track waiting to be written. */
function wayOne(editedAt = 1000, waiting = true): LightingDocument {
  const lighting = createLightingDocument(); lighting.version = 2;
  const live = track('t1', [cue('lead', editedAt, { effectGroupId: 'lead' }), cue('member', 1500, { effectGroupId: 'lead', sequence: 3 })]);
  const baseline = track('t1', [cue('lead', 1000, { effectGroupId: 'lead' }), cue('member', 1500, { effectGroupId: 'lead', sequence: 3 })]);
  lighting.tracks = [live, track('t2', [cue('loose', 3000)])];
  lighting.markers = [{ id: 'marker', name: '主歌', startMs: 500, endMs: null }];
  lighting.music = { ...createLightingMusic(), sections: [{ id: 'section', name: '副歌', startMs: 0, endMs: 2000, color: '#abcdef', notes: '' }] };
  lighting.templates = [{ id: 'template', name: '素材', track: track('template-track', []) }];
  lighting.ma2Bindings = [{ id: 'binding', timecode: 1, name: '灯光 1', readAt: '2026-11-01T00:00:00.000Z', sourceXml: '<MA/>', playback: 'editable', timeOriginMs: 60_000,
    baselineTracks: [baseline],
    mappings: [
      { trackId: 't1', clipId: 't1-clip', eventId: 'lead', path: 'TC:1/Track:0/Event:0', sequence: 2, cueIndex: 0, executor: '1.101' },
      { trackId: 't1', clipId: 't1-clip', eventId: 'member', path: 'TC:1/Track:0/Event:1', sequence: 3, cueIndex: 0, executor: '1.101' }
    ],
    trackMappings: [{ trackId: 't1', path: 'TC:1/Track:0', executor: '1.101', subtracks: [] }],
    ...waiting ? { pendingTracks: [{ trackId: 't2', executor: '1.102', executorName: '新轨道' }] } : {} }];
  return lightingDocumentSchema.parse(lighting);
}

/** Way 2: the song's own sequence, its console points named after the events and effect groups. */
function wayTwo(): LightingDocument {
  const lighting = createLightingDocument(); lighting.version = 2;
  lighting.tracks = [track('w', [cue('p1', 1000, { effectGroupId: 'p1' }), cue('p1b', 1200, { effectGroupId: 'p1', cue: '2' }), cue('p2', 5000, { cue: '3' })])];
  const points = ma2SongPoints(lighting).map(point => ({ id: point.id, cue: point.cues[0]!.cue, atMs: point.atMs }));
  lighting.consoleSong = { endpoint: '192.0.2.1:30000', show: 'show', layout: null, executor: '1000.101', sequence: 9000, name: 'B', baselineXml: '<MA/>', points,
    timecode: { number: 9000, offset: 3600, slot: 'TC Slot 2', revision: 'a'.repeat(64) } };
  return lightingDocumentSchema.parse(lighting);
}

function project(lightingA = wayOne()): LinkProject {
  const value = createEmptyLinkProject('复制'); value.schemaVersion = 2;
  const song = (id: string, startMs: number, lighting: LightingDocument) => ({ id, title: `歌曲${id}`, enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting,
    referenceAudio: { assetId: id, relativePath: `${id}.wav`, sha256: 'a'.repeat(64), durationMs: 10_000 },
    playback: { volume: 100, endAction: 'stop' as const, startMs: 0, endMs: 0, mtcOffsetMs: startMs, shortcut: '' } });
  value.rundown = [song('A', 60_000, lightingA), song('B', 120_000, wayTwo())];
  return value;
}

/** Every id the song's lighting owns, with where it sits; templates and their library references are the project's. */
function ownIds(lighting: LightingDocument): string[] {
  const events = (tracks: LightingTrack[]) => tracks.flatMap(entry => [entry.id, ...entry.clips.flatMap(clip => [clip.id, ...clip.events.flatMap(event => [event.id, ...event.effectGroupId ? [event.effectGroupId] : []])])]);
  return [
    ...events(lighting.tracks), ...lighting.markers.map(marker => marker.id), ...lighting.music?.sections.map(section => section.id) ?? [],
    ...(lighting.ma2Bindings ?? []).flatMap(binding => [binding.id, ...events(binding.baselineTracks),
      ...binding.mappings.flatMap(mapping => [mapping.trackId, mapping.clipId, mapping.eventId]),
      ...binding.trackMappings?.map(mapping => mapping.trackId) ?? [], ...binding.pendingTracks?.map(entry => entry.trackId) ?? []]),
    ...lighting.consoleSong?.points.map(point => point.id) ?? []
  ];
}

/** The same document with each own id replaced by the position it first appeared at: equal when only the ids differ. */
function shape(lighting: LightingDocument): string {
  const order = new Map<string, string>();
  for (const id of ownIds(lighting)) if (!order.has(id)) order.set(id, `#${order.size}`);
  return JSON.stringify(lighting, (key, value: unknown) => typeof value === 'string' && ['id', 'trackId', 'clipId', 'eventId', 'effectGroupId'].includes(key) && order.has(value) ? order.get(value) : value);
}

const catalog: Ma2Catalog = { directory: { show: 'show', version: '3.3.4', generation: '1', entries: [] }, readAt: '2026-11-01T00:00:00.000Z',
  entries: [{ target: 1, name: '灯光 1', eventCount: 1, frameFormat: '30 FPS', offset: '1800', slot: 'TC Slot 1', events: [{ path: '30', time: '30', action: 'Goto', executor: '1.101', cue: '1', name: 'Cue' }], error: null, warnings: [] }] };

/** The copy as 0.5.8 made it: the source's lighting with the source's ids. */
function withOldCopy(value: LinkProject): LinkProject {
  return { ...value, rundown: value.rundown.map((item, index) => index > 0 && value.rundown[index - 1]!.lighting && item.title.endsWith(' 副本') ? { ...item, lighting: structuredClone(value.rundown[index - 1]!.lighting) } : item) };
}

describe('复制出来的歌有自己的灯光编号（0.5.9 遗留 1）', () => {
  it.each([['方式 1', 'A', 1], ['方式 2', 'B', 2]] as const)('%s：每个编号都换新，引用跟着换，文件照常能读', (_, itemId, index) => {
    const before = project();
    const after = duplicateRundownItemCommand(itemId).execute(before);
    const source = after.rundown.find(item => item.id === itemId)!.lighting!;
    const copy = after.rundown[index]!.lighting!;
    expect(after.rundown[index]!.title).toBe(`歌曲${itemId} 副本`);
    expect(source).toEqual(before.rundown.find(item => item.id === itemId)!.lighting);
    const sourceIds = new Set(ownIds(source));
    expect(ownIds(copy).filter(id => sourceIds.has(id))).toEqual([]);
    // Only the ids changed, each one the same way wherever it is referenced.
    expect(shape(copy)).toBe(shape(source));
    expect(copy.templates).toEqual(source.templates);
    expect(lightingDocumentSchema.parse(copy)).toEqual(copy);
    expect(() => parseLinkProject(JSON.parse(JSON.stringify(after)))).not.toThrow();
  });

  it('方式 2 的控台点仍然对着副本自己的点和组合', () => {
    const after = duplicateRundownItemCommand('B').execute(project());
    const copy = after.rundown[2]!.lighting!;
    expect(copy.consoleSong!.points.map(point => point.id)).toEqual(ma2SongPoints(copy).map(point => point.id));
    const [lead, member] = copy.tracks[0]!.clips[0]!.events;
    expect(member!.effectGroupId).toBe(lead!.id);
    expect(lead!.effectGroupId).toBe(lead!.id);
  });

  it('待同步和没改动时一样：副本只是换了编号，不算要写到控台的改动', () => {
    for (const [editedAt, waiting] of [[1000, false], [2500, false], [1000, true]] as const) {
      const after = duplicateRundownItemCommand('A').execute(project(wayOne(editedAt, waiting)));
      const pending = ma2PendingChanges(after);
      const of = (itemId: string) => pending.filter(change => change.itemId === itemId).map(change => change.changes.length);
      expect(of(after.rundown[1]!.id)).toEqual(of('A'));
      // In step with the console: nothing to write for either; edited or with a track to add: the same for both.
      expect(of('A')).toHaveLength(editedAt === 1000 && !waiting ? 0 : 1);
      expect(ma2PendingChanges(withOldCopy(after)).map(change => change.changes.length)).toEqual(pending.map(change => change.changes.length));
    }
  });

  it('配对和 MTC 区间重叠提示和以前复制出来的一样', () => {
    for (const itemId of ['A', 'B']) {
      const after = duplicateRundownItemCommand(itemId).execute(project());
      const old = withOldCopy(after);
      expect(matchMa2Programs(after, catalog)).toEqual(matchMa2Programs(old, catalog));
      expect(songMtcOverlaps(after)).toEqual(songMtcOverlaps(old));
    }
    // What a fresh copy of a way 1 song does today, unchanged here: the console show goes to the copy, listed right after it.
    const after = duplicateRundownItemCommand('A').execute(project());
    expect(matchMa2Programs(after, catalog).pairs).toEqual({ 1: after.rundown[1]!.id });
    // Same audio from the same start: one song on the console, no overlap warning.
    expect(songMtcOverlaps(after).size).toBe(0);
  });

  it('导入到空白歌曲的灯光也换新编号', () => {
    const source = wayOne();
    const imported = appendLightingDocument(createLightingDocument(), source);
    const sourceIds = new Set(ownIds(source));
    expect(ownIds(imported).filter(id => sourceIds.has(id))).toEqual([]);
    expect(shape(imported)).toBe(shape(source));
    expect(withNewLightingIds(source)).not.toEqual(source);
  });
});
