import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeDeviceQuery } from './native-device-query';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
afterEach(() => { vi.useRealTimers(); processMock.spawn.mockReset(); });

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(child);
  const query = new NativeDeviceQuery('test-engine.exe');
  const reply = (id: number, name: string) => JSON.stringify({ version: 1, requestId: id, ok: true,
    devices: { protocol: 4, audio: [], midiOutputs: [{ id: 0, name }] } }) + '\n';
  const close = async () => { const closing = query.close(); child.emit('close', 0); await closing; };
  return { child, query, reply, close };
}

it('进程复用但清单不复用；分段响应及并发请求分别对应当前设备', async () => {
  const f = fixture();
  const first = f.query.read(), second = f.query.read();
  const data = f.reply(1, '拔插前') + f.reply(2, '拔插后');
  f.child.stdout.write(data.slice(0, 20)); f.child.stdout.write(data.slice(20));
  expect((await first).midiOutputs[0]?.name).toBe('拔插前');
  expect((await second).midiOutputs[0]?.name).toBe('拔插后');
  const bytes: unknown = f.child.stdin.read();
  if (!Buffer.isBuffer(bytes)) throw new Error('未收到二进制设备查询');
  expect(bytes.length).toBe(16); expect(bytes.readUInt32LE(4)).toBe(1); expect(bytes.readUInt32LE(12)).toBe(2);
  expect(processMock.spawn).toHaveBeenCalledOnce();
  await f.close();
});

it('结果身份不符会拒绝在途查询，不把迟到结果或旧清单当作成功，也不自动重启', async () => {
  const f = fixture(), pending = f.query.read();
  const rejected = expect(pending).rejects.toThrow('不属于当前请求');
  f.child.stdout.write(f.reply(99, '错误设备')); await rejected;
  f.child.stdout.write(f.reply(1, '迟到设备'));
  await expect(f.query.read()).rejects.toThrow('不属于当前请求');
  expect(f.child.stdin.writableEnded).toBe(true); expect(processMock.spawn).toHaveBeenCalledOnce();
  await f.close();
});

it('超时停止查询，关闭不强杀拒绝退出的进程', async () => {
  const f = fixture();
  const pending = expect(f.query.read()).rejects.toThrow('超过 5 秒');
  await vi.advanceTimersByTimeAsync(5000); await pending;
  const close = expect(f.query.close()).rejects.toThrow('不强杀');
  await vi.advanceTimersByTimeAsync(5000); await close;
  expect(processMock.spawn).toHaveBeenCalledOnce();
});

it('关闭取消在途请求；重复关闭共享结果且异常退出不会冒充成功', async () => {
  const f = fixture();
  const pending = expect(f.query.read()).rejects.toThrow('已取消');
  const close = f.query.close(); expect(f.query.close()).toBe(close);
  const rejected = expect(close).rejects.toThrow('异常退出');
  f.child.emit('close', 3); await pending; await rejected;
});

it('队列和单条响应都有容量上限', async () => {
  const f = fixture();
  const pending = Array.from({ length: 8 }, () => expect(f.query.read()).rejects.toThrow('超过容量'));
  await expect(f.query.read()).rejects.toThrow('队列已满');
  f.child.stdout.write('x'.repeat(256 * 1024 + 1));
  await Promise.all(pending); await f.close();
});

it('失败后只有明确重新准备才允许新查询；旧进程退出前不另起进程', async () => {
  const f = fixture();
  const pending = expect(f.query.read()).rejects.toThrow('进程已退出');
  f.child.emit('close', 3); await pending;
  await expect(f.query.read()).rejects.toThrow('进程已退出');
  const next = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(next);
  await f.query.reopenForPreparation();
  expect(processMock.spawn).toHaveBeenCalledOnce();
  const current = f.query.read(); next.stdout.write(f.reply(2, '恢复设备'));
  expect((await current).midiOutputs[0]?.name).toBe('恢复设备');
  expect(processMock.spawn).toHaveBeenCalledTimes(2);
  const closing = f.query.close(); next.emit('close', 0); await closing;
});
