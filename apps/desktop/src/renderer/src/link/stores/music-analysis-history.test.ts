import { beforeEach, expect, it } from 'vitest';
import { acceptMusicStructure, clearedSongMusic, editMusicStructure, renameProjectCommand, setSongMusicCommand } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { useDocumentStore } from './document-store';

const source = { assetId: 'audio', relativePath: 'music.wav', sha256: 'a'.repeat(64), durationMs: 10000 };
const candidates = { sourceSha256: source.sha256, durationMs: source.durationMs, bpm: 120, items: Array.from({ length: 20 }, (_, i) => ({ id: `beat:${i}`, kind: 'beat' as const, name: '拍点', startMs: i * 500, endMs: null })) };
const music = acceptMusicStructure({}, source, candidates, 'background-task');
const initial = () => parseLinkProject({ ...createEmptyLinkProject('初始'), schemaVersion: 2,
  rundown: [{ id: 'song', title: '歌曲', referenceAudio: source, lighting: createLightingDocument() }] });
const current = () => useDocumentStore.getState().project!;
const song = () => current().rundown[0]!;
const background = (value = music) => setSongMusicCommand('song', source, value, { label: '自动识别音乐节拍与段落', background: true });

beforeEach(() => useDocumentStore.getState().setProject(initial(), null));

it('撤销后迟到的自动分析保留重做，之后反复撤销重做仍保留识别结果', () => {
  const store = useDocumentStore.getState();
  store.execute(renameProjectCommand('第一次修改'));
  store.execute(renameProjectCommand('第二次修改'));
  store.undo();
  const lighting = song().lighting;
  store.execute(background());
  expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  // The beats are the song's; the lighting document is not touched.
  expect(song().lighting).toBe(lighting);
  expect(song().music).toEqual(music);
  store.redo(); expect(current().name).toBe('第二次修改');
  store.undo(); store.undo(); expect(current().name).toBe('初始');
  expect(song().music).toEqual(music);
  store.redo(); store.redo(); expect(current().name).toBe('第二次修改');
  expect(song().music).toEqual(music);
  expect(current().schemaVersion).toBe(3);
  expect(() => parseLinkProject(current())).not.toThrow();
});

it('手动清除与重新分析仍可撤销，迟到结果不覆盖已确认的分析状态', () => {
  const store = useDocumentStore.getState();
  store.execute(background());
  store.execute(setSongMusicCommand('song', source, editMusicStructure(song(), { kind: 'clear' }), { label: '清除识别' }));
  store.execute(background({ ...music, structure: { ...music.structure, taskId: 'late-task' } }));
  expect(song().music?.structure.state).toBe('cleared');
  store.undo(); expect(song().music).toEqual(music);
  store.redo(); expect(song().music?.structure.state).toBe('cleared');
  store.execute(setSongMusicCommand('song', source, music, { label: '重新分析' }));
  store.undo(); expect(song().music?.structure.state).toBe('cleared');
  store.redo(); expect(song().music).toEqual(music);
});

it('重放历史不把结果应用到不同音源，当前音源变化时明确拒绝', () => {
  const command = background();
  const changed = initial(); changed.rundown[0]!.referenceAudio = { ...source, sha256: 'b'.repeat(64) };
  expect(command.rebaseHistory!(changed)).toBe(changed);
  expect(() => command.execute(changed)).toThrow('音源或节目已改变');
  expect(() => setSongMusicCommand('song', { ...source, durationMs: 20000 }, music, { label: '识别' })).toThrow('音源或裁剪已改变');
  const empty = createEmptyLinkProject('没有歌曲');
  expect(command.rebaseHistory!(empty)).toBe(empty);
});

it('第一次识别普通工程时工程升到 3，不创建灯光文档', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('普通工程'), rundown: [{ id: 'song', title: '歌曲', referenceAudio: source }] });
  const result = background(clearedSongMusic(source, 'dismissed')).execute(project);
  expect(result.schemaVersion).toBe(3);
  expect(parseLinkProject(result).rundown[0]!.music?.structure.state).toBe('cleared');
  expect(result.rundown[0]!.lighting).toBeUndefined();
  expect(project.rundown[0]!.music).toBeUndefined();
});
