import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutomaticMusicProcess, type AutomaticMusicWorkerRequest } from './automatic-music-process';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), writeFile: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile }));

const taskId = '702ac98c-d085-4b16-942c-997a5d4271a9';
const sourceHash = 'b'.repeat(64);
const request: AutomaticMusicWorkerRequest = {
  version: 1, task_id: taskId, audio: resolve('song.wav'), source_sha256: sourceHash,
  bundle: resolve('models'), ffmpeg: resolve('ffmpeg.exe'), output: resolve('job'),
  cache: resolve('cache'), cancel_file: resolve('cancel.signal'), device: 'cpu'
};
function result() {
  return { version: 1, run_id: taskId, engine_fingerprint: 'a'.repeat(64), device: 'cpu',
    audio: { source_sha256: sourceHash, pcm_sha256: 'c'.repeat(64), sample_rate: 48000, sample_count: 480000, channels: 2 },
    timings: { total_seconds: 1, decode_seconds: .1, engine_seconds: {}, cached: false },
    diagnostics: { 'silence-guard': { beats: [], downbeats: [], sections: [], events: [] } },
    publication: 'not-validated', enabled_capabilities: [] };
}
function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  mocks.spawn.mockReturnValue(child);
  const progress = vi.fn();
  const client = new AutomaticMusicProcess(resolve('python.exe'), resolve('worker.py'), progress, 5000);
  const send = (value: object): void => { child.stdout.write(`${JSON.stringify({ version: 1, taskId, ...value })}\n`); };
  return { child, progress, client, send };
}
beforeEach(() => { vi.clearAllMocks(); mocks.writeFile.mockResolvedValue(undefined); });
afterEach(() => vi.useRealTimers());

it('完整进程关闭后才交付，单任务运行且离线参数固定', async () => {
  const { client, child, progress, send } = fixture();
  const pending = client.run(request);
  await expect(client.run(request)).rejects.toThrow('已有');
  send({ type: 'progress', stage: 'verify-assets' }); send({ type: 'result', result: result() });
  expect(client.busy).toBe(true); expect(progress).toHaveBeenCalledOnce();
  child.emit('close', 0);
  expect((await pending).publication).toBe('not-validated'); expect(client.busy).toBe(false);
  expect(mocks.spawn).toHaveBeenCalledWith(resolve('python.exe'), ['-u', resolve('worker.py')], expect.anything());
  const options: unknown = mocks.spawn.mock.calls[0]?.[2];
  expect(options).toMatchObject({ windowsHide: true, env: { HF_HUB_OFFLINE: '1' } });
});

it('取消后迟到结果作废，旧任务取消不能影响当前进程', async () => {
  const { client, child, send, progress } = fixture();
  const pending = client.run(request); const failure = expect(pending).rejects.toThrow('取消');
  await client.cancel('another-task'); expect(mocks.writeFile).not.toHaveBeenCalled();
  await client.cancel(taskId);
  send({ type: 'progress', stage: 'decode-48000-stereo' }); send({ type: 'result', result: result() });
  expect(progress).not.toHaveBeenCalled(); expect(client.busy).toBe(true);
  child.emit('close', 0); await failure;
  expect(mocks.writeFile).toHaveBeenCalledWith(request.cancel_file, 'cancel\n', { flag: 'w' });
});

it.each(['wrong-task', 'duplicate-result', 'garbage', 'wrong-source', 'failed-exit'] as const)('拒绝非法或不完整结果：%s', async kind => {
  const { client, child, send } = fixture(); const pending = client.run(request);
  const failure = expect(pending).rejects.toThrow();
  if (kind === 'wrong-task') send({ type: 'result', taskId: '00000000-0000-4000-8000-000000000001', result: result() });
  if (kind === 'duplicate-result') { send({ type: 'result', result: result() }); send({ type: 'result', result: result() }); }
  if (kind === 'garbage') child.stdout.write('第三方日志不能当成 JSON\n');
  if (kind === 'wrong-source') send({ type: 'result', result: { ...result(), audio: { ...result().audio, source_sha256: 'd'.repeat(64) } } });
  if (kind === 'failed-exit') send({ type: 'result', result: result() });
  child.emit('close', kind === 'failed-exit' ? 1 : 0); await failure;
});

it('UTF-8 跨块中文错误保留完整文本', async () => {
  const { client, child } = fixture(); const pending = client.run(request); const failure = expect(pending).rejects.toThrow('显存不足');
  const bytes = Buffer.from(JSON.stringify({ version: 1, taskId, type: 'error', message: '显存不足' }));
  for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
  child.emit('close', 1); await failure;
});

it('超时只协作取消自有任务，进程退出之前不启动第二个任务', async () => {
  vi.useFakeTimers();
  const { client, child, send } = fixture(); const pending = client.run(request); const failure = expect(pending).rejects.toThrow('超时');
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.writeFile).toHaveBeenCalledOnce(); expect(client.busy).toBe(true);
  await expect(client.run(request)).rejects.toThrow('已有');
  send({ type: 'result', result: result() }); child.emit('close', 0); await failure;
  expect(mocks.spawn).toHaveBeenCalledOnce();
});

it('缺少解释器明确失败，不退回旧引擎', async () => {
  const { client, child } = fixture(); const pending = client.run(request); const failure = expect(pending).rejects.toThrow('ENOENT');
  child.emit('error', new Error('ENOENT')); child.emit('close', -1); await failure;
  expect(client.busy).toBe(false); expect(mocks.spawn).toHaveBeenCalledOnce();
});
