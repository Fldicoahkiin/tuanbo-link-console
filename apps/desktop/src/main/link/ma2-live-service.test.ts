import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type Ma2ExecutorInput, type Ma2LiveConnect, type Ma2LiveSnapshot } from '@tb/schema';
import { Ma2LiveService } from './ma2-live-service';
import type { Ma2ButtonSnapshot, Ma2LivePlayback } from './ma2-live-playback';
import { Ma2CommandQueue, type Ma2CommandPriority } from './ma2-command-queue';
import { ma2CommandKind } from './ma2-telnet';

const mock = vi.hoisted(() => ({ input: vi.fn(), close: vi.fn(), read: vi.fn(), connect: vi.fn(), pages: vi.fn() }));
vi.mock('./ma2-executor-page', () => ({ listMa2ExecutorPages: mock.pages }));
vi.mock('./ma2-live-playback', async importOriginal => ({ ...await importOriginal<typeof import('./ma2-live-playback')>(), Ma2LivePlayback: class {
  connected = true; input = mock.input; close = mock.close; read = mock.read; connect = mock.connect;
} }));
const source = { show: 'test', generation: 'one', version: '3.7.0.5' };
const request: Ma2LiveConnect = { network: { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: source, username: 'test', password: 'test-secret', page: 1000, start: 1 };
const readRequest = { network: request.network, expectedSource: source, page: 1000, start: 1 };
const snapshot = (): Ma2LiveSnapshot => ({ page: 1000, start: 1, readAt: Date.now(), items: [{ slot: 1, width: 1, name: 'test', objectType: 'LT', objectNumber: '9900', running: false, cue: '', blocks: [{ slot: 1, fader: { value: 1, min: 0, max: 1, name: 'LTP', text: '100%' }, buttons: [{ id: 0, name: 'Flash', active: false }] }] }] });
beforeEach(() => { vi.clearAllMocks(); mock.connect.mockResolvedValue(undefined); mock.read.mockImplementation(() => Promise.resolve(snapshot())); });
afterEach(() => vi.useRealTimers());
const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
/** The console's Telnet line over the real command queue: the Show check and plugin steps share it. */
function fakeTelnet() {
  const queue = new Ma2CommandQueue();
  const console = { ...source };
  const sent: string[] = [];
  const command = vi.fn((line: string, match: (text: string) => string | null, _beforeSend?: unknown, priority: Ma2CommandPriority = 'normal') => queue.schedule(() => {
    sent.push(ma2CommandKind(line));
    const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
    const reply = marker ? match(`${marker}:${hex(console.show)},${hex(console.generation)},${hex(console.version)}\r\n`) : 'ACK';
    return reply === null ? Promise.reject(new Error('No response')) : Promise.resolve(reply);
  }, priority, ma2CommandKind(line)));
  return { telnet: { command }, console, sent, queue };
}
/** The channel's kind, and a part of the reason it gives. */
function expectChannel(channel: { kind: string; reason: string }, kind: string, reason: string): void {
  expect(channel.kind).toBe(kind);
  expect(channel.reason).toContain(reason);
}
type ButtonItem = Ma2ButtonSnapshot['items'][number];
const flashItem = (): ButtonItem => ({ slot: 101, width: 1, name: 'Flash', objectType: 'LT', objectNumber: '9000', running: false, cue: '', buttons: [{ id: 0, name: 'Flash', active: false }] });
/** Web remote sessions of the Button area (M7); each login is a new one. `area` is what the console holds now. */
function buttonSockets(area: (page: number, start: number) => ButtonItem[] | Error = (_page, start) => start === 101 ? [flashItem()] : []) {
  const made: Array<{ connected: boolean; connect: ReturnType<typeof vi.fn>; readButtons: ReturnType<typeof vi.fn>; input: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  const state: { area: typeof area; gate: Promise<void> | null } = { area, gate: null };
  const socket = (): Ma2LivePlayback => {
    const client = {
      connected: true, connect: vi.fn(() => Promise.resolve()), input: vi.fn(),
      readButtons: vi.fn(async (page: number, start: number): Promise<Ma2ButtonSnapshot> => {
        // `gate`: the console answers only when the test lets it, as a slow Show check or login would.
        if (state.gate) await state.gate;
        const items = state.area(page, start);
        if (items instanceof Error) { client.connected = false; throw items; }
        return { page, start, readAt: Date.now(), items };
      }),
      close: vi.fn(() => { client.connected = false; })
    };
    made.push(client);
    return client as unknown as Ma2LivePlayback;
  };
  return { made, socket, state };
}
/** `choice`: what the operator chose on this computer before connecting; the M7 cases below choose the web remote. */
async function setup(buttons = buttonSockets(), choice: 'webRemote' | 'plugin' = 'webRemote') {
  const dir = await mkdtemp(join(tmpdir(), 'tblink-fader-test-'));
  const secrets = { saveCredential: vi.fn<(_key: string, value: string) => Promise<void>>().mockResolvedValue(undefined), loadCredential: vi.fn().mockResolvedValue('test-secret') };
  const line = fakeTelnet();
  const service = new Ma2LiveService(join(dir, 'profiles.json'), secrets, () => line.telnet, buttons.socket);
  await service.chooseKeys(choice);
  await service.connect(request);
  return { service, secrets, buttons, ...line };
}
const press = (change: Partial<Ma2ExecutorInput> = {}): Ma2ExecutorInput => ({
  network: request.network, expectedSource: source, page: 1000, slot: 101, button: 0, pressed: true, channel: 'webRemote',
  expectedItem: { slot: 101, width: 1, name: 'Flash', kind: 'sequence', sequence: 9000, button: 12302, buttons: [12302], reference: ['25', '1', '9000'] },
  sessionId: '11111111-1111-4111-8111-111111111111', deadlineAt: Date.now() + 500, ...change
});
it('checks source, saves credentials separately and refuses empty, stale and unrelated targets', async () => {
  const { service, secrets } = await setup();
  try {
    expect(secrets.saveCredential).toHaveBeenCalledWith(expect.stringMatching(/^ma2-web-/), 'test-secret');
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 0.5 } });
    expect(mock.input).toHaveBeenCalledWith(1000, 1, { kind: 'fader', value: 0.5 });
    expect(() => service.input({ ...readRequest, slot: 2, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 0.5 } })).toThrow('没有可操作');
    expect(() => service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() - 1, action: { kind: 'fader', value: 0.5 } })).toThrow('过期');
    await expect(service.read({ ...readRequest, expectedSource: { ...source, generation: 'other' } })).rejects.toThrow('已改变');
  } finally { service.close(); }
});
it('releases held buttons once on blur, page change or shutdown; duplicate release cannot retrigger', async () => {
  const { service } = await setup();
  try {
    const input = { ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'button' as const, id: 0, pressed: true } };
    service.input(input); service.release(); service.release();
    service.input({ ...input, action: { ...input.action, pressed: false } });
    expect(mock.input.mock.calls).toEqual([[1000, 1, { kind: 'button', id: 0, pressed: true }], [1000, 1, { kind: 'button', id: 0, pressed: false }]]);
  } finally { service.close(); }
});
it('a missing renderer heartbeat releases a held button and blocks later writes without replay', async () => {
  const { service } = await setup(); vi.useFakeTimers();
  try {
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'button', id: 0, pressed: true } });
    await vi.advanceTimersByTimeAsync(1501);
    expect(mock.input).toHaveBeenLastCalledWith(1000, 1, { kind: 'button', id: 0, pressed: false });
    await expect(service.read(readRequest)).rejects.toThrow('已停止');
    expect(mock.connect).toHaveBeenCalledTimes(1);
  } finally { service.close(); }
});
it('source change during polling stops the live connection instead of showing old values', async () => {
  const { service, console } = await setup(); vi.useFakeTimers();
  try {
    console.show = 'other';
    await vi.advanceTimersByTimeAsync(1001);
    await expect(service.read(readRequest)).rejects.toThrow('Show');
    expect(mock.close).toHaveBeenCalled();
  } finally { service.close(); }
});
it('disconnect while loading saved credentials cannot reopen an obsolete session', async () => {
  const { service, secrets } = await setup();
  service.close();
  let complete: (password: string) => void = () => { throw new Error('credential read has not started'); };
  let started: () => void = () => { throw new Error('test wait has not started'); };
  const loading = new Promise<void>(resolve => { started = resolve; });
  secrets.loadCredential.mockImplementation(() => new Promise<string>(resolve => { complete = resolve; started(); }));
  const reading = service.read(readRequest);
  const rejected = expect(reading).rejects.toThrow('已改变');
  await loading; service.close(); complete('test-secret');
  await rejected;
  expect(mock.connect).toHaveBeenCalledTimes(1);
});
it('uses the reported fader range for speed and special masters instead of assuming a dimmer percentage', async () => {
  const { service } = await setup();
  try {
    const speed = snapshot(); speed.items[0]!.blocks[0]!.fader = { value: 120, min: 0, max: 240, name: 'Speed', text: '120 BPM' };
    mock.read.mockResolvedValue(speed);
    await service.read(readRequest);
    service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 150 } });
    expect(mock.input).toHaveBeenLastCalledWith(1000, 1, { kind: 'fader', value: 150 });
    expect(() => service.input({ ...readRequest, slot: 1, deadlineAt: Date.now() + 500, action: { kind: 'fader', value: 241 } })).toThrow('超出');
  } finally { service.close(); }
});

it('核对控台在不在跟：用推杆页存过的用户另开一个只读连接；没连过网页遥控时说明原因；失败后这首歌不再读，换下一首前清掉', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tblink-observer-test-'));
  const secrets = { saveCredential: vi.fn<(_key: string, value: string) => Promise<void>>().mockResolvedValue(undefined), loadCredential: vi.fn().mockResolvedValue('test-secret') };
  const { telnet } = fakeTelnet();
  const observer = { connect: vi.fn(() => Promise.resolve()), observe: vi.fn(() => Promise.resolve<{ running: boolean; cue: string; name: string } | null>({ running: true, cue: '    5 FuGe', name: 'Song' })), close: vi.fn() };
  const service = new Ma2LiveService(join(dir, 'profiles.json'), secrets, () => telnet, () => observer as unknown as Ma2LivePlayback);
  const observe = { network: request.network, page: 1000, slot: 101 };
  try {
    const unavailable = await service.observe(observe);
    expect(unavailable.kind === 'unavailable' && unavailable.reason).toContain('网页遥控');
    await service.connect(request);
    mock.connect.mockClear();
    expect(await service.observe(observe)).toEqual({ kind: 'executor', running: true, cue: '    5 FuGe', name: 'Song' });
    expect(observer.connect).toHaveBeenCalledWith('test', 'test-secret');
    expect(mock.connect).not.toHaveBeenCalled();
    observer.observe.mockResolvedValueOnce(null);
    expect(await service.observe(observe)).toEqual({ kind: 'empty' });
    observer.observe.mockRejectedValueOnce(new Error('实时推杆读取超时，请重新连接'));
    await expect(service.observe(observe)).rejects.toThrow('读取超时');
    await expect(service.observe(observe)).rejects.toThrow('读取超时');
    expect(observer.observe).toHaveBeenCalledTimes(3);
    expect(mock.close).not.toHaveBeenCalled();
    service.releaseObserver();
    expect(await service.observe(observe)).toMatchObject({ kind: 'executor' });
  } finally { service.close(); }
});

it('网页遥控核对 Show 用一条短命令，不走插件', async () => {
  const { service, telnet, sent } = await setup(); vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 1001);
    await service.read(readRequest);
    expect(mock.pages).not.toHaveBeenCalled();
    expect(sent).toEqual(['show-check', 'show-check']);
    expect(telnet.command.mock.calls.every(call => call[3] === 'playback')).toBe(true);
  } finally { service.close(); }
});
it('插件命令执行中，核对排在下一条后台命令前面', async () => {
  const { service, queue, sent } = await setup(); vi.useFakeTimers({ toFake: ['Date'] });
  try {
    sent.length = 0;
    let finish: (value: string) => void = () => { throw new Error('plugin step has not started'); };
    const run = queue.schedule(() => { sent.push('plugin:run'); return new Promise<string>(resolve => { finish = resolve; }); }, 'normal', 'plugin:run');
    const next = queue.schedule(() => { sent.push('plugin:read'); return Promise.resolve('DATA:00'); }, 'normal', 'plugin:read');
    vi.setSystemTime(Date.now() + 1001);
    const reading = service.read(readRequest);
    await new Promise(resolve => setImmediate(resolve));
    // A Telnet command on the line is never taken back: the check waits for this one step, not the whole sync.
    expect(sent).toEqual(['plugin:run']);
    finish('DONE:1');
    await expect(reading).resolves.toMatchObject({ page: 1000 });
    await Promise.all([run, next]);
    expect(sent).toEqual(['plugin:run', 'show-check', 'plugin:read']);
    expect(mock.pages).not.toHaveBeenCalled();
  } finally { service.close(); }
});
it('插件没在运行时说明原因并停下实时状态，不当成 Show 没变', async () => {
  const { service, console } = await setup(); vi.useFakeTimers({ toFake: ['Date'] });
  try {
    console.generation = '';
    vi.setSystemTime(Date.now() + 1001);
    await expect(service.read(readRequest)).rejects.toThrow('插件没在运行');
    await expect(service.read(readRequest)).rejects.toThrow('已停止');
  } finally { service.close(); }
});

it('连接网页遥控时读一次 Button 区：读回格号一致的执行器就走网页遥控，读不了走控台插件并写明原因；推杆连接不受影响', async () => {
  const found = await setup(buttonSockets((_page, start) => start === 116 ? [{ ...flashItem(), slot: 117 }] : []));
  try {
    expectChannel(found.service.buttonChannel(readRequest), 'webRemote', '116–130');
    expect(found.buttons.made[0]!.readButtons.mock.calls).toEqual([[1000, 101], [1000, 116]]);
    expect(found.buttons.made[0]!.connect).toHaveBeenCalledWith('test', 'test-secret');
  } finally { found.service.close(); }
  const refused = await setup(buttonSockets(() => new Error('控台返回的 Button 区格号和请求的不一致（请求 1000.101–115，回来的是 1）')));
  try {
    expectChannel(refused.service.buttonChannel(readRequest), 'plugin', '不一致');
    expect(refused.buttons.made[0]!.close).toHaveBeenCalled();
    mock.close.mockClear();
    await expect(refused.service.read(readRequest)).resolves.toMatchObject({ page: 1000 });
    expect(mock.close).not.toHaveBeenCalled();
  } finally { refused.service.close(); }
  const empty = await setup(buttonSockets(() => []));
  try {
    expectChannel(empty.service.buttonChannel(readRequest), 'plugin', '没有执行器');
    expect(empty.buttons.made[0]!.readButtons).toHaveBeenCalledTimes(6);
  } finally { empty.service.close(); }
});
it('网页遥控按键：核对这一格再发，松开发松开；续按只续时间，停了 1.5 秒自己松开', async () => {
  const { service, buttons } = await setup();
  const client = buttons.made[0]!;
  try {
    await service.inputButton(press());
    expect(client.input).toHaveBeenLastCalledWith(1000, 101, { kind: 'button', id: 0, pressed: true });
    await service.inputButton(press());
    expect(client.input).toHaveBeenCalledTimes(1);
    await service.inputButton(press({ pressed: false }));
    expect(client.input).toHaveBeenLastCalledWith(1000, 101, { kind: 'button', id: 0, pressed: false });
    await service.inputButton(press({ pressed: false }));
    expect(client.input).toHaveBeenCalledTimes(2);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await service.inputButton(press({ sessionId: '22222222-2222-4222-8222-222222222222' }));
    await vi.advanceTimersByTimeAsync(1501);
    expect(client.input).toHaveBeenLastCalledWith(1000, 101, { kind: 'button', id: 0, pressed: false });
    expect(client.input).toHaveBeenCalledTimes(4);
  } finally { service.close(); }
});
it('网页遥控按键不发的情况：这一格变了、过了期限、页面以为走插件；错误记下来，通道不变', async () => {
  const { service, buttons } = await setup();
  const client = buttons.made[0]!;
  try {
    buttons.state.area = () => [{ ...flashItem(), name: 'Other' }];
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
    await expect(service.inputButton(press())).rejects.toThrow('控台上这一格叫「Other」，页面上是「Flash」，按键没有发送');
    buttons.state.area = () => [{ ...flashItem(), objectNumber: '9001' }];
    vi.setSystemTime(Date.now() + 1001);
    await expect(service.inputButton(press())).rejects.toThrow('序列 9001');
    buttons.state.area = () => [];
    vi.setSystemTime(Date.now() + 1001);
    await expect(service.inputButton(press())).rejects.toThrow('这一格没有执行器');
    await expect(service.inputButton(press({ deadlineAt: Date.now() - 1 }))).rejects.toThrow('过期');
    await expect(service.inputButton(press({ channel: 'plugin' }))).rejects.toThrow('通道变了');
    expect(client.input).not.toHaveBeenCalled();
    expectChannel(service.buttonChannel(readRequest), 'webRemote', '通道不变');
  } finally { service.close(); }
});
it('推杆页用存过的用户重新登录时不再读 Button 区，已选的通道不变；按键时网页遥控按键线路自己登录', async () => {
  const { service, buttons } = await setup();
  try {
    service.close();
    expect(service.buttonChannel(readRequest).kind).toBe('webRemote');
    await service.read(readRequest);
    expect(buttons.made).toHaveLength(2);
    expect(buttons.made[1]!.readButtons).not.toHaveBeenCalled();
    buttons.made[1]!.connected = false;
    await service.inputButton(press());
    expect(buttons.made).toHaveLength(3);
    expect(buttons.made[2]!.input).toHaveBeenCalledWith(1000, 101, { kind: 'button', id: 0, pressed: true });
    // Only the operator's "连接" reads the Button area again.
    buttons.state.area = () => new Error('实时推杆读取超时，请重新连接');
    await service.connect(request);
    expectChannel(service.buttonChannel(readRequest), 'plugin', '读取超时');
  } finally { service.close(); }
});

it('选的是控台插件时不开 Button 会话、不读 Button 区；连着时改选网页遥控当场读一次，读得回才走网页遥控', async () => {
  const { service, buttons } = await setup(buttonSockets(), 'plugin');
  try {
    expect(buttons.made).toHaveLength(0);
    expect(service.buttonChannel(readRequest)).toMatchObject({ kind: 'plugin', choice: 'plugin', webRemote: { ready: false, reason: '选了网页遥控才会去读 Button 区' } });
    await expect(service.inputButton(press())).rejects.toThrow('通道变了');
    expect(await service.chooseKeys('webRemote')).toBe(true);
    // Read while choosing: the answer is known when the choice returns.
    expect(buttons.made).toHaveLength(1);
    expect(buttons.made[0]!.connect).toHaveBeenCalledWith('test', 'test-secret');
    expect(buttons.made[0]!.readButtons).toHaveBeenCalledWith(1000, 101);
    expect(service.keyChannel(readRequest, 101)).toBe('webRemote');
    await service.inputButton(press({ sessionId: '22222222-2222-4222-8222-222222222222' }));
    expect(buttons.made[0]!.input).toHaveBeenCalledWith(1000, 101, { kind: 'button', id: 0, pressed: true });
    // Back to the plugin: the held key is let go first, then the Button session is closed.
    expect(await service.chooseKeys('plugin')).toBe(true);
    expect(buttons.made[0]!.input).toHaveBeenLastCalledWith(1000, 101, { kind: 'button', id: 0, pressed: false });
    expect(buttons.made[0]!.close).toHaveBeenCalled();
    expect(service.keyChannel(readRequest, 101)).toBe('plugin');
    // Choosing the web remote again reads the console again; what it says now decides.
    buttons.state.area = () => new Error('控台返回的 Button 区格号和请求的不一致（请求 1000.101–115，回来的是 1）');
    expect(await service.chooseKeys('webRemote')).toBe(true);
    expect(buttons.made).toHaveLength(2);
    expect(buttons.made[1]!.readButtons).toHaveBeenCalledWith(1000, 101);
    expect(service.buttonChannel(readRequest)).toMatchObject({ kind: 'plugin', choice: 'webRemote', webRemote: { ready: false } });
    expect(service.buttonChannel(readRequest).reason).toContain('不一致');
    // What was read is not kept across a choice of the plugin: chosen again while not connected, it says so.
    buttons.state.area = () => [flashItem()];
    await service.chooseKeys('plugin'); service.close();
    expect(await service.chooseKeys('webRemote')).toBe(true);
    expect(buttons.made).toHaveLength(2);
    expect(service.buttonChannel(readRequest).reason).toContain('网页遥控没连上');
  } finally { service.close(); }
});
it('没连着推杆页时改选网页遥控不读，标签写没连上；之后连接时读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tblink-key-choice-test-'));
  const secrets = { saveCredential: vi.fn<(_key: string, value: string) => Promise<void>>().mockResolvedValue(undefined), loadCredential: vi.fn().mockResolvedValue('test-secret') };
  const buttons = buttonSockets();
  const service = new Ma2LiveService(join(dir, 'profiles.json'), secrets, () => fakeTelnet().telnet, buttons.socket);
  try {
    expect(await service.chooseKeys('webRemote')).toBe(true);
    expect(buttons.made).toHaveLength(0);
    expect(service.buttonChannel(readRequest)).toMatchObject({ kind: 'plugin', choice: 'webRemote', webRemote: { ready: false } });
    expect(service.buttonChannel(readRequest).reason).toContain('网页遥控没连上');
    await service.connect(request);
    expect(buttons.made).toHaveLength(1);
    expect(buttons.made[0]!.readButtons).toHaveBeenCalledWith(1000, 101);
    expect(service.keyChannel(readRequest, 101)).toBe('webRemote');
  } finally { service.close(); }
});
it('轻点时松开比按下先到：这次按下取消，控台一条都收不到，也不当成错误', async () => {
  const { service, buttons } = await setup();
  const client = buttons.made[0]!;
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
    let answer: () => void = () => { throw new Error('read has not started'); };
    buttons.state.gate = new Promise<void>(resolve => { answer = resolve; });
    const pressing = service.inputButton(press());
    const refused = expect(pressing).rejects.toThrow('按键已松开，已取消排队的按下');
    await service.inputButton(press({ pressed: false }));
    answer(); await refused;
    expect(client.input).not.toHaveBeenCalled();
    // The released session is over: a late renew of it is not a new press either.
    buttons.state.gate = null;
    await expect(service.inputButton(press())).rejects.toThrow('已取消排队的按下');
    expect(client.input).not.toHaveBeenCalled();
    expect(service.buttonChannel(readRequest).reason).not.toContain('出错');
  } finally { service.close(); }
});
it('窗口失焦、改执行器之前（releaseButtons）在途的按下也不发', async () => {
  const { service, buttons } = await setup();
  const client = buttons.made[0]!;
  try {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 1001);
    let answer: () => void = () => { throw new Error('read has not started'); };
    buttons.state.gate = new Promise<void>(resolve => { answer = resolve; });
    const pressing = service.inputButton(press());
    const refused = expect(pressing).rejects.toThrow('已取消排队的按下');
    service.releaseButtons();
    answer(); await refused;
    expect(client.input).not.toHaveBeenCalled();
  } finally { service.close(); }
});
