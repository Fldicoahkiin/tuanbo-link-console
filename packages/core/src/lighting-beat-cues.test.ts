import { expect, it } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingDocumentSchema, parseLinkProject, serializeLinkProject } from '@tb/schema';
import { setLightingCommand } from './lighting-edit';
import { cuesFromAudioMarks, hasAutomaticCueBatch } from './lighting-beat-cues';
const sha = 'a'.repeat(64);
it('生成 Cue 不新增来源字段，经工程命令保存重开仍保留 Cue', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('Cue 保存'), rundown: [{ id: 'song', title: '音频', cues: [] }] });
  const lighting = cuesFromAudioMarks(createLightingDocument(), [500, 1000], 4000, null, sha);
  expect(lighting).not.toHaveProperty('autoCueSource');
  const updated = setLightingCommand('song', lighting).execute(project);
  const reopened = parseLinkProject(JSON.parse(serializeLinkProject(updated)));
  expect(reopened.rundown[0]?.lighting?.tracks.flatMap(track => track.clips.flatMap(clip => clip.events))).toHaveLength(2);
});
it('排序去重生成一批 Cue，重复分析时间漂移也不会追加', () => {
  const original = createLightingDocument();
  const result = cuesFromAudioMarks(original, [1500, 500, 500, 1000, 5000], 4000, null, sha);
  const events = result.tracks.flatMap(track => track.clips.flatMap(clip => clip.events));
  expect(events.map(event => event.at)).toEqual([500, 1000, 1500]);
  expect(events.map(event => event.kind === 'ma2' ? event.cue : null)).toEqual(['1', '2', '3']);
  expect(original.tracks).toHaveLength(0);
  expect(cuesFromAudioMarks(result, [510, 1010, 1500, 2000], 4000, null, sha)).toBe(result);
});
it('保存重开、移动和删除点后，自动生成不补点', () => {
  const generated = cuesFromAudioMarks(createLightingDocument(), [500, 1000], 4000, null, sha);
  const edited = lightingDocumentSchema.parse({ ...generated, tracks: generated.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: clip.events.slice(0, 1).map(event => ({ ...event, at: 700 })) })) })) });
  const reopened = lightingDocumentSchema.parse(JSON.parse(JSON.stringify(edited)));
  expect(cuesFromAudioMarks(reopened, [500, 1000], 4000, null, sha)).toBe(reopened);
  const cleared = { ...reopened, tracks: [] };
  expect(hasAutomaticCueBatch(cleared, sha, 4000)).toBe(false);
  expect(cuesFromAudioMarks(cleared, [500], 4000, null, sha).tracks).toHaveLength(1);
  expect(cuesFromAudioMarks(cleared, [500], 4000, null, 'b'.repeat(64)).tracks).toHaveLength(1);
});
it('空自动片段不阻止重新生成，生成的 Cue 可被时间线读取', () => {
  const generated = cuesFromAudioMarks(createLightingDocument(), [500], 4000, null, sha);
  const empty = { ...generated, tracks: generated.tracks.map(track => ({ ...track, clips: track.clips.map(clip => ({ ...clip, events: [] })) })) };
  expect(hasAutomaticCueBatch(empty, sha, 4000)).toBe(false);
  const rebuilt = cuesFromAudioMarks(empty, [500, 1000], 4000, null, sha);
  expect(rebuilt.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).map(event => event.at)).toEqual([500, 1000]);
  expect(hasAutomaticCueBatch(rebuilt, sha, 4000)).toBe(true);
});
it('已有自动生成片段不会再追加另一批', () => {
  const generated = cuesFromAudioMarks(createLightingDocument(), [500], 4000, null, sha);
  const document = { ...createLightingDocument(), tracks: generated.tracks };
  expect(hasAutomaticCueBatch(document, sha, 4000)).toBe(true);
  expect(cuesFromAudioMarks(document, [510, 1000], 4000, null, sha)).toBe(document);
});
