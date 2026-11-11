import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { isShowWait, type ShowState } from '@tb/core/link';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { idleShow, pausedShow, runningShow, showReader } from './fixtures/show-gates';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2BridgeFailure, Ma2OnpcBridge, ma2StepGate, ma2WriteStep } from './ma2-onpc-bridge';
import { Ma2LiveService } from './ma2-live-service';
import type { Ma2ButtonSnapshot, Ma2LivePlayback } from './ma2-live-playback';
import { LightingOffService } from './lighting-off-service';
import { createLightingDocument, type Ma2ExecutorInput, type Ma2LiveSnapshot } from '@tb/schema';

// M3, 第 3 题 (2026-11-10): a sync on the console stops at a step boundary once the time code starts. The real
// tools/ma2/tblink_bridge.lua runs here in Lua 5.3 against the fake console, behind the real wire and bridge.
// 1. The step on the console finishes, the next one is not sent, the request is released at once, and the stop is a
//    wait (isShowWait), not a failure.
// 2. The write step is never cut, and the read-back after it is never held: a request either stops before its write
//    (sent: false, the console holds what it held) or ends confirmed.
// 3. Stopped and synced again from the start, the console ends up exactly as after one uninterrupted sync.
// 4. Paused, every step runs as when stopped. What may run at any time (the version check) is never held.

const timecode = readFileSync(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url), 'utf8');
const sequence = readFileSync(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url), 'utf8');
// Timecode 9902 fires Sequence 9901; the edit moves its second Cue and adds one from Sequence 9903.
const sequence9903 = sequence.replace('<Sequ index="9900"', '<Sequ index="9902"');
const desired = timecode.replace('time="45"', 'time="60"').replace('</SubTrack>', '<Event index="2" time="90" command="Goto" pressed="true" step="3"><Cue name="Cue 1.25"><No>1</No><No>9903</No><No>1</No></Cue></Event></SubTrack>');

function consoleWithShow(): Ma2LuaConsole {
  const ma2 = new Ma2LuaConsole();
  ma2.set('Timecode 9902', { xml: timecode, name: 'TBLINK_FRACTIONAL_TIMECODE' });
  ma2.set('Sequence 9901', { xml: sequence, name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'A' });
  ma2.set('Sequence 9903', { xml: sequence9903, name: 'TBLINK_CUE_REFERENCE_ACCEPTANCE', label: 'B' });
  return ma2;
}

/** A console and a bridge whose show starts moving while the `at`-th plugin step (run or step line) runs. */
function rig(start: ShowState = idleShow) {
  const ma2 = consoleWithShow();
  let show = start; let steps = 0; let at: number | null = null; let moving: ShowState = runningShow;
  ma2.beforeLine = line => {
    if (!/','(?:run|step)','/.test(line)) return;
    steps += 1;
    if (steps === at) show = moving;
  };
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(ma2), showReader(() => show));
  return {
    ma2, bridge,
    /** Counts plugin steps from now; the show turns `to` while step `step` runs. */
    startAt: (step: number | null, to: ShowState = runningShow): void => { steps = 0; at = step; moving = to; },
    stop: (): void => { show = idleShow; at = null; },
    imports: (): string[] => ma2.commands().filter(command => command.startsWith('Import ')),
    object: (): string => ma2.lua(`return FAKE.objects['Timecode 9902'].xml`)[0]!.toString('utf8')
  };
}

async function syncOnce(bridge: Ma2OnpcBridge): Promise<void> {
  const snapshot = await bridge.request('SCOPE', 9902, '9903');
  await bridge.exchange('SYNC', 9902, snapshot, desired);
}

describe('控台同步在一步的边界停下（M3，第 3 题）', { timeout: 60000 }, () => {
  it('写入那一步的位置和插件一致：SYNC 先做完预检（时间码 1 步 + 每个序列 2 步 + 核对 1 步），再写，最后读回', async () => {
    const { ma2, bridge } = rig();
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    const before = ma2.perLine.length;
    await bridge.exchange('SYNC', 9902, snapshot, desired);
    const steps = ma2.perLine.slice(before).filter(entry => /','(?:run|step)','/.test(entry.line));
    const write = steps.findIndex(entry => entry.commands.some(command => command.startsWith('Import ')));
    expect(write + 1).toBe(ma2WriteStep('SYNC', snapshot, desired));
    expect(ma2WriteStep('SYNC', snapshot, desired)).toBe(2 * 2 + 3);
    // The read-back is the step right after the write, and the last.
    expect(steps).toHaveLength(write + 2);
  });

  it('预检的每一步之前时间码开始走：这一步做完，下一步不发，马上放掉插件事务，算等待；控台上没有写入（sent: false）', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const writeStep = ma2WriteStep('SYNC', await consoleSnapshot(), desired)!;
    for (let step = 1; step < writeStep; step++) {
      const { ma2, bridge, startAt, stop, imports, object } = rig();
      const snapshot = await bridge.request('SCOPE', 9902, '9903');
      startAt(step);
      const lines = ma2.lines.length;
      const error = await bridge.exchange('SYNC', 9902, snapshot, desired).then(() => null, (cause: unknown) => cause);
      expect(isShowWait(error), `step ${step}`).toBe(true);
      expect(error).toBeInstanceOf(Ma2BridgeFailure);
      expect((error as Ma2BridgeFailure).sent, `step ${step}`).toBe(false);
      expect(error instanceof Error && error.message).toContain('控台上还没有写入');
      expect(imports()).toEqual([]);
      // begin, the chunks and `step` steps; then only the release: no further step went out.
      const sent = ma2.lines.slice(lines);
      expect(sent.filter(line => /','(?:run|step)','/.test(line)), `step ${step}`).toHaveLength(step);
      expect(sent.at(-1)).toContain("','release','");
      // Released at once: a new request starts now, not after the plugin's 120 s expiry. Synced again from the
      // start after the show stops, the console holds what one uninterrupted sync leaves.
      stop();
      await syncOnce(bridge);
      expect(object(), `step ${step}`).toBe(straight.object());
      expect(imports()).toHaveLength(1);
    }
  });

  it('时间码在写入那一步执行时开始走：写入不打断，紧跟的读回照常做完，这次同步确认成功', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const { bridge, startAt, imports, object } = rig();
    const snapshot = await bridge.request('SCOPE', 9902, '9903');
    startAt(ma2WriteStep('SYNC', snapshot, desired));
    const result = await bridge.exchange('SYNC', 9902, snapshot, desired);
    expect(result.response).toContain('time="60"');
    expect(imports()).toHaveLength(1);
    expect(object()).toBe(straight.object());
  });

  it('读取也在一步的边界停下（按 showGate：读取控台在时间码走时等待），已读的步留在控台上不算失败', async () => {
    const { ma2, bridge, startAt } = rig();
    startAt(1);
    const lines = ma2.lines.length;
    const error = await bridge.request('SCOPE', 9902, '9903').then(() => null, (cause: unknown) => cause);
    expect(isShowWait(error)).toBe(true);
    expect(error instanceof Error && error.message).toContain('读到一半停下了');
    const sent = ma2.lines.slice(lines);
    expect(sent.filter(line => /','(?:run|step)','/.test(line))).toHaveLength(1);
    expect(sent.at(-1)).toContain("','release','");
  });

  it('暂停（播完停住、P1 等下一首同理）时照常一步步做完；版本核对任何时候都发', async () => {
    const straight = rig();
    await syncOnce(straight.bridge);
    const paused = rig();
    paused.startAt(1, pausedShow);
    await syncOnce(paused.bridge);
    expect(paused.object()).toBe(straight.object());
    const moving = rig(runningShow);
    await expect(moving.bridge.request('PING', 1)).resolves.toBe('3.3.4.3');
    expect(ma2StepGate('PING')).toBeNull();
  });

  it('一首歌停下等待，不把排在后面的控台操作当成失败取消：后面的自己在一步之前等待', async () => {
    const { bridge, startAt } = rig();
    startAt(1);
    const first = bridge.request('SCOPE', 9902, '9903').then(() => null, (cause: unknown) => cause);
    const queued = bridge.request('READ', 9902).then(() => null, (cause: unknown) => cause);
    expect(isShowWait(await first)).toBe(true);
    const second = await queued;
    expect(isShowWait(second)).toBe(true);
    expect(second instanceof Error && second.message).not.toContain('排队的操作已取消');
  });
});

/** The snapshot SYNC is planned from, read once from a fresh console. */
async function consoleSnapshot(): Promise<string> {
  return rig().bridge.request('SCOPE', 9902, '9903');
}

// M7 (2026-11-11): Button area keys go on the console plugin, as in 0.5.8, unless the operator chose the web remote on
// this computer and the console read back its Button area when the web remote was connected (ma2-executor-channel.ts).
// The channel changes only by that choice or by connecting again. During a show an error never changes it: the key
// fails with the reason and is not sent on the plugin instead; a web remote logged in again with the saved user reads
// nothing to choose again.
describe('演出中出错不换按键通道（M7）', () => {
  const source = { show: 'TEST', generation: '1', version: '3.3.4.3' };
  const network = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'administrator' };
  const connect = { network, expectedSource: source, username: 'test', password: 'test-secret', page: 1000, start: 1 };
  const request = { network, expectedSource: source };
  const flash = { slot: 101, width: 1, name: 'Flash', objectType: 'LT', objectNumber: '9000', running: false, cue: '', buttons: [{ id: 0, name: 'Flash', active: false }] };
  const key = (sessionId: string): Ma2ExecutorInput => ({ network, expectedSource: source, page: 1000, slot: 101, button: 0, pressed: true, channel: 'webRemote', sessionId, deadlineAt: Date.now() + 500,
    expectedItem: { slot: 101, width: 1, name: 'Flash', kind: 'sequence', sequence: 9000, button: 12302, buttons: [12302], reference: ['25', '1', '9000'] } });
  /** A console whose Button area answers `console.answer()`, behind the real live service. */
  async function rig() {
    const console = { answer: (): Ma2ButtonSnapshot['items'] | Error => [flash] };
    const reads: number[] = [];
    /** Every web remote login the console sees, by which session made it. */
    const logins: string[] = [];
    const buttons = (): Ma2LivePlayback => {
      const client = { connected: true, connect: () => { logins.push('buttons'); return Promise.resolve(); }, input: vi.fn(), close: () => { client.connected = false; },
        readButtons: (page: number, start: number): Promise<Ma2ButtonSnapshot> => {
          reads.push(start);
          const items = console.answer();
          if (items instanceof Error) { client.connected = false; return Promise.reject(items); }
          return Promise.resolve({ page, start, readAt: Date.now(), items });
        } };
      return client as unknown as Ma2LivePlayback;
    };
    const faders = (): Ma2LivePlayback => {
      const snapshot: Ma2LiveSnapshot = { page: 1000, start: 1, readAt: Date.now(), items: [] };
      return { connected: true, connect: () => { logins.push('faders'); return Promise.resolve(); }, read: () => Promise.resolve({ ...snapshot, readAt: Date.now() }), close: () => undefined, input: () => undefined } as unknown as Ma2LivePlayback;
    };
    const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
    const telnet = { command: (line: string, match: (text: string) => string | null) => {
      const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
      return Promise.resolve(marker ? match(`${marker}:${hex(source.show)},${hex(source.generation)},${hex(source.version)}\r\n`) ?? '' : 'ACK');
    } };
    const dir = await mkdtemp(join(tmpdir(), 'tblink-key-channel-rule-'));
    const service = new Ma2LiveService(join(dir, 'profiles.json'), { saveCredential: () => Promise.resolve(), loadCredential: () => Promise.resolve('test-secret') }, () => telnet, buttons, faders);
    return { service, console, reads, logins };
  }
  it('选的是控台插件时，对控台不多发任何东西：只有推杆页自己的登录和读取，Button 区一次都不读', async () => {
    const { service, reads, logins } = await rig();
    try {
      await service.connect(connect);
      await service.read({ ...request, page: 1000, start: 1 });
      service.close();
      await service.read({ ...request, page: 1000, start: 1 });
      // As before M7: one web remote login per fader connection, no Button session, no Button area read.
      expect(logins).toEqual(['faders', 'faders']);
      expect(reads).toEqual([]);
      expect(service.buttonChannel(request)).toMatchObject({ kind: 'plugin', choice: 'plugin', webRemote: { ready: false } });
    } finally { service.close(); }
  });
  // M8 (2026-11-11): the lights-off read-back only reads on a web remote session already connected.
  it('关灯读回：选的是控台插件、没连网页遥控时，对控台除了 Off 什么都不多发；连着推杆页也不读 Button 区', async () => {
    vi.useFakeTimers();
    const { service, reads, logins } = await rig();
    const offs: string[] = [];
    const lights = new LightingOffService({ resending: () => undefined, failed: () => undefined, readBack: (target, executors) => service.readBack(target, executors),
      console: { getMa2NetworkStatus: () => Promise.resolve({ state: 'connected', settings: { ...network, autoConnect: false }, passwordSaved: false, version: '3.3.4.3', error: null, connection: 1 }),
        playMa2Cue: request => { offs.push(request.action.target === 'executor' ? request.action.executor : ''); return Promise.resolve(); } } });
    const song = { song: { itemId: 'a', title: '开场' }, document: { ...createLightingDocument(), consoleSong: undefined,
      ma2Bindings: [{ id: 'b', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>', baselineTracks: [], mappings: [],
        trackMappings: ['1000.1', '1000.101', '1000.191'].map((executor, index) => ({ trackId: `t${index}`, path: `T${index}`, executor, subtracks: [] })) }] } };
    try {
      await lights.stop(song, 'stop');
      await vi.advanceTimersByTimeAsync(5000); await lights.readBacksSettled();
      expect(offs).toEqual(['1000.1', '1000.101', '1000.191']);
      expect(logins).toEqual([]);
      expect(reads).toEqual([]);
      // The fader view connected, the plugin still chosen: the Button area is still not read, nor logged in to.
      await service.connect(connect);
      await lights.stop(song, 'stop');
      await vi.advanceTimersByTimeAsync(5000); await lights.readBacksSettled();
      expect(logins).toEqual(['faders']);
      expect(reads).toEqual([]);
      expect(lights.owed()).toEqual([]);
    } finally { lights.close(); service.close(); vi.useRealTimers(); }
  });
  it('没人选过时走控台插件；通道只因为操作员选择或重新连接而变', async () => {
    const { service, console } = await rig();
    try {
      await service.connect(connect);
      expect(service.keyChannel(request, 101)).toBe('plugin');
      // Errors and the fader view logging in again change nothing.
      await expect(service.inputButton(key('11111111-1111-4111-8111-111111111111'))).rejects.toThrow('通道变了');
      service.close();
      await service.read({ ...request, page: 1000, start: 1 });
      expect(service.keyChannel(request, 101)).toBe('plugin');
      // The operator's choice, read on the spot.
      await service.chooseKeys('webRemote');
      expect(service.keyChannel(request, 101)).toBe('webRemote');
      // Connecting again, when the console no longer reads back.
      console.answer = () => new Error('控台返回的 Button 区格号和请求的不一致');
      await service.connect(connect);
      expect(service.buttonChannel(request)).toMatchObject({ kind: 'plugin', choice: 'webRemote' });
      await service.chooseKeys('plugin');
      console.answer = () => [flash];
      await service.connect(connect);
      expect(service.keyChannel(request, 101)).toBe('plugin');
    } finally { service.close(); }
  });
  it('按键超时、断线、这一格对不上都只记下原因；推杆页自己重新登录也不重新选，只有操作员点“连接”才再读一次', async () => {
    const { service, console, reads } = await rig();
    try {
      await service.chooseKeys('webRemote');
      await service.connect(connect);
      expect(service.keyChannel(request, 101)).toBe('webRemote');
      // The show runs; the Button area stops answering, then answers with another executor.
      vi.useFakeTimers({ toFake: ['Date'] });
      const later = (): void => { vi.setSystemTime(Date.now() + 1001); };
      later();
      console.answer = () => new Error('实时推杆读取超时，请重新连接');
      await expect(service.inputButton(key('11111111-1111-4111-8111-111111111111'))).rejects.toThrow('超时');
      console.answer = () => [{ ...flash, name: 'Other' }];
      await expect(service.inputButton(key('22222222-2222-4222-8222-222222222222'))).rejects.toThrow('按键没有发送');
      later();
      await expect(service.inputButton(key('33333333-3333-4333-8333-333333333333'))).rejects.toThrow('按键没有发送');
      expect(service.keyChannel(request, 101)).toBe('webRemote');
      expect(service.buttonChannel(request).reason).toContain('通道不变');
      // A key the page made for the plugin is not sent on the web remote either.
      await expect(service.inputButton({ ...key('44444444-4444-4444-8444-444444444444'), channel: 'plugin' })).rejects.toThrow('通道变了');
      // The fader view logs in again with the saved user: the channel stays and the Button area is not read to choose.
      service.close();
      console.answer = () => [];
      const before = reads.length;
      await service.read({ ...request, page: 1000, start: 1 });
      expect(reads.length).toBe(before);
      expect(service.keyChannel(request, 101)).toBe('webRemote');
      // Only the operator's "连接" reads again, and then what the console answers decides.
      await service.connect(connect);
      expect(service.keyChannel(request, 101)).toBe('plugin');
    } finally { service.close(); vi.useRealTimers(); }
  });
});
