import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeMidiOutput } from './native-midi-output';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
afterEach(() => { vi.useRealTimers(); processMock.spawn.mockReset(); });

function fixture() {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(child);
  const errors: Error[] = [], output = new NativeMidiOutput('engine.exe', error => errors.push(error));
  const now = () => process.hrtime.bigint() / 100n;
  const reply = (requestId: number, code = 0, time = now()) => child.stdout.write(JSON.stringify({ version: 1, requestId, code, acceptedAt100ns: String(time) }) + '\n');
  const read = () => { const bytes: unknown = child.stdin.read(); if (!Buffer.isBuffer(bytes)) throw new Error('未收到指令'); return bytes; };
  const open = async () => { const pending = output.open('明确端口'); const bytes = read(); expect(bytes.subarray(24).toString()).toBe('明确端口'); reply(1, 0, 1n); await pending; };
  const close = async (code = 0) => { const pending = output.close(); child.emit('close', code); await pending; };
  return { child, output, errors, now, reply, read, open, close };
}

it('只允许一条在途；后续消息留在可取消队列，保留二进制消息和原始截止时间', async () => {
  const f = fixture(); await f.open();
  const deadline = f.now() + 1_000_000n;
  const first = f.output.send([0x90, 60, 100], deadline), second = f.output.send([0xf0, 0x7f, 1, 2, 1, 1, 0xf7], deadline);
  const packet = f.read(); expect(packet.subarray(0, 4).toString()).toBe('TBM1');
  expect(packet.readUInt32LE(4)).toBe(2); expect(packet.readUInt32LE(8)).toBe(2);
  expect(packet.readBigUInt64LE(16)).toBe(deadline); expect([...packet.subarray(24)]).toEqual([0x90, 60, 100]);
  expect(f.child.stdin.read()).toBeNull();
  f.reply(2, 0, 1n); expect((await first).acceptedAt100ns).toBe(1n);
  expect(f.read().readUInt32LE(4)).toBe(3); f.reply(3, 0, 1n); await second;
  expect(f.errors).toEqual([]); await f.close();
});

it('停止取消所有未发送动作；迟到确认不复活队列、不假称在途未发送', async () => {
  const f = fixture(); await f.open();
  const pending = [f.output.send([0x90, 60, 100], f.now() + 1_000_000n), f.output.send([0x90, 61, 100], f.now() + 1_000_000n)]
    .map(promise => expect(promise).rejects.toThrow('在途指令可能已发送'));
  f.read(); const closing = f.output.close(); expect(f.output.close()).toBe(closing);
  f.reply(2, 0, 1n); expect(f.child.stdin.read()).toBeNull(); expect(f.child.stdin.writableEnded).toBe(true);
  await Promise.all(pending); f.child.emit('close', 0); await closing;
  await expect(f.output.send([0x90, 62, 100], f.now() + 1_000_000n)).rejects.toThrow('已取消');
  expect(processMock.spawn).toHaveBeenCalledOnce();
});

it('准备超时立即停止参与，迟到的端口准备结果不能在歌曲中途启用', async () => {
  const f = fixture(), pending = expect(f.output.open('明确端口')).rejects.toThrow('超过 2 秒');
  await vi.advanceTimersByTimeAsync(2000); await pending; f.reply(1, 0, 1n);
  await expect(f.output.send([0x90, 60, 100], f.now() + 1_000_000n)).rejects.toThrow('超过 2 秒');
  expect(f.errors).toHaveLength(1); await f.close();
});

it('动作确认超时属于结果不明，不重发、不发送排队的旧 Cue', async () => {
  const f = fixture(); await f.open();
  const pending = [f.output.send([0x90, 60, 100], f.now() + 1_000_000n), f.output.send([0x80, 60, 0], f.now() + 1_000_000n)]
    .map(promise => expect(promise).rejects.toThrow('在途结果不明'));
  f.read(); await vi.advanceTimersByTimeAsync(100); await Promise.all(pending);
  f.reply(2, 0, 1n); expect(f.child.stdin.read()).toBeNull(); expect(f.errors).toHaveLength(1);
  const closing = expect(f.output.close()).rejects.toThrow('保留进程');
  await vi.advanceTimersByTimeAsync(5000); await closing;
});

it('驱动确认时间、请求身份、消息格式均校验；不能伪造当前输出成功', async () => {
  const f = fixture(); await f.open();
  await expect(f.output.send([0x90, 60, 100, 0x80, 60, 0], f.now() + 1_000_000n)).rejects.toThrow('完整单条消息');
  await expect(f.output.send([0xf0, 0xff, 0xf7], f.now() + 1_000_000n)).rejects.toThrow('完整单条消息');
  await expect(f.output.send([0x90, 60, 100], f.now() - 1n)).rejects.toThrow('过期');
  expect(f.child.stdin.read()).toBeNull();
  const pending = expect(f.output.send([0x90, 60, 100], f.now() + 1_000_000n)).rejects.toThrow('不属于当前请求');
  f.reply(99, 0, 1n); await pending; await f.close();
});

it('Windows 原生拒绝发送时保留具体原因，错误退出不能当作正常关闭', async () => {
  const f = fixture(), pending = expect(f.output.open('明确端口')).rejects.toThrow('指定输出端口不存在');
  f.reply(1, -2, 0n); await pending;
  const closing = expect(f.output.close()).rejects.toThrow('异常退出'); f.child.emit('close', 3); await closing;
  await expect(f.output.open('明确端口')).rejects.toThrow('必须明确准备新会话');
});

it('响应和队列均有容量限制', async () => {
  const f = fixture(); await f.open();
  const pending = Array.from({ length: 33 }, () => expect(f.output.send([0xc0, 1], f.now() + 1_000_000n)).rejects.toThrow('超过容量'));
  await expect(f.output.send([0xc0, 2], f.now() + 1_000_000n)).rejects.toThrow('队列已满');
  f.child.stdout.write('x'.repeat(4097)); await Promise.all(pending); await f.close();
});
