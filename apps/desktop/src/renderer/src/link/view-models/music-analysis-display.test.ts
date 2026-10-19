import { expect, it } from 'vitest';
import { automaticMusicJobSchema } from '@tb/schema';
import { recognizeMusicStructure } from '@tb/core/link';
import { musicAnalysisHeading } from './music-analysis-display';

it('distinguishes running, failed and cancelled jobs from completed uncertain tempo', () => {
  const job = automaticMusicJobSchema.parse({ version: 1, taskId: crypto.randomUUID(), projectPath: 'x', sourceSha256: 'a'.repeat(64), revision: 1, state: 'running', device: 'cpu', message: '节拍 1/3', stage: 'beat-this-final0', summary: null });
  expect(musicAnalysisHeading(undefined, undefined, job, false, null)).toBe('正在识别');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'failed' }, false, null)).toBe('识别失败');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'cancelled' }, false, null)).toBe('识别已取消');
  const data = recognizeMusicStructure({ sourceSha256: 'a'.repeat(64), durationMs: 10000, bpm: null, items: [] }, job.taskId);
  expect(musicAnalysisHeading(data, undefined, { ...job, state: 'completed' }, false, null)).toBe('无可测 BPM');
  expect(musicAnalysisHeading(undefined, undefined, { ...job, state: 'completed' }, false, null)).toBe('分析已完成');
});
