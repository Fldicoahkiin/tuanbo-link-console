import { expect, it } from 'vitest';
import type { AutomaticMusicJob } from '@tb/schema';
import { musicAnalysisOutcome } from './music-analysis-progress';

const job = (state: AutomaticMusicJob['state'], message: string): AutomaticMusicJob => ({ version: 1, taskId: crypto.randomUUID(), projectPath: 'C:/演出/show.tblink',
  sourceSha256: 'a'.repeat(64), revision: 3, state, device: 'cpu', message, stage: null, summary: null });

it('分析结束只弹一次提示：完成为普通提示，失败为错误；进行中和暂停不弹', () => {
  expect(musicAnalysisOutcome(job('completed', '音乐分析完成'), '开场曲')).toEqual({ message: '「开场曲」音乐分析完成', tone: 'info' });
  expect(musicAnalysisOutcome(job('completed', '没有识别到节拍或段落，请检查音源是不是静音'), null))
    .toEqual({ message: '音乐分析完成：没有识别到节拍或段落，请检查音源是不是静音', tone: 'info' });
  expect(musicAnalysisOutcome(job('failed', '解码失败'), '开场曲')).toEqual({ message: '「开场曲」音乐分析失败：解码失败', tone: 'error' });
  expect(musicAnalysisOutcome(job('cancelled', '已取消，结果没有保存'), null)).toEqual({ message: '音乐分析已取消，结果没有保存', tone: 'info' });
  for (const state of ['queued', 'checking', 'running', 'pausing', 'paused', 'cancelling'] as const) expect(musicAnalysisOutcome(job(state, '分析中'), null)).toBeNull();
});
