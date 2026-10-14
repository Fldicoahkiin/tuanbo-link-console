import { beforeEach, expect, it } from 'vitest';
import { editMusicStructure, recognizeMusicStructure, renameProjectCommand, setAutomaticMusicAnalysisCommand, setLightingCommand } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject } from '@tb/schema';
import { useDocumentStore } from './document-store';

const source = { assetId: 'audio', relativePath: 'music.wav', sha256: 'a'.repeat(64), durationMs: 10000 };
const analysis = recognizeMusicStructure({ sourceSha256: source.sha256, durationMs: source.durationMs, bpm: null, items: [] }, 'background-task');
const initial = () => parseLinkProject({ ...createEmptyLinkProject('初始'), schemaVersion: 2,
  rundown: [{ id: 'song', title: '歌曲', referenceAudio: source, lighting: createLightingDocument() }] });
const current = () => useDocumentStore.getState().project!;
const lighting = () => current().rundown[0]!.lighting!;

beforeEach(() => useDocumentStore.getState().setProject(initial(), null));

it('撤销后迟到的自动分析保留重做，之后反复撤销重做仍保留识别结果', () => {
  const store = useDocumentStore.getState();
  store.execute(renameProjectCommand('第一次修改'));
  store.execute(renameProjectCommand('第二次修改'));
  store.undo();
  const tracks = lighting().tracks;
  store.execute(setAutomaticMusicAnalysisCommand('song', source, analysis));
  expect(useDocumentStore.getState().past).toHaveLength(1);
  expect(useDocumentStore.getState().future).toHaveLength(1);
  expect(lighting().tracks).toEqual(tracks);
  expect(lighting().musicAnalysis).toEqual(analysis);
  store.redo(); expect(current().name).toBe('第二次修改');
  store.undo(); store.undo(); expect(current().name).toBe('初始');
  expect(lighting().musicAnalysis).toEqual(analysis);
  store.redo(); store.redo(); expect(current().name).toBe('第二次修改');
  expect(lighting().musicAnalysis).toEqual(analysis);
  expect(() => parseLinkProject(current())).not.toThrow();
});

it('手动清除与重新分析仍可撤销，迟到结果不覆盖已确认的分析状态', () => {
  const store = useDocumentStore.getState();
  store.execute(setAutomaticMusicAnalysisCommand('song', source, analysis));
  store.execute(setLightingCommand('song', editMusicStructure(lighting(), { kind: 'clear' }), '清除识别'));
  store.execute(setAutomaticMusicAnalysisCommand('song', source, { ...analysis, taskId: 'late-task' }));
  expect(lighting().musicAnalysis?.state).toBe('cleared');
  store.undo(); expect(lighting().musicAnalysis).toEqual(analysis);
  store.redo(); expect(lighting().musicAnalysis?.state).toBe('cleared');
  store.execute(setLightingCommand('song', { ...lighting(), musicAnalysis: analysis }, '重新分析'));
  store.undo(); expect(lighting().musicAnalysis?.state).toBe('cleared');
  store.redo(); expect(lighting().musicAnalysis).toEqual(analysis);
});

it('重放历史不把结果应用到不同音源，当前音源变化时明确拒绝', () => {
  const command = setAutomaticMusicAnalysisCommand('song', source, analysis);
  const changed = initial(); changed.rundown[0]!.referenceAudio = { ...source, sha256: 'b'.repeat(64) };
  expect(command.rebaseHistory!(changed)).toBe(changed);
  expect(() => command.execute(changed)).toThrow('音源或节目已改变');
  expect(() => setAutomaticMusicAnalysisCommand('song', { ...source, durationMs: 20000 }, analysis)).toThrow('音源或裁剪已改变');
  const empty = createEmptyLinkProject('没有歌曲');
  expect(command.rebaseHistory!(empty)).toBe(empty);
});

it('首次分析普通工程时升级 schema 并创建有效灯光文档', () => {
  const project = parseLinkProject({ ...createEmptyLinkProject('普通工程'), rundown: [{ id: 'song', title: '歌曲', referenceAudio: source }] });
  const result = setAutomaticMusicAnalysisCommand('song', source, analysis).execute(project);
  expect(result.schemaVersion).toBe(2);
  expect(parseLinkProject(result).rundown[0]!.lighting?.musicAnalysis).toEqual(analysis);
  expect(project.rundown[0]!.lighting).toBeUndefined();
});
