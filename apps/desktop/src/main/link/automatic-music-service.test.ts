import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { AutomaticMusicJob, AutomaticMusicRequest, AutomaticMusicRun } from '@tb/schema';
import { AutomaticMusicService } from './automatic-music-service';

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.clearAllMocks());
function request(hash = 'a'): AutomaticMusicRequest {
  return { version: 1, taskId: randomUUID(), device: 'cpu', projectPath: resolve('演出.tblink'),
    source: { assetId: 'source', relativePath: 'assets/实际播放.wav', sha256: hash.repeat(64), durationMs: 1000 } };
}
function result(input: AutomaticMusicRequest): AutomaticMusicRun {
  return { version: 1, run_id: randomUUID(), engine_fingerprint: 'f'.repeat(64), device: 'cpu',
    audio: { source_sha256: input.source.sha256, pcm_sha256: 'b'.repeat(64), sample_rate: 48000, sample_count: 48000, channels: 2 },
    timings: { total_seconds: 1, decode_seconds: .1, cached: false, engine_seconds: {} }, diagnostics: { 'silence-guard': { beats: [], downbeats: [], sections: [], events: [] } }, publication: 'not-validated', enabled_capabilities: [] };
}
function deferred() {
  let finish: (value: AutomaticMusicRun) => void = () => { throw new Error('尚未初始化'); };
  let fail: (error: Error) => void = () => { throw new Error('尚未初始化'); };
  const promise = new Promise<AutomaticMusicRun>((resolveRun, reject) => { finish = resolveRun; fail = reject; });
  return { promise, finish, fail };
}
function fixture() {
  const run = vi.fn<(input: unknown) => Promise<AutomaticMusicRun>>();
  const cancel = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined);
  const changed: AutomaticMusicJob[] = [];
  const resolveReferenceAudio = vi.fn(() => resolve('实际播放.wav'));
  const service = new AutomaticMusicService({ resolveReferenceAudio }, { run, cancel },
    { root: resolve('analysis-jobs'), bundle: resolve('models'), ffmpeg: resolve('ffmpeg.exe') }, status => changed.push(status));
  return { service, run, cancel, changed, resolveReferenceAudio };
}

it('顺序处理且重复音源去重，研究结果保持零工程标记', async () => {
  const { service, run } = fixture(); const first = request(); const second = request('b'); const task = deferred();
  run.mockReturnValueOnce(task.promise).mockResolvedValueOnce(result(second));
  service.enqueue(first); service.enqueue(second);
  expect(service.enqueue({ ...first, taskId: randomUUID() }).taskId).toBe(first.taskId);
  await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(service.list()[1]?.state).toBe('queued');
  task.finish(result(first));
  await vi.waitFor(() => expect(service.list().every(job => job.state === 'completed')).toBe(true));
  expect(run).toHaveBeenCalledTimes(2);
  expect(service.list()[0]?.summary).toMatchObject({ publication: 'not-validated', visibleResults: 0 });
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ audio: resolve('实际播放.wav'), source_sha256: first.source.sha256 }), 240000);
});

it('完整模型结果交付实际候选及数量，长度不符明确失败而非空白结果', async () => {
  const { service, run, changed } = fixture(); const input = request();
  const labels = { beats: [0, .5], downbeats: [0], sections: [], events: [] };
  const prediction = { ...result(input), diagnostics: { 'beat-this-final0': labels, 'beat-this-final1': labels, 'beat-this-final2': labels, 'all-in-one': { ...labels, sections: [{ start: 0, end: 1, label: 'intro' }] } } };
  run.mockResolvedValue(prediction); service.enqueue(input);
  await vi.waitFor(() => expect(service.list()[0]?.state).toBe('completed'));
  expect(service.list()[0]?.candidates?.items).toHaveLength(4);
  expect(changed.at(-1)?.summary?.visibleResults).toBe(4);
  expect(changed.at(-1)?.candidates?.bpm).toBe(120);
  service.enqueue({ ...input, taskId: randomUUID(), source: { ...input.source, durationMs: 2000 } });
  await vi.waitFor(() => expect(service.list()[1]?.state).toBe('failed'));
  expect(service.list()[1]?.message).toContain('音源长度变了');
});

it('排队取消不启动进程；活动任务取消后迟到结果不得交付', async () => {
  const { service, run, cancel } = fixture(); const first = request(); const second = request('b'); const task = deferred();
  run.mockReturnValue(task.promise); service.enqueue(first); service.enqueue(second);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await service.cancel(second.taskId); await service.cancel(first.taskId);
  task.finish(result(first));
  await vi.waitFor(() => expect(service.list().every(job => job.state === 'cancelled')).toBe(true));
  expect(run).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledExactlyOnceWith(first.taskId);
  expect(service.list().every(job => job.summary === null)).toBe(true);
});

it('相同音源在不同工程中保留独立任务身份，不合并取消控制', async () => {
  const { service, run, cancel } = fixture(); const first = request();
  const second = { ...first, taskId: randomUUID(), projectPath: resolve('另一工程.tblink') };
  const task = deferred(); run.mockReturnValue(task.promise);
  service.enqueue(first); service.enqueue(second);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(service.list().map(job => job.projectPath)).toEqual([first.projectPath, second.projectPath]);
  await service.cancel(second.taskId);
  expect(service.list().map(job => job.state)).toEqual(['checking', 'cancelled']);
  expect(cancel).not.toHaveBeenCalled();
  task.finish(result(first));
  await vi.waitFor(() => expect(service.list()[0]?.state).toBe('completed'));
});

it('长歌按照音源时长获得计算时间，不沿用四分钟整曲截止', async () => {
  const { service, run } = fixture(); const input = request();
  input.source.durationMs = 300000;
  run.mockRejectedValue(new Error('test')); service.enqueue(input);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ source_sha256: input.source.sha256 }), 2460000);
});

it('准备期间取消不会启动重任务，失败明确返回且不自动重试', async () => {
  const { service, run } = fixture(); const first = request(); service.enqueue(first); await service.cancel(first.taskId);
  await vi.waitFor(() => expect(service.list()[0]?.state).toBe('cancelled')); expect(run).not.toHaveBeenCalled();
  run.mockRejectedValue(new Error('模型摘要不符'));
  service.enqueue(request('b'));
  await vi.waitFor(() => expect(service.list()[1]?.state).toBe('failed'));
  expect(service.list()[1]?.message).toBe('模型摘要不符'); expect(run).toHaveBeenCalledOnce();
});

it('只接受活动任务进度，取消后阶段消息不复活状态；关闭不再接单', async () => {
  const { service, run } = fixture(); const input = request(); const task = deferred(); run.mockReturnValue(task.promise); service.enqueue(input);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  service.progress({ version: 1, taskId: randomUUID(), type: 'progress', stage: 'beat-this-final0' }); expect(service.list()[0]?.state).toBe('checking');
  service.progress({ version: 1, taskId: input.taskId, type: 'progress', stage: 'beat-this-final0' }); expect(service.list()[0]?.message).toContain('1/3');
  const closing = service.close(); service.progress({ version: 1, taskId: input.taskId, type: 'progress', stage: 'beat-this-final1' });
  expect(service.list()[0]?.state).toBe('cancelling');
  expect(() => service.enqueue(request())).toThrow('关闭');
  task.fail(new Error('已取消')); await closing; expect(service.list()[0]?.state).toBe('cancelled');
});
