import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { Ma2LivePlayback, parseMa2LivePlayback } from './ma2-live-playback';

const native: unknown = JSON.parse(await readFile(new URL('./fixtures/ma2-live-faders-3.7.json', import.meta.url), 'utf8'));
it('parses actual onPC values and functions without inventing empty fader levels', () => {
  const result = parseMa2LivePlayback(native, 1000, 1);
  expect(result.items[0]).toMatchObject({ slot: 1, name: 'TBLINK_40_STEP_ACCEPTANCE', objectNumber: '9986', width: 1 });
  expect(result.items[0]!.blocks[0]).toMatchObject({ fader: { value: 1, name: 'LTP', text: '100%' }, buttons: [{ id: 0, name: 'Go' }, { id: 1, name: 'On' }, { id: 2, name: 'Off' }] });
  expect(result.items[1]!.blocks[0]!.fader).toBeNull();
  expect(() => parseMa2LivePlayback(native, 999, 1)).toThrow('其他页面');
  expect(() => parseMa2LivePlayback(native, 1000, 16)).toThrow('格号');
});
class Socket extends EventTarget {
  readyState = WebSocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  readResponse = true;
  closed = false;
  message(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(raw: string): void {
    const data = JSON.parse(raw) as Record<string, unknown>; this.sent.push(data);
    queueMicrotask(() => {
      if (!data.requestType) this.message({ session: 7 });
      else if (data.requestType === 'login') this.message({ session: 7, responseType: 'login', result: true });
      else if (data.requestType === 'playbacks' && this.readResponse) this.message(native);
    });
  }
  close(): void { this.closed = true; }
}
function setup() {
  const socket = new Socket();
  const client = new Ma2LivePlayback('127.0.0.1', () => { queueMicrotask(() => socket.message({ status: 'server ready' })); return socket as unknown as WebSocket; });
  return { socket, client };
}
it('authenticates once, coalesces duplicate reads and sends exact page, fader and key addresses', async () => {
  const { client, socket } = setup();
  try {
    await client.connect('test', 'test-secret');
    const [one, two] = await Promise.all([client.read(1000, 1), client.read(1000, 1)]);
    expect(one).toEqual(two); expect(socket.sent.filter(value => value.requestType === 'playbacks')).toHaveLength(1);
    client.input(1000, 3, { kind: 'fader', value: 0.6 });
    client.input(1000, 3, { kind: 'button', id: 2, pressed: true });
    client.input(1000, 3, { kind: 'button', id: 2, pressed: false });
    expect(socket.sent.slice(-3)).toMatchObject([{ pageIndex: 999, execIndex: 2, faderValue: 0.6 }, { buttonId: 2, pressed: true, released: false }, { buttonId: 2, pressed: false, released: true }]);
    expect(JSON.stringify(socket.sent)).not.toContain('test-secret');
  } finally { client.close(); }
});
it('stops after a response timeout without reconnecting or replaying a control', async () => {
  const { client, socket } = setup(); await client.connect('test', '');
  vi.useFakeTimers();
  try {
    socket.readResponse = false;
    const read = expect(client.read(1000, 1)).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(2501); await read;
    expect(socket.closed).toBe(true); expect(client.connected).toBe(false);
    expect(() => client.input(1000, 1, { kind: 'fader', value: 1 })).toThrow('超时');
    expect(socket.sent.filter(value => value.requestType === 'playbacks_userInput')).toHaveLength(0);
  } finally { client.close(); vi.useRealTimers(); }
});
