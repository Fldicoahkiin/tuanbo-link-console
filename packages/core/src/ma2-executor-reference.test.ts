import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, type LightingTrack, type Ma2TimecodePreview } from '@tb/schema';
import { applyMa2ExecutorChangeCommand, ma2ExecutorDeletionUses } from './ma2-executor-change';
import { nextLightingCue } from './lighting-cue-sequence';
import { matchMa2Readback, resolveMa2ReadbackTracks } from './ma2-readback';

function sample() {
  const track: LightingTrack = { id: 't', name: '灯光', kind: 'ma2', color: '#abcdef', group: '', muted: false, solo: false, locked: false, channel: 1, controller: 7, portProfileId: '', noteNames: {}, cueStamp: { mode: 'fixed', sequence: 9000, cue: '1', executor: '1000.101' },
    clips: [{ id: 'c', name: '曲', start: 0, duration: 1000, timeLock: 'time', muted: false, events: [{ id: 'e', kind: 'ma2', at: 0, action: 'goto', cue: '1', sequence: 9000, executor: '1000.101', label: '开场' }] }] };
  const project = createEmptyLinkProject('执行器引用');
  project.schemaVersion = 2;
  const light = createLightingDocument(); light.tracks = [track];
  light.ma2Bindings = [{ id: 'b', timecode: 99, name: 'Timecode', readAt: '2026-10-20T00:00:00.000Z', sourceXml: '<MA>original</MA>', baselineTracks: structuredClone(light.tracks),
    mappings: [{ trackId: 't', clipId: 'c', eventId: 'e', executor: '1000.101', sequence: 9000, cueIndex: 1, path: 'Event:0' }],
    trackMappings: [{ trackId: 't', executor: '1000.101', path: 'Track:0', subtracks: ['SubTrack:0'] }] }];
  project.ma2MaterialLibrary = { version: 1, source: '192.0.2.1:30000', library: { directory: { show: 'Show', generation: 'g', version: '3.7.0.5', entries: [] }, readAt: '2026-10-20T00:00:00.000Z', sequences: [], errors: [], fixtureUsage: [] } };
  project.rundown = [{ id: 'song', title: '曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: light }];
  return project;
}
it.each(['go', 'off'] as const)('带 sequence 的 %s 仍需执行器，写前清单必须阻止删除；确认后也不能制造非法工程', action => {
  const project = sample();
  project.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events.push({ id: 'dedicated', kind: 'ma2', action, sequence: 9000, at: 500, executor: '1000.101', label: action });
  expect(ma2ExecutorDeletionUses(project, '1000.101')).toHaveLength(1);
  // A dedicated action could be added while native deletion is in flight.
  const retained = applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Show', 9000, '1000.101', null).execute(project);
  expect(retained.rundown[0]!.lighting!.tracks[0]!.clips[0]!.events).toMatchObject([{ executor: '' }, { action, executor: '1000.101' }]);
});
it('删除清单包含节目模板和用户素材中的执行器专用动作，不把其他来源列入当前控台', () => {
  const project = sample(); const track = structuredClone(project.rundown[0]!.lighting!.tracks[0]!);
  track.clips[0]!.events = [{ id: 'fader', kind: 'ma2-fader', at: 0, executor: '1000.101', fader: 'Master', level: 1, label: '亮度' }];
  project.rundown[0]!.lighting!.templates = [{ id: 'template', name: '模板', track }];
  const entry = { id: 'entry', name: '素材', originalName: '素材', revision: 1, kind: 'single' as const, categoryIds: [], favorite: false, track, source: { endpoint: '192.0.2.1:30000', show: 'Show', verified: true } };
  project.ma2MaterialLibrary!.userLibrary = { version: 1, categories: [], entries: [entry, { ...entry, id: 'other', name: '另一控台素材', source: { ...entry.source, endpoint: 'other' } }] };
  expect(ma2ExecutorDeletionUses(project, '1000.101')).toEqual(expect.arrayContaining([expect.stringContaining('模板'), expect.stringContaining('素材')]));
  expect(ma2ExecutorDeletionUses(project, '1000.101')).toHaveLength(2);
});
it('移动迁移可编辑映射，继续打点和自动关联不产生新轨，原始快照保持作为回读证据', () => {
  const project = sample(); const original = structuredClone(project.rundown[0]!.lighting!.ma2Bindings![0]!);
  const moved = applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Show', 9000, '1000.101', '1001.2').execute(project).rundown[0]!.lighting!;
  const binding = moved.ma2Bindings![0]!;
  expect(binding.mappings[0]!.executor).toBe('1001.2'); expect(binding.trackMappings![0]!.executor).toBe('1001.2');
  expect(binding.sourceXml).toBe(original.sourceXml); expect(binding.baselineTracks).toEqual(original.baselineTracks);
  expect(nextLightingCue(moved, moved.tracks[0]!, 0).executor).toBe('1001.2');
  // Every Cue still plays the executor its track is bound to, so none of them needs a new track.
  expect(moved.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).filter(event => event.kind === 'ma2' && event.executor !== '1001.2')).toEqual([]);
  const remote = createLightingDocument(); remote.tracks = structuredClone(moved.tracks);
  const preview: Ma2TimecodePreview = { target: 99, name: 'Timecode', readAt: original.readAt, sourceXml: '<MA>moved</MA>', document: remote, warnings: [], unconverted: [], mappings: structuredClone(binding.mappings), trackMappings: structuredClone(binding.trackMappings) };
  const match = matchMa2Readback(binding, preview);
  expect(match).toMatchObject({ added: [], deleted: [], ambiguous: [], matches: [{ baselineEventId: 'e', remoteEventId: 'e' }] });
  expect(resolveMa2ReadbackTracks(binding, preview, match).get('t')).toBe('t');
});
it('当前工程中明确来自另一Show的歌曲和模板不会因同数字地址被修改', () => {
  const project = sample();
  const light = project.rundown[0]!.lighting!;
  light.templates = [{ id: 'foreign', name: '异地素材', sourceShow: 'Other', track: structuredClone(light.tracks[0]!) }];
  const other = structuredClone(project.rundown[0]!); other.id = 'other'; other.lighting!.ma2Library = { show: 'Other', readAt: '2026-10-20T00:00:00.000Z', sequences: [] };
  project.rundown.push(other);
  const moved = applyMa2ExecutorChangeCommand('192.0.2.1:30000', 'Show', 9000, '1000.101', '1001.2').execute(project);
  expect(moved.rundown[0]!.lighting!.templates[0]!.track.cueStamp).toMatchObject({ executor: '1000.101' });
  expect(moved.rundown[1]!.lighting!.tracks[0]!.cueStamp).toMatchObject({ executor: '1000.101' });
});
