import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeMidiInput, type NativeMidiMessage } from './native-midi-input';

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: processMock.spawn }));
afterEach(() => { processMock.spawn.mockReset(); });

function fixture(withIdle = true) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  processMock.spawn.mockReturnValue(child);
  const messages: NativeMidiMessage[] = [], errors: Error[] = [], invalid: number[] = [], idle: bigint[] = [];
  const input = withIdle
    ? new NativeMidiInput('engine.exe', message => messages.push(message), error => errors.push(error), count => invalid.push(count), at => idle.push(at))
    : new NativeMidiInput('engine.exe', message => messages.push(message), error => errors.push(error), count => invalid.push(count));
  // The class reads stdout synchronously from the data event, so emitting is enough.
  const line = (value: object) => child.stdout.emit('data', JSON.stringify(value) + '\n');
  const open = async () => { const pending = input.open('明确端口'); line({ version: 1, kind: 'opened', requestId: 1, code: 0 }); await pending; };
  const close = async () => { const pending = input.close(); child.emit('close', 0); await pending; };
  return { child, input, messages, errors, invalid, idle, line, open, close };
}

it('心跳交给 receiveIdle，不改变消息和无效计数的回调', async () => {
  const f = fixture(); await f.open();
  f.line({ version: 1, kind: 'message', bytes: [0xf1, 0x10], at100ns: '1000000' });
  f.line({ version: 1, kind: 'idle', at100ns: '2000000' });
  f.line({ version: 1, kind: 'idle', at100ns: '3000000' });
  f.line({ version: 1, kind: 'invalid', count: 2 });
  expect(f.messages).toEqual([{ bytes: [0xf1, 0x10], at100ns: 1000000n }]);
  expect(f.idle).toEqual([2000000n, 3000000n]);
  expect(f.invalid).toEqual([2]); expect(f.errors).toEqual([]);
  await f.close();
});

it('没有心跳回调的调用方看不到心跳；不发心跳的输入照常工作', async () => {
  const f = fixture(false); await f.open();
  f.line({ version: 1, kind: 'idle', at100ns: '2000000' });
  f.line({ version: 1, kind: 'message', bytes: [0xf1, 0x20], at100ns: '1500000' });
  f.line({ version: 1, kind: 'message', bytes: [0xf1, 0x30], at100ns: '2500000' });
  expect(f.messages.map(message => message.at100ns)).toEqual([1500000n, 2500000n]);
  expect(f.errors).toEqual([]); await f.close();
});

it('心跳的接口时间倒退就停止这个输入，不悄悄跳过', async () => {
  const f = fixture(); await f.open();
  f.line({ version: 1, kind: 'idle', at100ns: '3000000' });
  f.line({ version: 1, kind: 'idle', at100ns: '3000000' });
  f.line({ version: 1, kind: 'idle', at100ns: '2999999' });
  f.line({ version: 1, kind: 'message', bytes: [0xf1, 0x10], at100ns: '4000000' });
  expect(f.idle).toEqual([3000000n, 3000000n]);
  expect(f.errors.map(error => error.message)).toEqual(['MIDI 输入的接口时间倒退']);
  expect(f.messages).toEqual([]); expect(f.child.stdin.writableEnded).toBe(true);
});

it('心跳格式严格校验，打开前送来的心跳是协议错误', async () => {
  const early = fixture(), pending = expect(early.input.open('明确端口')).rejects.toThrow('打开前');
  early.line({ version: 1, kind: 'idle', at100ns: '1' }); await pending;
  for (const bad of [{ version: 1, kind: 'idle', at100ns: 1 }, { version: 1, kind: 'idle', at100ns: '-1' },
    { version: 1, kind: 'idle' }, { version: 1, kind: 'idle', at100ns: '1', bytes: [] }]) {
    const f = fixture(); await f.open(); f.line(bad);
    expect(f.errors).toHaveLength(1); expect(f.idle).toEqual([]);
  }
});
