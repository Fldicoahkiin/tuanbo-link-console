import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lightingReadBackLogs, type LightingReadBackResult } from '@tb/core/link';
import { createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, type LicenseStatus, type LightingDocument, type Ma2NetworkStatus, type Ma2PlaybackRequest } from '@tb/schema';
import { LightingOffService } from './lighting-off-service';
import { LicenseAccess } from './license-access';
import { Ma2LiveService } from './ma2-live-service';
import { Ma2WebRemoteConsole } from './fixtures/ma2-web-remote-console';
import { programLicense } from './program-license';

const settings = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false };
const off = (executor: string) => ({ target: 'executor', executor, action: 'off' }) as const;

/** A song whose console timeline runs `executors`, valid as the window sends it (link:lighting-off parses it). */
function document(executors: string[]): LightingDocument {
  const track = (index: number) => lightingTrackSchema.parse({ id: `track-${index}`, name: `Track ${index}`, kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>',
    baselineTracks: executors.map((_executor, index) => track(index)), mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return lightingDocumentSchema.parse({ ...createLightingDocument(), ma2Bindings: [binding] });
}
const lit = (itemId: string, title: string, executors: string[]) => ({ document: document(executors), song: { itemId, title } });

function fixture() {
  const status: Ma2NetworkStatus = { state: 'connected', settings: { ...settings }, passwordSaved: false, version: '3.3.4.3', error: null, connection: 1 };
  const playMa2Cue = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve());
  const failed = vi.fn<(message: string, song: { itemId: string; title: string } | null) => void>();
  const resending = vi.fn<(count: number) => void>();
  const service = new LightingOffService({ console: { getMa2NetworkStatus: () => Promise.resolve(status), playMa2Cue }, failed, resending });
  const executors = () => playMa2Cue.mock.calls.map(([request]) => request.action.target === 'executor' ? request.action.executor : '');
  return { status, playMa2Cue, failed, resending, service, executors };
}

afterEach(() => { vi.useRealTimers(); });

describe('换歌关灯（第 4 题）', () => {
  it('主进程跟随 P1（0.5.9 P3f）：换歌只关上一首独有的；跟着的歌在用的不被别人的停止关掉；停止关这首的并补发欠着的', async () => {
    const f = fixture();
    await expect(f.service.followChange(null, lit('a', '开场', ['1.101', '1.102']))).resolves.toEqual({ failed: [] });
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    await f.service.followChange(lit('a', '开场', ['1.101', '1.102']), lit('b', '返场', ['1.102', '1.103']));
    expect(f.executors()).toEqual(['1.101']);
    // The program stopping a song on 1.103 does not switch off what P1's song runs.
    await f.service.stop(lit('x', '串场', ['1.103', '1.104']), 'stop');
    expect(f.executors()).toEqual(['1.101', '1.104']);
    f.status.state = 'disconnected';
    await f.service.followStop(lit('b', '返场', ['1.102', '1.103']), 'stop');
    expect(f.service.owed().map(entry => [entry.executor, entry.cause])).toEqual([['1.102', 'stop'], ['1.103', 'stop']]);
    f.status.state = 'connected';
    // Nothing lit: the stop sends only what is still owed.
    await f.service.followStop(null, 'close');
    expect(f.executors()).toEqual(['1.101', '1.104', '1.102', '1.103']);
    expect(f.service.owed()).toEqual([]);
  });

  it('Off 等于上一首用到的减去下一首也用的；先发上一首独有的，同一个期限、停止优先', async () => {
    const f = fixture();
    await f.service.change(null, lit('a', '开场', ['1.101', '1.102']));
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    const before = Date.now();
    await expect(f.service.change(lit('a', '开场', ['1.101', '1.102']), lit('b', '返场', ['1.102', '1.103']))).resolves.toEqual({ failed: [] });
    expect(f.executors()).toEqual(['1.101']);
    expect(f.playMa2Cue.mock.calls[0]![0]).toMatchObject({ network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, action: off('1.101') });
    expect(f.playMa2Cue.mock.calls[0]![0].deadlineAt).toBeGreaterThanOrEqual(before + 7000);
    await f.service.stop(lit('b', '返场', ['1.102', '1.103']), 'stop');
    expect(f.executors()).toEqual(['1.101', '1.102', '1.103']);
    expect(f.service.owed()).toEqual([]);
  });

  it('正在用的执行器绝不关：停止后马上播同一个执行器的歌，没发出去的 Off 不再补', async () => {
    const f = fixture(); f.status.state = 'disconnected';
    await expect(f.service.stop(lit('a', '开场', ['1.101']), 'stop')).resolves.toEqual({ failed: [{ song: { itemId: 'a', title: '开场' }, reason: '没有连接控台，连上以后会自动补发一次' }] });
    await f.service.change(null, lit('b', '返场', ['1.101']));
    expect(f.service.owed()).toEqual([]);
    // The editor's own preview runs it too: a program stop does not switch off what the preview uses.
    await f.service.receive({ version: 1, source: 'preview', phase: 'start', document: document(['1.104']), song: null });
    f.status.state = 'connected';
    await f.service.stop(lit('b', '返场', ['1.101', '1.104']), 'stop');
    expect(f.executors()).toEqual(['1.101']);
  });
});

describe('没发出去的关灯留在清单里', () => {
  it('控台没连上时留着；连上（新的连接编号）以后补发 1 次，记日志；补发也失败就标红、留着，不再自己发', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.status.state = 'disconnected';
    await f.service.stop(lit('a', '开场', ['1.101']), 'stop');
    expect(f.service.quitMessages()).toEqual(['「开场」的灯光没能完全关闭，控台上可能还亮着。原因：没有连接控台，连上以后会自动补发一次。请在控台上关掉这首歌的执行器。']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    f.status.state = 'connected'; f.status.connection = 2;
    f.playMa2Cue.mockRejectedValueOnce(new Error('MA2 没有回应'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.resending).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.executors()).toEqual(['1.101']);
    expect(f.failed).toHaveBeenCalledExactlyOnceWith('「开场」的灯光没能完全关闭，控台上可能还亮着。原因：MA2 没有回应。关灯补发了一次控台还是没确认，已留在还欠着的关灯里。请检查控台后再按一次停止。', { itemId: 'a', title: '开场' });
    f.status.connection = 3;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.playMa2Cue).toHaveBeenCalledOnce();
    expect(f.service.owed()).toMatchObject([{ executor: '1.101', state: 'failed', reason: 'MA2 没有回应' }]);
    // Pressing stop again sends it once more: the operator asked.
    await f.service.stop(null, 'stop');
    expect(f.executors()).toEqual(['1.101', '1.101']);
    expect(f.service.owed()).toEqual([]);
    f.service.close();
  });

  it('发送失败的原因只写原因；连着的不是原来那台控台时不发', async () => {
    const f = fixture();
    f.playMa2Cue.mockRejectedValueOnce(new Error('MA2 telnet timeout'));
    await expect(f.service.stop(lit('a', '开场', ['1.101']), 'stop')).resolves.toEqual({ failed: [{ song: { itemId: 'a', title: '开场' }, reason: '操作超时了' }] });
    f.status.settings = { ...settings, host: '192.0.2.2' };
    await expect(f.service.stop(null, 'stop')).resolves.toEqual({ failed: [{ song: { itemId: 'a', title: '开场' }, reason: '现在连着的不是原来那台控台，关灯指令没有发送' }] });
    expect(f.playMa2Cue).toHaveBeenCalledOnce();
    f.service.close();
  });

  it('关灯正在发时算“还在停止”，回应以后不算；没发出去、等控台的不挡演出状态', async () => {
    const f = fixture();
    let answer!: () => void;
    f.playMa2Cue.mockImplementationOnce(() => new Promise<void>(resolve => { answer = resolve; }));
    const changes = vi.fn(); f.service.onChanged(changes);
    const stopping = f.service.stop(lit('a', '开场', ['1.101']), 'stop');
    expect(f.service.sending()).toBe(true);
    await vi.waitFor(() => expect(f.playMa2Cue).toHaveBeenCalledOnce());
    answer(); await stopping; await f.service.settled();
    expect(f.service.sending()).toBe(false);
    expect(changes).toHaveBeenCalled();
    f.status.state = 'disconnected';
    await f.service.stop(lit('a', '开场', ['1.101']), 'stop');
    expect(f.service.sending()).toBe(false);
    f.service.close();
  });
});

describe('试听和节目用同一张清单', () => {
  it('试听停止欠的 Off 和节目的在一张清单里；退出时一起问；试听停止不重发节目的', async () => {
    const f = fixture(); f.status.state = 'disconnected';
    await f.service.stop(lit('a', '开场', ['1.101']), 'stop');
    const result = await f.service.receive({ version: 1, source: 'preview', phase: 'stop', document: document(['1.105']), song: null });
    expect(result.failed).toHaveLength(1);
    expect(f.service.owed().map(entry => [entry.executor, entry.cause])).toEqual([['1.101', 'stop'], ['1.105', 'preview']]);
    expect(f.service.quitMessages()).toHaveLength(2);
    f.status.state = 'connected';
    await f.service.receive({ version: 1, source: 'preview', phase: 'stop', document: document([]), song: null });
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    // Following P1 is the main process's own (0.5.9 P4): the window has no P1 stop to send here any more.
    await expect(f.service.receive({ version: 1, source: 'p1', phase: 'stop', document: document(['1.106']), song: { itemId: 'p', title: 'P1 的歌' } })).rejects.toThrow();
    f.service.close();
  });

  it('试听暂停以后不再占着执行器：节目停同一个执行器的歌，Off 照发；暂停本身不发 Off', async () => {
    const f = fixture();
    await f.service.receive({ version: 1, source: 'preview', phase: 'start', document: document(['1.101']), song: null });
    await f.service.receive({ version: 1, source: 'preview', phase: 'pause', document: document(['1.101']), song: null });
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    await f.service.stop(lit('a', '开场', ['1.101']), 'stop');
    expect(f.executors()).toEqual(['1.101']);
  });

  it('界面没了（退出或重新加载）：它的试听正在用的执行器补上 Off；没发出去的标红、留在清单里；没在用的不发', async () => {
    const f = fixture();
    await f.service.receive({ version: 1, source: 'preview', phase: 'start', document: document(['1.101', '1.102']), song: null });
    f.service.pageGone();
    await f.service.settled();
    expect(f.executors()).toEqual(['1.101', '1.102']);
    expect(f.service.owed()).toEqual([]);
    // Gone again with nothing running: nothing is sent.
    f.service.pageGone();
    await f.service.settled();
    expect(f.playMa2Cue).toHaveBeenCalledTimes(2);
    // A preview running while the console is away: owed, and said in red once.
    f.status.state = 'disconnected';
    await f.service.receive({ version: 1, source: 'preview', phase: 'start', document: document(['1.103']), song: null });
    f.service.pageGone();
    await f.service.settled();
    await vi.waitFor(() => expect(f.failed).toHaveBeenCalledExactlyOnceWith('这首歌的灯光没能完全关闭，控台上可能还亮着。原因：没有连接控台，连上以后会自动补发一次。请在控台上关掉这首歌的执行器。', null));
    expect(f.service.owed().map(entry => entry.executor)).toEqual(['1.103']);
    f.service.close();
  });

  it('Off 免授权：授权到期时，经后台节目的授权接法（program-license.ts）照发', async () => {
    const send = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve());
    const expired: LicenseStatus = { machineCode: `TB1-${'A'.repeat(64)}`, state: 'expired', message: '授权已到期；工程文件不受影响', enforcement: 'required', onlineAvailable: true, claims: null };
    const access = new LicenseAccess(() => Promise.resolve(expired));
    const status: Ma2NetworkStatus = { state: 'connected', settings, passwordSaved: false, version: '3.3.4.3', error: null, connection: 1 };
    const wiring = programLicense({ access, changing: () => false }, { ready: Promise.resolve(), status: () => status, send }, () => undefined);
    const service = new LightingOffService({ console: wiring.network, failed: () => undefined, resending: () => undefined });
    await expect(service.stop(lit('a', '开场', ['1.101']), 'stop')).resolves.toEqual({ failed: [] });
    await expect(service.receive({ version: 1, source: 'preview', phase: 'stop', document: document(['1.102']), song: null })).resolves.toEqual({ failed: [] });
    expect(send.mock.calls.map(([request]) => request.action)).toEqual([off('1.101'), off('1.102')]);
    service.close();
  });
});

// M8 (2026-11-11): the Offs one send confirmed are read back as one round on a web remote session already connected and
// only borrowed (Ma2LiveService.readBack), behind the real live service and the real web remote client, on a fake
// console. LIGHTING_OFF_READ_BACK: 1.5 s, then 3 s. The "console follows" check reads page 9 every second meanwhile.
describe('关灯读回（M8）', () => {
  const source = { show: 'TEST', generation: '1', version: '3.3.4.3' };
  const network = { host: settings.host, port: settings.port, monitorPort: settings.monitorPort, username: settings.username };
  const connect = (page: number) => ({ network, expectedSource: source, username: 'web', password: 'web-secret', page, start: 1 });
  const opening = { itemId: 'a', title: '开场' };
  /** `saved`: the web remote user was saved on this computer (the fader view connected once), as the "console follows"
   * check needs; without it nothing is connected, the default. */
  async function rig(saved = true) {
    const ma2 = new Ma2WebRemoteConsole();
    ma2.delayMs = 300;
    ma2.running.set('9.1', true);
    const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
    const telnet = { command: (line: string, match: (text: string) => string | null) => {
      const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
      return Promise.resolve(marker ? match(`${marker}:${hex(source.show)},${hex(source.generation)},${hex(source.version)}\r\n`) ?? '' : 'ACK');
    } };
    const dir = await mkdtemp(join(tmpdir(), 'tblink-lights-off-read-back-'));
    if (saved) await writeFile(join(dir, 'profiles.json'), JSON.stringify([{ host: settings.host, username: 'web' }]));
    const live = new Ma2LiveService(join(dir, 'profiles.json'), { saveCredential: () => Promise.resolve(), loadCredential: () => Promise.resolve('web-secret') }, () => telnet,
      () => ma2.playback('web'), () => ma2.playback('faders'));
    const status: Ma2NetworkStatus = { state: 'connected', settings: { ...settings }, passwordSaved: false, version: '3.3.4.3', error: null, connection: 1 };
    const playMa2Cue = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve());
    const failed = vi.fn<(message: string, song: { itemId: string; title: string } | null) => void>();
    const verified = vi.fn<(results: readonly LightingReadBackResult[]) => void>();
    const service = new LightingOffService({ console: { getMa2NetworkStatus: () => Promise.resolve(status), playMa2Cue }, failed, resending: () => undefined,
      readBack: (target, executors) => live.readBack(target, executors), verified });
    const follows: string[] = [];
    let poll: ReturnType<typeof setInterval> | null = null;
    return { ma2, live, status, service, playMa2Cue, failed, verified, follows,
      /** The fader view on `page`, connected as the operator does, in real time. */
      faders: (page = 1000) => live.connect(connect(page)),
      /** The "console follows" session, opened as a playing song opens it (it reads page 9 here). */
      observer: () => live.observe({ network, page: 9, slot: 1 }),
      /** Fake time from here; with `follow`, the "console follows" check reads every second, as while a song plays. */
      play: (follow = true) => {
        vi.useFakeTimers();
        if (follow) poll = setInterval(() => { void live.observe({ network, page: 9, slot: 1 }).then(found => follows.push(found.kind), (error: unknown) => follows.push(`失败：${String(error)}`)); }, 1000);
      },
      /** Every read-back of what was sent so far, with both waits run out. */
      readBacks: async (): Promise<void> => { await vi.advanceTimersByTimeAsync(8000); await service.readBacksSettled(); },
      /** The read-back's own requests: everything but the "console follows" check on page 9. */
      reads: () => ma2.requests.filter(request => !request.endsWith(' 9.1')),
      logs: () => verified.mock.calls.flatMap(([results]) => lightingReadBackLogs(results).map(log => log.message)),
      close: () => { if (poll) clearInterval(poll); service.close(); live.close(); } };
  }

  it('一首歌跨两个范围、两页，停止和换歌各一次，“在不在跟”每秒在同一条会话上读：轮询一次不失败，会话一直连着，每轮每个范围一个请求，日志按歌一行', async () => {
    const f = await rig();
    try {
      for (const executor of ['1.1', '1.20', '2.5', '3.1']) f.ma2.running.set(executor, false);
      await f.observer();
      f.play();
      const song = lit('a', '开场', ['1.1', '1.20', '2.5']), next = lit('b', '返场', ['3.1']);
      await f.service.stop(song, 'stop');
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1', 'web 1.16', 'web 2.1']);
      expect(f.logs()).toEqual(['控台读回已关：「开场」的执行器 1.1、1.20、2.5']);
      // A song change: its read-back lands while the next song plays; 1.20 still runs at the first read only.
      f.ma2.requests.length = 0; f.verified.mockClear();
      await f.service.change(null, song);
      f.ma2.running.set('1.20', true);
      await f.service.change(song, next);
      await vi.advanceTimersByTimeAsync(2500);
      f.ma2.running.set('1.20', false);
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1', 'web 1.16', 'web 2.1', 'web 1.16']);
      expect(f.verified).toHaveBeenCalledOnce();
      expect(f.verified.mock.calls[0]![0].map(result => [result.executor, result.verified, result.during])).toEqual([['1.1', 'off', true], ['2.5', 'off', true], ['1.20', 'off', true]]);
      expect(f.follows.length).toBeGreaterThan(10);
      expect(f.follows.every(kind => kind === 'executor')).toBe(true);
      expect(f.ma2.logins).toEqual(['web']);
      expect(f.service.owed()).toEqual([]);
    } finally { f.close(); }
  });

  it('第一次读到还在跑的只再读它那个范围，第二次关了就划掉；两次都在跑就留着标黄、退出不问、再按停止重发；读回不重发 Off', async () => {
    const f = await rig();
    try {
      for (const executor of ['1.1', '1.2', '1.20']) f.ma2.running.set(executor, executor !== '1.1');
      await f.observer();
      f.play();
      await f.service.stop(lit('a', '开场', ['1.1', '1.2', '1.20']), 'stop');
      await vi.advanceTimersByTimeAsync(2500);
      f.ma2.running.set('1.2', false);
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1', 'web 1.16', 'web 1.1', 'web 1.16']);
      expect(f.logs()).toEqual(['控台读回已关：「开场」的执行器 1.1、1.2',
        '关灯已发出，但控台读回「开场」的执行器 1.20 还在运行（也可能是关灯的渐变还没走完）。再按一次停止会重发。']);
      expect(f.playMa2Cue).toHaveBeenCalledTimes(3);
      expect(f.service.owed()).toMatchObject([{ executor: '1.20', state: 'running' }]);
      expect(f.service.check()).toEqual({ running: [{ executor: '1.20', song: opening }], unconfirmed: [] });
      expect(f.service.quitMessages()).toEqual([]);
      expect(f.service.sending()).toBe(false);
      expect(f.failed).not.toHaveBeenCalled();
      // No third read; a new connection does not send it.
      f.status.connection = 2;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.reads()).toHaveLength(4);
      f.ma2.running.set('1.20', false);
      await f.service.stop(null, 'stop');
      expect(f.playMa2Cue).toHaveBeenCalledTimes(4);
      await f.readBacks();
      expect(f.service.owed()).toEqual([]);
      expect(f.follows.every(kind => kind === 'executor')).toBe(true);
    } finally { f.close(); }
  });

  it('读回读到看不懂的回答：借来的会话照旧连着，下一次“在不在跟”照常；算无法确认，状态详情一句、日志一行', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1.1', false); f.ma2.running.set('1.2', false);
      await f.observer();
      f.play();
      await f.service.stop(lit('a', '开场', ['1.1', '1.2']), 'stop');
      f.ma2.garble = { page: 1, count: 1 };
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1']);
      expect(f.service.check()).toEqual({ running: [], unconfirmed: [{ executor: '1.1', song: opening, reason: '控台返回了其他页面的数据' }, { executor: '1.2', song: opening, reason: '控台返回了其他页面的数据' }] });
      expect(f.logs()).toEqual(['关灯读回无法确认：「开场」的执行器 1.1、1.2。原因：控台返回了其他页面的数据']);
      expect(f.failed).not.toHaveBeenCalled();
      const before = f.follows.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.follows.length).toBeGreaterThan(before);
      expect(f.follows.every(kind => kind === 'executor')).toBe(true);
      expect(f.ma2.logins).toEqual(['web']);
      // An empty slot is no answer either.
      f.verified.mockClear();
      await f.service.stop(lit('a', '开场', ['1.3']), 'stop');
      await f.readBacks();
      expect(f.logs()).toEqual(['关灯读回无法确认：「开场」的执行器 1.3。原因：控台上 1.3 这一格是空的']);
    } finally { f.close(); }
  });

  it('只连着推杆页：读回对推杆页会话一个请求都不发，不写日志，界面照旧；推杆页自己的读取照常', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1000.1', true);
      await f.faders();
      f.play(false);
      f.ma2.requests.length = 0;
      await f.service.stop(lit('a', '开场', ['1000.1', '1000.101']), 'stop');
      await f.readBacks();
      expect(f.ma2.requests).toEqual([]);
      expect(f.verified).not.toHaveBeenCalled();
      expect(f.service.check()).toEqual({ running: [], unconfirmed: [] });
      const reading = f.live.read({ network, expectedSource: source, page: 1000, start: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      await expect(reading).resolves.toMatchObject({ items: [{ slot: 1, running: true }] });
      expect(f.ma2.requests).toEqual(['faders 1000.1']);
    } finally { f.close(); }
  });

  it('默认配置（没连网页遥控）停一首 10 个执行器的歌：一个请求都不发，0 行读回日志，界面照旧', async () => {
    const f = await rig(false);
    try {
      f.play(false);
      const executors = Array.from({ length: 10 }, (_, index) => `1.${index + 1}`);
      await f.service.stop(lit('a', '开场', executors), 'stop');
      await f.readBacks();
      expect(f.playMa2Cue).toHaveBeenCalledTimes(10);
      expect(f.ma2.requests).toEqual([]);
      expect(f.ma2.logins).toEqual([]);
      expect(f.verified).not.toHaveBeenCalled();
      expect(f.service.check()).toEqual({ running: [], unconfirmed: [] });
    } finally { f.close(); }
  });

  it('Button 区：没选网页遥控就不读；选了、控台读回过 Button 区才在 Button 会话上读；191 以上不读', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1000.101', false); f.ma2.running.set('1000.191', false);
      await f.faders();
      await f.live.observe({ network, page: 9, slot: 1 });
      f.play();
      f.ma2.requests.length = 0;
      await f.service.stop(lit('a', '开场', ['1000.101', '1000.191']), 'stop');
      await f.readBacks();
      expect(f.reads()).toEqual([]);
      vi.useRealTimers();
      await f.live.chooseKeys('webRemote');
      f.play();
      f.ma2.requests.length = 0;
      await f.service.stop(lit('a', '开场', ['1000.101', '1000.191']), 'stop');
      await f.readBacks();
      expect(f.reads()).toEqual(['web#2 1000.101']);
      expect(f.logs()).toEqual(['控台读回已关：「开场」的执行器 1000.101']);
      // A read that times out closes the Button session, as any request's timeout does; after that nothing is read on it.
      f.ma2.delayMs = 5000; f.verified.mockClear();
      await f.service.stop(lit('a', '开场', ['1000.101']), 'stop');
      await f.readBacks();
      expect(f.logs()).toEqual(['关灯读回无法确认：「开场」的执行器 1000.101。原因：实时推杆读取超时，请重新连接']);
      f.ma2.delayMs = 5; f.verified.mockClear(); f.ma2.requests.length = 0;
      await f.service.stop(lit('a', '开场', ['1000.101']), 'stop');
      await f.readBacks();
      expect(f.reads()).toEqual([]);
      expect(f.verified).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('Off 发去的是另一台控台：“在不在跟”和 Button 会话都连着这台，也不读', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1000.1', false); f.ma2.running.set('1000.101', false);
      await f.faders();
      await f.live.chooseKeys('webRemote');
      await f.live.observe({ network, page: 9, slot: 1 });
      f.play(false);
      f.ma2.requests.length = 0;
      f.status.settings = { ...settings, host: '192.0.2.9' };
      await f.service.stop(lit('a', '开场', ['1000.1', '1000.101']), 'stop');
      await f.readBacks();
      expect(f.playMa2Cue).toHaveBeenCalledTimes(2);
      expect(f.ma2.requests).toEqual([]);
      expect(f.verified).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('读回期间又开始用、换歌或停止：旧的读回不串到新的上；这次没发出去的不会被改成“还在运行”', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1.1', true);
      await f.observer();
      f.play();
      const song = lit('a', '开场', ['1.1']);
      // Started again before the first read: nothing is read for the old Off.
      await f.service.stop(song, 'stop');
      await f.service.change(null, song);
      await f.readBacks();
      expect(f.reads()).toEqual([]);
      // Read once (running), then stopped again and this Off fails: the old round settles nothing.
      await f.service.change(song, null);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.reads()).toEqual(['web 1.1']);
      f.playMa2Cue.mockRejectedValueOnce(new Error('MA2 没有回应'));
      await f.service.stop(song, 'stop');
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1']);
      expect(f.service.owed()).toMatchObject([{ executor: '1.1', state: 'failed', reason: 'MA2 没有回应' }]);
      expect(f.service.check().running).toEqual([]);
      expect(f.verified).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('播放中读不到：只记日志，不在状态详情里提，也不再读', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1.1', false);
      await f.observer();
      f.play();
      const song = lit('a', '开场', ['1.1']);
      await f.service.change(null, song);
      await f.service.change(song, lit('b', '返场', ['3.1']));
      f.ma2.garble = { page: 1, count: 1 };
      await f.readBacks();
      expect(f.reads()).toEqual(['web 1.1']);
      expect(f.logs()).toEqual(['关灯读回无法确认：「开场」的执行器 1.1。原因：控台返回了其他页面的数据']);
      expect(f.service.check()).toEqual({ running: [], unconfirmed: [] });
    } finally { f.close(); }
  });

  it('无法确认的那句会过期：这个执行器又开始用、或又欠了新的 Off，就从状态详情里清掉，窗口收到这次变化', async () => {
    const f = await rig();
    try {
      f.ma2.running.set('1.1', false); f.ma2.running.set('1.2', false);
      await f.observer();
      f.play();
      const changes = vi.fn(); f.service.onChanged(changes);
      f.ma2.garble = { page: 1, count: 1 };
      await f.service.stop(lit('a', '开场', ['1.1', '1.2']), 'stop');
      await f.readBacks();
      expect(f.service.check().unconfirmed.map(entry => entry.executor)).toEqual(['1.1', '1.2']);
      // In use again.
      changes.mockClear();
      await f.service.change(null, lit('b', '返场', ['1.1']));
      expect(f.service.check().unconfirmed.map(entry => entry.executor)).toEqual(['1.2']);
      expect(changes).toHaveBeenCalled();
      await f.service.change(lit('b', '返场', ['1.1']), null);
      await f.readBacks();
      // Owed afresh: the console is gone, so this Off waits and nothing is read.
      changes.mockClear();
      f.status.state = 'disconnected';
      await f.service.stop(lit('a', '开场', ['1.2']), 'stop');
      expect(f.service.check().unconfirmed).toEqual([]);
      expect(changes).toHaveBeenCalled();
    } finally { f.close(); }
  });
});

// 0.5.9 S8a：拿着歌时改了它的灯光，执行器只增不减；停止关这一遍所有版本用过的；已经欠着的不取消。
describe('拿着歌时改灯光', () => {
  it('widen 不发任何 Off；停止关所有版本的执行器；欠着的 Off 照旧欠着', async () => {
    const f = fixture(); f.status.state = 'disconnected';
    await f.service.stop(lit('b', '返场', ['1.103']), 'stop');
    expect(f.service.owed().map(entry => entry.executor)).toEqual(['1.103']);
    f.status.state = 'connected';
    const first = lit('a', '开场', ['1.101']);
    await f.service.change(null, first);
    const widened = { document: document(['1.102', '1.103']), song: first.song, earlier: [first.document] };
    f.service.widen(widened);
    expect(f.playMa2Cue).not.toHaveBeenCalled();
    expect(f.service.owed().map(entry => entry.executor)).toEqual(['1.103']);
    await f.service.stop(widened, 'stop');
    expect(new Set(f.executors())).toEqual(new Set(['1.101', '1.102', '1.103']));
    expect(f.service.owed()).toEqual([]);
  });
});
