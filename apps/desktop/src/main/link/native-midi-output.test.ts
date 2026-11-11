import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { MidiMessageSkipped } from '@tb/core/link';
import { MidiOutputFailure, NativeMidiOutput } from './native-midi-output';

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
    .map(promise => expect(promise).rejects.toThrow('正在发的消息可能已经发出'));
  f.read(); const closing = f.output.close(); expect(f.output.close()).toBe(closing);
  f.reply(2, 0, 1n); expect(f.child.stdin.read()).toBeNull(); expect(f.child.stdin.writableEnded).toBe(true);
  await Promise.all(pending); f.child.emit('close', 0); await closing;
  await expect(f.output.send([0x90, 62, 100], f.now() + 1_000_000n)).rejects.toThrow('已取消');
  expect(processMock.spawn).toHaveBeenCalledOnce();
});

it('准备超时立即停止参与，迟到的端口准备结果不能在歌曲中途启用', async () => {
  const f = fixture(), pending = expect(f.output.open('明确端口')).rejects.toThrow('2 秒内没有准备好');
  await vi.advanceTimersByTimeAsync(2000); await pending; f.reply(1, 0, 1n);
  await expect(f.output.send([0x90, 60, 100], f.now() + 1_000_000n)).rejects.toThrow('2 秒内没有准备好');
  expect(f.errors).toHaveLength(1); await f.close();
});

it('动作确认超时属于结果不明，不重发、不发送排队的旧 Cue', async () => {
  const f = fixture(); await f.open();
  // 2026-11-10 第 6 题：排队的那一条到截止时间只丢它自己；在途的那一条再等 1 秒回应（原生会自己回 -7、-6），没回应才停整路。
  const pending = [expect(f.output.send([0x90, 60, 100], f.now() + 1_000_000n)).rejects.toThrow('无法确定是否已发出'),
    expect(f.output.send([0x80, 60, 0], f.now() + 1_000_000n)).rejects.toThrow('等着发送时过了时间')];
  f.read(); await vi.advanceTimersByTimeAsync(100); expect(f.errors).toEqual([]);
  await vi.advanceTimersByTimeAsync(1000); await Promise.all(pending);
  f.reply(2, 0, 1n); expect(f.child.stdin.read()).toBeNull(); expect(f.errors).toHaveLength(1);
  const closing = expect(f.output.close()).rejects.toThrow('进程保留');
  await vi.advanceTimersByTimeAsync(5000); await closing;
});

it('驱动确认时间、请求身份、消息格式均校验；不能伪造当前输出成功', async () => {
  const f = fixture(); await f.open();
  await expect(f.output.send([0x90, 60, 100, 0x80, 60, 0], f.now() + 1_000_000n)).rejects.toThrow('完整单条消息');
  await expect(f.output.send([0xf0, 0xff, 0xf7], f.now() + 1_000_000n)).rejects.toThrow('完整单条消息');
  await expect(f.output.send([0x90, 60, 100], f.now() - 1n)).rejects.toThrow('过了发送时间');
  expect(f.child.stdin.read()).toBeNull();
  const pending = expect(f.output.send([0x90, 60, 100], f.now() + 1_000_000n)).rejects.toThrow('不属于当前请求');
  f.reply(99, 0, 1n); await pending; await f.close();
});

it('Windows 原生拒绝发送时保留具体原因，错误退出不能当作正常关闭', async () => {
  const f = fixture(), pending = expect(f.output.open('明确端口')).rejects.toThrow('找不到指定的输出端口');
  f.reply(1, -2, 0n); await pending;
  const closing = expect(f.output.close()).rejects.toThrow('异常退出'); f.child.emit('close', 3); await closing;
  await expect(f.output.open('明确端口')).rejects.toThrow('必须明确准备新会话');
});

// 2026-11-10 第 6 题：排队上限从 32 改成 256，满了只拒绝这一条（MidiMessageSkipped），不停整路。
it('响应和队列均有容量限制；排队满了只拒绝这一条', async () => {
  const f = fixture(); await f.open();
  const pending = Array.from({ length: 257 }, () => expect(f.output.send([0xc0, 1], f.now() + 1_000_000n)).rejects.toThrow('超过容量'));
  const full = f.output.send([0xc0, 2], f.now() + 1_000_000n);
  await expect(full).rejects.toThrow('动作太多'); await expect(full).rejects.toBeInstanceOf(MidiMessageSkipped);
  expect(f.errors).toEqual([]);
  f.child.stdout.write('x'.repeat(4097)); await Promise.all(pending); await f.close();
});

it('-7、-6、-1 只拒绝这一条，下一条照发，接口不停', async () => {
  const f = fixture(); await f.open();
  const deadline = () => f.now() + 1_000_000n;
  const messages = [-7, -6, -1].map(() => f.output.send([0xc0, 1], deadline())), next = f.output.send([0xc0, 2], deadline());
  for (const [index, code] of [-7, -6, -1].entries()) { expect(f.read().readUInt32LE(4)).toBe(2 + index); f.reply(2 + index, code, 0n); }
  for (const [index, code] of [-7, -6, -1].entries()) {
    const refused = await messages[index]!.then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(MidiMessageSkipped); expect(refused).toMatchObject({ code });
  }
  expect(f.read().readUInt32LE(4)).toBe(5); f.reply(5, 0, 1n); expect((await next).acceptedAt100ns).toBe(1n);
  expect(f.errors).toEqual([]); await f.close();
});

it('连续 3 条 -6（SysEx 一直发不完）判为驱动卡住，整路停；中间发成一条就重新数', async () => {
  const f = fixture(); await f.open();
  const sysex = [0xf0, 0x7f, 1, 2, 1, 1, 0xf7], deadline = () => f.now() + 1_000_000n;
  const codes = [-6, -6, 0, -6, -6, -6], sends = codes.map(() => f.output.send(sysex, deadline()));
  const settled = sends.map(send => send.then(() => 'sent', (error: unknown) => error));
  for (const [index, code] of codes.entries()) { f.read(); f.reply(2 + index, code, code ? 0n : 1n); }
  const results = await Promise.all(settled);
  expect(results.slice(0, 2).every(result => result instanceof MidiMessageSkipped)).toBe(true); expect(results[2]).toBe('sent');
  expect(results.slice(3, 5).every(result => result instanceof MidiMessageSkipped)).toBe(true);
  expect(results[5]).toBeInstanceOf(MidiOutputFailure); expect(f.errors).toHaveLength(1); expect(f.errors[0]?.message).toContain('驱动可能卡住了');
  await expect(f.output.send(sysex, deadline())).rejects.toThrow('驱动可能卡住了'); await f.close();
});

it('接口断开（5、6）、驱动没响应（-4）算整路，报 MidiOutputFailure 交给端口恢复', async () => {
  for (const code of [5, 6, -4]) {
    const f = fixture(); await f.open();
    const sending = f.output.send([0xc0, 1], f.now() + 1_000_000n).then(() => null, (error: unknown) => error);
    f.read(); f.reply(2, code, 0n);
    const error = await sending;
    expect(error).toBeInstanceOf(MidiOutputFailure); expect((error as MidiOutputFailure).portGone).toBe(code !== -4);
    expect(f.errors).toHaveLength(1); await f.close();
    processMock.spawn.mockReset();
  }
});

it('排队时过了截止时间只丢这一条，后面的照发；驱动确认晚了只算这一条，可能已经发出', async () => {
  const f = fixture(); await f.open();
  const first = f.output.send([0xc0, 1], f.now() + 1_000_000n);
  const soon = expect(f.output.send([0xc0, 2], f.now() + 50_000n)).rejects.toBeInstanceOf(MidiMessageSkipped), after = f.output.send([0xc0, 3], f.now() + 1_000_000n);
  f.read(); await vi.advanceTimersByTimeAsync(5);
  await soon; f.reply(2, 0, f.now()); await first;
  const packet = f.read(); expect([...packet.subarray(24)]).toEqual([0xc0, 3]); f.reply(packet.readUInt32LE(4), 0, f.now()); await after;
  const edge = f.now() + 5_000n, confirmedLate = f.output.send([0xc0, 4], edge).then(() => null, (error: unknown) => error);
  f.reply(f.read().readUInt32LE(4), 0, edge);
  expect(await confirmedLate).toMatchObject({ possiblySent: true }); expect(f.errors).toEqual([]);
  const last = f.output.send([0xc0, 5], f.now() + 1_000_000n); f.reply(f.read().readUInt32LE(4), 0, f.now()); await last;
  await f.close();
});

it('已发出的动作到截止时间还没回应：再等 1 秒，回来的 -7 只算这一条', async () => {
  const f = fixture(); await f.open();
  const sending = f.output.send([0xc0, 1], f.now() + 10_000n).then(() => null, (error: unknown) => error);
  f.read(); await vi.advanceTimersByTimeAsync(500); f.reply(2, -7, 0n);
  expect(await sending).toBeInstanceOf(MidiMessageSkipped); expect(f.errors).toEqual([]);
  const next = f.output.send([0xc0, 2], f.now() + 1_000_000n); f.reply(f.read().readUInt32LE(4), 0, f.now()); await next;
  await f.close();
});
