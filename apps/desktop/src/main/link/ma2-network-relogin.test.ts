import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OUTPUT_RECOVERY_RULES, isShowWait, type ShowState } from '@tb/core/link';
import { createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, type LightingDocument } from '@tb/schema';
import { Ma2NetworkManager } from './ma2-network-manager';
import { LightingOffService } from './lighting-off-service';
import type { Ma2ReloginClock, Ma2ReloginLog } from './ma2-relogin';
import { idleShow, pausedShow, runningShow, showReader } from './fixtures/show-gates';

// M5 (2026-11-10 第 2 题): the Telnet line to the console, dropped by itself while the show is on, logs in again on its
// own with the saved login only, on the waits 1, 2, 4, 8, 15, 30, 30 … s and within the table's five minutes
// (`ma2.relogin`); it never reads the console again (2026-10-30) and never installs the plugin during the show.
const memory = vi.hoisted(() => ({
  file: null as string | null, lines: [] as string[], connects: 0, version: '3.3.4.3', show: 'TEST', generation: 'one',
  login: 'ok' as 'ok' | 'unreachable' | 'refused' | 'silent', drop: (): void => undefined, bridge: 'ready' as 'ready' | 'missing' | 'old' | 'foreign', installs: 0
}));
vi.mock('node:fs/promises', () => ({ readFile: () => memory.file === null ? Promise.reject(Object.assign(new Error('Missing'), { code: 'ENOENT' })) : Promise.resolve(memory.file) }));
vi.mock('./atomic-file', () => ({ writeFileAtomically: (_path: string, value: string) => { memory.file = value; return Promise.resolve(); } }));
vi.mock('./ma2-bridge-installer', () => ({
  readMa2NetworkBridge: () => Promise.resolve(memory.bridge),
  ensureMa2NetworkBridge: () => { memory.installs += 1; memory.bridge = 'ready'; memory.generation = 'installed'; return Promise.resolve(); }
}));
vi.mock('./ma2-telnet', async (importOriginal) => {
  const original = await importOriginal<typeof import('./ma2-telnet')>();
  return { ...original, Ma2Telnet: class {
    state = 'disconnected';
    readTraffic() { return { wireCommands: 0, sentBytes: 0, receivedBytes: 0, queueMs: 0 }; }
    constructor(_address: unknown, private readonly onState: (state: 'disconnected', cause?: Error) => void) {}
    async connect(): Promise<string> {
      memory.connects += 1;
      await Promise.resolve();
      if (memory.login === 'unreachable') throw new original.Ma2UnreachableError('MA2 命令端口连接失败：192.0.2.1:30000（EHOSTUNREACH）');
      if (memory.login === 'refused') throw new original.Ma2LoginRefusedError('已找到控台，但控台还没开启远程连接。请在控台设置里开启远程登录，再连接。');
      if (memory.login === 'silent') throw new Error('MA2 网络端口已经连通，但登录没有成功。请检查登录用户、密码和 Telnet 的 Login Enabled 设置，不需要改电脑 IP');
      this.state = 'connected';
      memory.drop = () => { this.state = 'disconnected'; this.onState('disconnected', new Error('MA2 网络连接断开了，没确认的操作不会自动重试')); };
      return memory.version;
    }
    command(line: string, match: (text: string) => string | null, beforeSend?: (wait: { waitedMs: number; runningKind: string | null; sentBefore: number }) => void): Promise<string> {
      memory.lines.push(line);
      beforeSend?.({ waitedMs: 0, runningKind: null, sentBefore: 0 });
      const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
      const check = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
      if (check) return Promise.resolve(match(`${check}:${hex(memory.show)},${hex(memory.generation)},${hex(memory.version)}\r\n`) ?? '');
      const rpc = /TBLINK_NET\('([a-f0-9]{32})'/.exec(line)?.[1];
      if (rpc) return Promise.resolve(match(`TBLINK_RPC_${rpc}:ACK\r\n`) ?? '');
      const play = /TBLINK_PLAY_[a-f0-9]{32}/.exec(line)?.[0];
      return Promise.resolve(play ? match(`${play}:SENT\r\n`) ?? 'SENT' : 'ACK');
    }
    disconnect(): void { if (this.state !== 'disconnected') { this.state = 'disconnected'; this.onState('disconnected'); } }
  } };
});

const settings = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'lighting', autoConnect: false };
const network = { host: settings.host, port: settings.port, monitorPort: settings.monitorPort, username: settings.username };
const LIMIT_TEXT = OUTPUT_RECOVERY_RULES['ma2.relogin'].limitText;

/** A clock moved by hand: `pass` runs every wait that falls due, each with what it started (a login and its answers). */
function handClock(): Ma2ReloginClock & { pass(ms: number): Promise<void> } {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    after(ms, run) { const timer = { at: now + ms, run, live: true }; timers.push(timer); return () => { timer.live = false; }; },
    async pass(ms) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at; next.live = false; next.run(); await settle();
      }
      now = end; await settle();
    }
  };
}
const settle = async (): Promise<void> => { for (let turn = 0; turn < 30; turn += 1) await new Promise<void>(resolve => { setImmediate(resolve); }); };
/** The secure store; `broken` stands for one Windows cannot open any more. */
function secretStore() {
  const values = new Map<string, string>();
  const store = { broken: false, hasCredential: (id: string) => Promise.resolve(values.has(id)), saveCredential: (id: string, value: string) => { values.set(id, value); return Promise.resolve(); },
    loadCredential: (id: string) => store.broken ? Promise.reject(new Error('Windows 安全存储打不开')) : values.has(id) ? Promise.resolve(values.get(id)!) : Promise.reject(new Error('Credential missing')) };
  return store;
}

async function rig(options: { bridge?: string } = {}) {
  let show: ShowState = idleShow;
  const clock = handClock();
  const notices: string[] = [];
  const secrets = secretStore();
  const manager = new Ma2NetworkManager(process.cwd(), secrets, showReader(() => show), options.bridge, undefined, undefined, undefined, (_level, message) => notices.push(message), clock);
  const logs: Ma2ReloginLog[] = [];
  manager.onReloginLog(entry => logs.push(entry));
  await manager.save({ settings, password: 'console-secret' });
  await manager.connect();
  expect(manager.status().state).toBe('connected');
  // The operator's connect while stopped installs as before; from here on only what logging in again does counts.
  memory.installs = 0;
  return { manager, clock, logs, notices, breakStore: () => { secrets.broken = true; }, setShow: (next: ShowState) => { show = next; manager.showChanged(); },
    sinceDrop: () => { const from = memory.lines.length; return () => memory.lines.slice(from); } };
}

beforeEach(() => {
  memory.file = null; memory.lines = []; memory.connects = 0; memory.version = '3.3.4.3'; memory.show = 'TEST'; memory.generation = 'one';
  memory.login = 'ok'; memory.bridge = 'ready'; memory.installs = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe('演出中控台断了只自动重新登录（M5，2026-11-10 第 2 题）', () => {
  it('时间码在走时断线：照 1、2、4、8 秒的间隔用保存的登录重新登，每次一条日志，是等待不标红；登上换连接编号', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      const first = f.manager.status().connection!;
      memory.login = 'unreachable';
      memory.drop();
      expect(f.manager.status()).toMatchObject({ state: 'disconnected', error: null, relogin: { kind: 'relogin', attempt: 1 } });
      // Attempts at 1, 3, 7 s after the drop; then the console answers again at 15 s.
      const connects: number[] = [];
      for (const wait of [1000, 2000, 4000]) { await f.clock.pass(wait); connects.push(memory.connects); }
      expect(connects).toEqual([2, 3, 4]);
      expect(f.manager.status().relogin).toMatchObject({ kind: 'relogin', attempt: 4 });
      memory.login = 'ok';
      await f.clock.pass(8000);
      expect(memory.connects).toBe(5);
      const status = f.manager.status();
      expect(status).toMatchObject({ state: 'connected', error: null }); expect(status.relogin).toBeUndefined();
      expect(status.connection).not.toBe(first);
      expect(f.logs.map(entry => [entry.level, entry.result, entry.details.attempt])).toEqual([['info', 'queued', 1], ['info', 'queued', 2], ['info', 'queued', 3], ['info', 'queued', 4], ['info', 'succeeded', 4]]);
      expect(f.logs[0]!.message).toBe('控台断开了，第 1 次自动重新登录：已经断了 1 秒，最多试 5 分钟。断开的原因：MA2 网络连接断开了，没确认的操作不会自动重试');
      expect(f.logs[1]!.message).toMatch(/^控台断开了，第 2 次自动重新登录：已经断了 3 秒，最多试 5 分钟。上一次没登上：MA2 命令端口连接失败/);
      expect(f.logs.at(-1)!.message).toBe('控台自动重新登录成功：第 4 次登上，断了 15 秒。没有重新读取控台，关灯和按键照常');
      expect(f.logs[0]!.details).toMatchObject({ session: 'console', limitMs: 300_000 });
      // The next outage counts from the first wait again; a pause is not idle either.
      f.setShow(pausedShow);
      memory.drop();
      await f.clock.pass(1000);
      expect(f.manager.status().state).toBe('connected');
      expect(f.logs.at(-1)).toMatchObject({ result: 'succeeded', details: { attempt: 1 } });
    } finally { f.manager.disconnect(); }
  });

  it('登上以后只登录和两条短核对：不读目录、页面、歌曲和时间线，不同步，不装插件', async () => {
    const f = await rig({ bridge: 'bundled bridge source' });
    try {
      f.setShow(runningShow);
      const request = vi.spyOn(f.manager.get(network).bridge, 'request');
      const sent = f.sinceDrop();
      memory.drop();
      await f.clock.pass(1000);
      expect(f.manager.status().state).toBe('connected');
      // The one line after the login: which Show and plugin session the console has (the plugin check is the installer's).
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatch(/TBLINK_SHOWCHECK_/);
      expect(sent().some(line => /TBLINK_NET\(/.test(line))).toBe(false);
      expect(request).not.toHaveBeenCalled();
      expect(memory.installs).toBe(0);
      // Nothing reads later on its own either.
      await f.clock.pass(10 * 60_000);
      expect(sent()).toHaveLength(1);
    } finally { f.manager.disconnect(); }
  });

  it('停着时断了照旧按原来的办法恢复；恢复还没成功时演出开始了，从这一刻起只自动重新登录，照表里的上限', async () => {
    const f = await rig();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      memory.login = 'unreachable';
      memory.drop();
      expect(f.manager.status().relogin).toBeUndefined();
      expect(f.manager.status().error).toBe('MA2 连接已断开，正在恢复；编辑继续保存在本地');
      await vi.advanceTimersByTimeAsync(1000); await settle();
      expect(memory.connects).toBe(2);
      f.setShow(runningShow);
      await vi.advanceTimersByTimeAsync(2000); await settle();
      expect(memory.connects).toBe(2);
      expect(f.manager.status()).toMatchObject({ error: null, relogin: { kind: 'relogin', attempt: 1 } });
      memory.login = 'ok';
      await f.clock.pass(1000);
      expect(f.manager.status().state).toBe('connected');
      expect(f.logs.map(entry => entry.result)).toEqual(['queued', 'succeeded']);
      // The old waits do not go on beside it.
      await vi.advanceTimersByTimeAsync(10 * 60_000); await settle();
      expect(memory.connects).toBe(3);
    } finally { f.manager.disconnect(); }
  });

  it('操作员自己断开：不自动重新登录；停着时断线照旧按原来的办法恢复', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      memory.drop();
      expect(f.manager.status().relogin).toMatchObject({ kind: 'relogin' });
      await f.manager.disconnectByOperator();
      await f.clock.pass(10 * 60_000);
      expect(memory.connects).toBe(1);
      expect(f.manager.status()).toMatchObject({ state: 'disconnected' }); expect(f.manager.status().relogin).toBeUndefined();
      expect(f.logs).toEqual([]);
      // Not connected in this run (or disconnected by the operator): a connect during the show still waits for the stop.
      await expect(f.manager.connect()).rejects.toThrow('演出还没停止');
    } finally { f.manager.disconnect(); }
  });

  it.each([
    ['控台没开远程登录', () => { memory.login = 'refused'; }, '还没开启远程连接'],
    ['连上的是另一台控台', () => { memory.version = '3.9.60.74'; }, '连上的不是原来那台控台'],
    ['控台上的 Show 换了', () => { memory.show = 'OTHER'; }, '控台上的 Show 换了'],
  ])('%s：马上停下写明原因，等人处理，不再试', async (_name, change, words) => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      change();
      memory.drop();
      await f.clock.pass(1000);
      const status = f.manager.status();
      expect(status.state).toBe('disconnected');
      expect(status.relogin).toMatchObject({ kind: 'stopped', limit: false });
      expect(status.relogin?.reason).toContain(words); expect(status.error).toContain(words);
      expect(f.logs.map(entry => [entry.level, entry.result])).toEqual([['info', 'queued'], ['error', 'failed']]);
      expect(f.logs[1]!.message).toMatch(/^控台没有再自动重新登录：/);
      await f.clock.pass(10 * 60_000);
      expect(memory.connects).toBe(2);
    } finally { f.manager.disconnect(); }
  });

  it('安全存储里的密码读不出来：马上停下写明原因，不降级、不试空密码', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      f.breakStore();
      memory.drop();
      await f.clock.pass(1000);
      expect(f.manager.status().relogin).toMatchObject({ kind: 'stopped', limit: false });
      expect(f.manager.status().relogin?.reason).toMatch(/^保存的控台密码读不出来（Windows 安全存储打不开）/);
      // No login was tried with anything else.
      expect(memory.connects).toBe(1);
      await f.clock.pass(10 * 60_000);
      expect(memory.connects).toBe(1);
    } finally { f.manager.disconnect(); }
  });

  it('一次断线 5 分钟还没登上：停下标红，用表里的话，每次一条日志、到上限一条错误，之后不再试', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      memory.login = 'unreachable';
      memory.drop();
      await f.clock.pass(6 * 60_000);
      const status = f.manager.status();
      expect(status.relogin).toEqual({ kind: 'stopped', reason: LIMIT_TEXT, limit: true });
      expect(status.error).toBe(LIMIT_TEXT);
      const attempts = memory.connects - 1;
      expect(f.logs.filter(entry => entry.result === 'queued')).toHaveLength(attempts);
      expect(f.logs.filter(entry => entry.level === 'error')).toEqual([expect.objectContaining({ result: 'failed', message: `${LIMIT_TEXT}（试了 ${attempts} 次）` })]);
      await f.clock.pass(10 * 60_000);
      expect(memory.connects - 1).toBe(attempts);
    } finally { f.manager.disconnect(); }
  });

  it('登录没等到回应（控台还在启动，或者用户、密码对不上）：不算控台拒绝，接着试并写明原因；控台好了就登上', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      memory.login = 'silent';
      memory.drop();
      await f.clock.pass(1000); await f.clock.pass(2000);
      const waiting = f.manager.status();
      expect(waiting).toMatchObject({ state: 'disconnected', error: null, relogin: { kind: 'relogin', attempt: 3 } });
      expect(waiting.relogin?.kind === 'relogin' ? waiting.relogin.reason : '').toContain('登录没有成功');
      memory.login = 'ok';
      await f.clock.pass(4000);
      const status = f.manager.status();
      expect(status).toMatchObject({ state: 'connected', error: null }); expect(status.relogin).toBeUndefined();
      expect(f.logs.map(entry => [entry.level, entry.result])).toEqual([['info', 'queued'], ['info', 'queued'], ['info', 'queued'], ['info', 'succeeded']]);
    } finally { f.manager.disconnect(); }
  });

  it('演出中操作员点连接：盖过自动重新登录，次数清零；没登上就写原因，不自己再试', async () => {
    const f = await rig();
    try {
      f.setShow(runningShow);
      memory.login = 'unreachable';
      memory.drop();
      await f.clock.pass(1000); await f.clock.pass(2000);
      expect(f.manager.status().relogin).toMatchObject({ attempt: 3 });
      memory.login = 'ok';
      await f.manager.connect();
      expect(f.manager.status()).toMatchObject({ state: 'connected', error: null });
      expect(f.manager.status().relogin).toBeUndefined();
      const connects = memory.connects;
      // The attempt that was waiting is gone.
      await f.clock.pass(10 * 60_000);
      expect(memory.connects).toBe(connects);
      // A later drop counts from 1 again.
      memory.drop();
      expect(f.manager.status().relogin).toMatchObject({ kind: 'relogin', attempt: 1 });
      await f.clock.pass(1000);
      expect(f.logs.at(-1)).toMatchObject({ result: 'succeeded', details: { attempt: 1 } });
      // The operator's own connect that does not get in: its reason, and nothing tried on its own.
      memory.login = 'unreachable';
      memory.drop();
      await f.manager.connect();
      expect(f.manager.status()).toMatchObject({ state: 'disconnected' });
      expect(f.manager.status().error).toContain('连接失败');
      const after = memory.connects;
      await f.clock.pass(10 * 60_000);
      expect(memory.connects).toBe(after);
    } finally { f.manager.disconnect(); }
  });
});

describe('插件在演出中不装（M5）', () => {
  it('重新登上时插件不见了：记下、状态写明是等待，用插件的先等着；演出停了才装，装好接着用', async () => {
    const f = await rig({ bridge: 'bundled bridge source' });
    try {
      f.setShow(runningShow);
      memory.bridge = 'missing'; memory.generation = '';
      memory.drop();
      await f.clock.pass(1000);
      const status = f.manager.status();
      expect(status.state).toBe('connected');
      expect(status.pluginWait).toMatch(/^演出还没停止，控台上的联动台插件不见了（控台载入过 Show 或重启过），停止以后会自动重新装上/);
      expect(status.error).toBeNull();
      expect(f.notices).toContain(status.pluginWait);
      let held: unknown = null;
      try { f.manager.get(network); } catch (error) { held = error; }
      expect(isShowWait(held)).toBe(true);
      expect(memory.installs).toBe(0);
      // Paused is still the show: no install.
      f.setShow(pausedShow); await settle();
      expect(memory.installs).toBe(0);
      f.setShow(idleShow); await settle();
      expect(memory.installs).toBe(1);
      expect(f.manager.status().pluginWait).toBeUndefined();
      expect(f.manager.get(network).bridge).toBeDefined();
      f.setShow(idleShow); await settle();
      expect(memory.installs).toBe(1);
    } finally { f.manager.disconnect(); }
  });
});

/** A song whose console timeline runs `executors` (as lighting-off-service.test.ts builds it). */
function document(executors: string[]): LightingDocument {
  const track = (index: number) => lightingTrackSchema.parse({ id: `track-${index}`, name: `Track ${index}`, kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>',
    baselineTracks: executors.map((_executor, index) => track(index)), mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return lightingDocumentSchema.parse({ ...createLightingDocument(), ma2Bindings: [binding] });
}
const lit = (itemId: string, executors: string[]) => ({ document: document(executors), song: { itemId, title: itemId } });

describe('重新登上以后的关灯（M5，接 01 R13）', () => {
  it('没发出去的关灯补发一次；读回还在运行的不补；之后不再补', async () => {
    const f = await rig();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const sent: string[] = [];
    const resending = vi.fn<(count: number) => void>();
    const lights = new LightingOffService({
      console: { getMa2NetworkStatus: () => Promise.resolve(f.manager.status()),
        playMa2Cue: async request => { await f.manager.playCue(request); if (request.action.target === 'executor') sent.push(request.action.executor); } },
      resending, failed: () => undefined,
      readBack: (_network, executors) => Promise.resolve(new Map(executors.map(executor => [executor, { verified: 'running' as const }])))
    });
    try {
      f.setShow(runningShow);
      // 1.102 went off and reads back still running (yellow, "再按停止才重发"); 1.103's Off cannot go out while the line is down.
      await lights.stop(lit('a', ['1.102']), 'stop');
      await vi.advanceTimersByTimeAsync(5000);
      expect(lights.owed()).toEqual([expect.objectContaining({ executor: '1.102', state: 'running' })]);
      await lights.change(null, lit('b', ['1.103']));
      memory.drop();
      await lights.change(lit('b', ['1.103']), null);
      expect(lights.owed().map(entry => [entry.executor, entry.state])).toEqual([['1.102', 'running'], ['1.103', 'failed']]);
      await f.clock.pass(1000);
      expect(f.manager.status().state).toBe('connected');
      await vi.advanceTimersByTimeAsync(1000); await settle();
      expect(resending).toHaveBeenCalledExactlyOnceWith(1);
      expect(sent).toEqual(['1.102', '1.103']);
      await vi.advanceTimersByTimeAsync(10_000); await f.clock.pass(60_000);
      expect(sent).toEqual(['1.102', '1.103']);
    } finally { lights.close(); f.manager.disconnect(); }
  });
});

describe('网页遥控跟着控台回来（M5）', () => {
  it('同一台控台、同一个 Show，只是插件会话变了：告诉网页遥控照旧；Show 变了就停下，不告诉', async () => {
    const f = await rig();
    try {
      const back = vi.spyOn(f.manager.live(), 'consoleBack');
      f.setShow(runningShow);
      memory.generation = '';
      memory.drop();
      await f.clock.pass(1000);
      expect(back).toHaveBeenCalledExactlyOnceWith({ show: 'TEST', generation: 'one', version: '3.3.4.3' }, { show: 'TEST', generation: '', version: '3.3.4.3' });
      memory.show = 'OTHER';
      memory.drop();
      await f.clock.pass(1000);
      expect(f.manager.status().relogin).toMatchObject({ kind: 'stopped' });
      expect(back).toHaveBeenCalledOnce();
    } finally { f.manager.disconnect(); }
  });
});
