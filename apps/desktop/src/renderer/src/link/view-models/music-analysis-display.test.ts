import { expect, it } from 'vitest';
import { automaticMusicJobSchema } from '@tb/schema';
import { recognizeMusicStructure } from '@tb/core/link';
import { musicAnalysisHeading, musicAnalysisShortHeading } from './music-analysis-display';

it('编辑器工具栏用短的写法：速度写成 “120 BPM”，状态照旧', () => {
  const job = automaticMusicJobSchema.parse({ version: 1, taskId: crypto.randomUUID(), projectPath: 'x', sourceSha256: 'a'.repeat(64), revision: 1, state: 'completed', device: 'cpu', message: '', stage: null, summary: null });
  const data = recognizeMusicStructure({ sourceSha256: 'a'.repeat(64), durationMs: 10000, bpm: null, items: [] }, job.taskId);
  const segment = { id: 's', name: '第 1 段', startMs: 0, endMs: 10000, bpm: 120 as number | null, endBpm: null as number | null, reason: 'tempo' as const, edited: false };
  expect(musicAnalysisShortHeading(data, segment, job, false, null)).toBe('120 BPM');
  expect(musicAnalysisShortHeading(data, { ...segment, endBpm: 124 }, job, false, null)).toBe('120→124');
  expect(musicAnalysisShortHeading(data, { ...segment, bpm: null }, job, false, null)).toBe('无 BPM');
  expect(musicAnalysisShortHeading(undefined, undefined, null, false, null)).toBe('还没分析');
  expect(musicAnalysisShortHeading(undefined, undefined, { ...job, state: 'running' }, false, null)).toBe('正在识别');
});

it('distinguishes running, failed and cancelled jobs from completed uncertain tempo', () => {
  const job = automaticMusicJobSchema.parse({ version: 1, taskId: crypto.randomUUID(), projectPath: 'x', sourceSha256: 'a'.repeat(64), revision: 1, state: 'running', device: 'cpu', message: '节拍 1/3', stage: 'beat-this-final0', summary: null });
  expect(musicAnalysisHeading(undefined, undefined, job, false, null)).toBe('正在识别');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'failed' }, false, null)).toBe('识别失败');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'cancelled' }, false, null)).toBe('识别已取消');
  const data = recognizeMusicStructure({ sourceSha256: 'a'.repeat(64), durationMs: 10000, bpm: null, items: [] }, job.taskId);
  expect(musicAnalysisHeading(data, undefined, { ...job, state: 'completed' }, false, null)).toBe('无可测 BPM');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'completed' }, false, null)).toBe('分析已完成');
});
