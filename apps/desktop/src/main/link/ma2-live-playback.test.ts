import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { Ma2LivePlayback, parseMa2ExecutorObservation, parseMa2LiveButtons, parseMa2LivePlayback } from './ma2-live-playback';
import { Ma2WebRemoteConsole } from './fixtures/ma2-web-remote-console';

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
  /** What a `playbacks` request is answered with; the fader fixture by default. */
  answer: (request: Record<string, unknown>) => unknown = () => native;
  closed = false;
  message(value: unknown): void { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(raw: string): void {
    const data = JSON.parse(raw) as Record<string, unknown>; this.sent.push(data);
    queueMicrotask(() => {
      if (!data.requestType) this.message({ session: 7 });
      else if (data.requestType === 'login') this.message({ session: 7, responseType: 'login', result: true });
      else if (data.requestType === 'playbacks' && this.readResponse) this.message(this.answer(data));
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

it('读回单个执行器：在不在跑、当前 Cue；返回的格号和请求不一致时拒绝，不当成“没在跑”', async () => {
  expect(parseMa2ExecutorObservation(native, 1000, 1)).toEqual({ running: false, cue: '', name: 'TBLINK_40_STEP_ACCEPTANCE' });
  expect(() => parseMa2ExecutorObservation(native, 999, 1)).toThrow('其他页面');
  expect(() => parseMa2ExecutorObservation(native, 1000, 101)).toThrow('格号');
  const { client, socket } = setup();
  await client.connect('test', 'test-secret');
  expect(await client.observe(1000, 2)).toMatchObject({ running: false });
  expect(socket.sent.at(-1)).toMatchObject({ requestType: 'playbacks', startIndex: [0], itemsCount: [15], pageIndex: 999, itemsType: [2] });
  // Button executors 101–190 are asked for as their own group; this fixture answers with fader slots and is refused.
  await expect(client.observe(1000, 101)).rejects.toThrow('格号');
  expect(socket.sent.at(-1)).toMatchObject({ startIndex: [100], itemsType: [3], view: 3 });
  expect(socket.closed).toBe(true);
});

type NativeGroup = { itemsType: number; items: Array<Array<Record<string, unknown>>> };
/** The fixture's first executor answered as a button executor at `slot`, the way the web remote groups them. */
function buttonAnswer(page: number, slot: number, itemsType = 3): unknown {
  const fader = (native as { itemGroups: NativeGroup[] }).itemGroups[0]!.items[0]![0]!;
  const blocks = fader.executorBlocks as Array<Record<string, unknown>>;
  const item = { ...fader, iExec: slot - 1, executorBlocks: [{ button1: blocks[0]!.button1 }] };
  return { responseType: 'playbacks', responseSubType: 3, iPage: page, itemGroups: [{ itemsType, cntPages: 10000, items: [[item]] }] };
}
it('读 Button 区（M7）：按按钮执行器的方式要 15 格，格号和请求的一致才收下；格号不对、类型不对、页不对都算读不了', async () => {
  expect(parseMa2LiveButtons(buttonAnswer(1000, 117), 1000, 116)).toMatchObject({ page: 1000, start: 116, items: [{ slot: 117, name: 'TBLINK_40_STEP_ACCEPTANCE', objectNumber: '9986', buttons: [{ id: 0, name: 'Go' }] }] });
  expect(parseMa2LiveButtons({ responseType: 'playbacks', iPage: 1000, itemGroups: [{ itemsType: 3, items: [] }] }, 1000, 101).items).toEqual([]);
  // The fader fixture answers slots 1–15: what 3.3.4.3 might send for a Button area it does not know is refused.
  expect(() => parseMa2LiveButtons(buttonAnswer(1000, 1), 1000, 101)).toThrow('Button 区格号和请求的不一致（请求 1000.101–115，回来的是 1）');
  expect(() => parseMa2LiveButtons(buttonAnswer(1000, 131), 1000, 101)).toThrow('不一致');
  expect(() => parseMa2LiveButtons(buttonAnswer(1000, 101, 2), 1000, 101)).toThrow('不是按钮执行器');
  expect(() => parseMa2LiveButtons(buttonAnswer(999, 101), 1000, 101)).toThrow('其他页面');
  expect(() => parseMa2LiveButtons({ ...buttonAnswer(1000, 101) as object, accessDenied: true }, 1000, 101)).toThrow('没有执行器播放权限');
  const { client, socket } = setup();
  socket.answer = request => buttonAnswer(1000, (request.startIndex as number[])[0]! + 1);
  await client.connect('test', 'test-secret');
  expect(await client.readButtons(1000, 146)).toMatchObject({ start: 146, items: [{ slot: 146 }] });
  expect(socket.sent.at(-1)).toMatchObject({ requestType: 'playbacks', startIndex: [145], itemsCount: [15], pageIndex: 999, itemsType: [3], view: 3 });
  await expect(client.readButtons(1000, 102)).rejects.toThrow('范围无效');
  socket.answer = () => buttonAnswer(1000, 1);
  await expect(client.readButtons(1000, 101)).rejects.toThrow('不一致');
  // A Button area answer that does not fit closes this session only; nothing is sent on it afterwards.
  expect(socket.closed).toBe(true); expect(client.connected).toBe(false);
});

// M8 review (2026-11-11): requests on one web remote session take turns; none is refused because another is reading.
it('一条会话上三个以上同时读（不同页的推杆、单个执行器、关灯读回）都拿到各自的结果，没有“实时推杆正在读取”', async () => {
  const console = new Ma2WebRemoteConsole();
  for (const executor of ['1.1', '1.20', '2.5']) console.running.set(executor, executor === '1.20');
  const client = console.playback('web');
  try {
    await client.connect('test', 'test-secret');
    const [faders, other, observed, peeked, again] = await Promise.all([client.read(1, 1), client.read(2, 1), client.observe(1, 20), client.peek(1, 16), client.read(1, 1)]);
    expect(faders.items.map(item => item.slot)).toEqual([1]);
    expect(other.items.map(item => item.slot)).toEqual([5]);
    expect(observed).toMatchObject({ running: true });
    expect(peeked).toMatchObject([{ slot: 20, running: true }]);
    expect(again).toEqual(faders);
    // The same page on its way twice is asked once.
    expect(console.requests).toEqual(['web 1.1', 'web 2.1', 'web 1.16', 'web 1.16']);
    expect(client.connected).toBe(true);
  } finally { client.close(); }
});

it('关灯读回读到看不懂的回答只报错，会话照旧；“在不在跟”自己的读取看不懂照旧关会话', async () => {
  const console = new Ma2WebRemoteConsole();
  console.running.set('1.1', false);
  const client = console.playback('web');
  try {
    await client.connect('test', 'test-secret');
    console.garble = { page: 1, count: 1 };
    await expect(client.peek(1, 1)).rejects.toThrow('其他页面');
    expect(client.connected).toBe(true);
    expect(await client.observe(1, 1)).toMatchObject({ running: false });
    console.garble = { page: 1, count: 1 };
    await expect(client.observe(1, 1)).rejects.toThrow('其他页面');
    expect(client.connected).toBe(false);
  } finally { client.close(); }
});
