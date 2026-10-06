import { expect, it, vi } from 'vitest';
import type { IntegrationProfile } from '@tb/schema';
import { NativeMidiPorts } from './native-midi-ports';

function fixture() {
  const profile: Pick<IntegrationProfile, 'midiPortProfiles'> = { midiPortProfiles: [
    { id: 'a', direction: 'output', portName: '专用端口' }, { id: 'b', direction: 'output', portName: '专用端口' },
    { id: 'other', direction: 'output', portName: '其他端口' }] };
  const output = { open: vi.fn<(name: string) => Promise<void>>(() => Promise.resolve()), send: vi.fn<(bytes: readonly number[], deadline: bigint) => Promise<{ acceptedAt100ns: bigint }>>(() => Promise.resolve({ acceptedAt100ns: 1n })),
    close: vi.fn(() => Promise.resolve()) };
  const authorize = vi.fn(() => Promise.resolve()), failed = vi.fn(), create = vi.fn(() => output);
  const ports = new NativeMidiPorts(profile, { executable: 'engine.exe', authorize, failed, create });
  return { ports, output, authorize, failed, create };
}

it('只打开节目需要的精确目标，同名档案共享一次打开，不选择默认端口', async () => {
  const f = fixture(); await f.ports.prepare(['a', 'a', 'b'], new AbortController().signal);
  expect(f.output.open.mock.calls).toEqual([['专用端口']]); expect(f.create).toHaveBeenCalledOnce();
  await f.ports.send('b', [0xc0, 1], 1000.5); expect(f.output.send.mock.calls).toEqual([[[0xc0, 1], 10005000n]]);
  await expect(f.ports.send('other', [0xc0, 1], 1000.5)).rejects.toThrow('本轮未准备');
  await f.ports.close(); expect(f.output.close).toHaveBeenCalledOnce();
});

it('许可仍在等待时可以停止；迟到许可不会打开设备或发送动作', async () => {
  const f = fixture(); let complete: (() => void) | undefined;
  f.authorize.mockReturnValueOnce(new Promise<void>(resolve => { complete = resolve; }));
  const preparing = expect(f.ports.prepare(['a'], new AbortController().signal)).rejects.toThrow('已取消');
  await f.ports.close(); await preparing; complete!(); await Promise.resolve();
  expect(f.create).not.toHaveBeenCalled(); expect(f.output.send).not.toHaveBeenCalled();
});

it('打开端口途中取消必须关闭已拥有的辅助进程，不能继续打开下一个目标', async () => {
  const f = fixture(), abort = new AbortController(); let complete: (() => void) | undefined;
  f.output.open.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const preparing = expect(f.ports.prepare(['a', 'other'], abort.signal)).rejects.toThrow('已取消');
  await vi.waitFor(() => expect(f.output.open).toHaveBeenCalledOnce());
  abort.abort(); await Promise.resolve(); expect(f.output.close).toHaveBeenCalledOnce();
  complete!(); await preparing; await f.ports.close(); expect(f.output.open).toHaveBeenCalledOnce();
});

it('发送前再次核对许可，取消许可等待不会发出已排队动作', async () => {
  const f = fixture(); await f.ports.prepare(['a'], new AbortController().signal);
  f.authorize.mockReturnValueOnce(new Promise<void>(() => undefined));
  const pending = expect(f.ports.send('a', [0x90, 60, 100], 1000)).rejects.toThrow('已取消');
  await f.ports.close(); await pending; expect(f.output.send).not.toHaveBeenCalled();
});

it('没有 MIDI 动作不打开设备；无效档案不会误开其他输出', async () => {
  const empty = fixture(); await empty.ports.prepare([], new AbortController().signal); await empty.ports.close();
  expect(empty.authorize).not.toHaveBeenCalled(); expect(empty.create).not.toHaveBeenCalled();
  const bad = fixture(); await expect(bad.ports.prepare(['missing'], new AbortController().signal)).rejects.toThrow('不存在或不唯一');
  await bad.ports.close(); expect(bad.create).not.toHaveBeenCalled();
});
