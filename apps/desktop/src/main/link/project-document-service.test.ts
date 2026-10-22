import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectDocumentService } from './project-document-service';

const workers = vi.hoisted(() => ({ instances: [] as EventEmitter[], post: vi.fn(), ref: vi.fn(), unref: vi.fn(), terminate: vi.fn() }));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  return { Worker: class extends Emitter {
    constructor() { super(); workers.instances.push(this); }
    postMessage = workers.post;
    ref = workers.ref;
    unref = workers.unref;
    terminate = workers.terminate;
  } };
});
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); workers.post.mockReset(); workers.instances.length = 0; });
afterEach(() => { vi.useRealTimers(); });
const path = 'C:/shows/test.tblink';
const response = (value: unknown) => workers.instances[0]!.emit('message', value);

it('单次写盘失败不会确认保存，之后显式请求仍可处理且不会自动重发', async () => {
  const service = new ProjectDocumentService();
  const failed = expect(service.save(path, '{}')).rejects.toThrow('磁盘已满');
  response({ version: 1, id: 1, kind: 'error', error: '磁盘已满' });
  await failed;
  expect(workers.post).toHaveBeenCalledTimes(1);
  const read = service.read(path);
  response({ version: 1, id: 2, kind: 'opened', content: '{"name":"原工程"}', upgraded: false });
  await expect(read).resolves.toContain('原工程');
  expect(workers.unref).toHaveBeenCalledTimes(2);
});

it('保存超时后结果保持不明，不杀正在写盘的线程，不接受迟到结果或自动重试', async () => {
  const service = new ProjectDocumentService();
  const pending = Promise.allSettled([service.save(path, '{}'), service.read(path)]);
  await vi.advanceTimersByTimeAsync(30000);
  expect((await pending).map(result => result.status)).toEqual(['rejected', 'rejected']);
  response({ version: 1, id: 1, kind: 'saved' });
  await expect(service.save(path, '{}')).rejects.toThrow('可能已写入');
  expect(workers.terminate).not.toHaveBeenCalled();
  expect(workers.post).toHaveBeenCalledTimes(2);
  expect(workers.instances).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['exit', 'error', 'wrong-result', 'unknown-id', 'invalid-dto', 'send-error'])('线程异常 %s 明确拒绝所有在途请求且不重建线程', async failure => {
  const service = new ProjectDocumentService();
  const pending = Promise.allSettled([service.save(path, '{}'), service.read(path)]);
  const worker = workers.instances[0]!;
  if (failure === 'exit') worker.emit('exit', 1);
  else if (failure === 'error') worker.emit('error', new Error('线程崩溃'));
  else if (failure === 'wrong-result') response({ version: 1, id: 1, kind: 'opened', content: '{}', upgraded: false });
  else if (failure === 'unknown-id') response({ version: 1, id: 999, kind: 'saved' });
  else if (failure === 'invalid-dto') response({ version: 99, id: 1, kind: 'saved' });
  else {
    workers.post.mockImplementationOnce(() => { throw new Error('发送失败'); });
    await expect(service.inspect('{}')).rejects.toThrow('发送失败');
  }
  expect((await pending).every(result => result.status === 'rejected')).toBe(true);
  await expect(service.read(path)).rejects.toBeInstanceOf(Error);
  expect(workers.instances).toHaveLength(1);
  expect(workers.unref).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('队列有界，超量请求不发送且不会取消已经在途的保存', async () => {
  const service = new ProjectDocumentService();
  const pending = Array.from({ length: 64 }, () => service.save(path, '{}'));
  await expect(service.save(path, '{}')).rejects.toThrow('未入队');
  expect(workers.post).toHaveBeenCalledTimes(64);
  for (let id = 1; id <= 64; id++) response({ version: 1, id, kind: 'saved' });
  await Promise.all(pending);
  expect(vi.getTimerCount()).toBe(0);
});
