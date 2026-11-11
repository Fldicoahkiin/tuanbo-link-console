import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, type LicenseStatus, type LightingDocument, type Ma2NetworkStatus, type Ma2PlaybackRequest } from '@tb/schema';
import { LightingOffService } from './lighting-off-service';
import { LicenseAccess } from './license-access';
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
    // Following P1, stop in the app switches the song off and sends what is still owed, without stopping P1.
    await f.service.receive({ version: 1, source: 'p1', phase: 'stop', document: document(['1.106']), song: { itemId: 'p', title: 'P1 的歌' } });
    expect(f.executors()).toEqual(['1.106', '1.101', '1.105']);
    expect(f.service.owed()).toEqual([]);
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
    const wiring = programLicense({ access, changing: () => false }, { ready: Promise.resolve(), status: () => status, send });
    const service = new LightingOffService({ console: wiring.network, failed: () => undefined, resending: () => undefined });
    await expect(service.stop(lit('a', '开场', ['1.101']), 'stop')).resolves.toEqual({ failed: [] });
    await expect(service.receive({ version: 1, source: 'preview', phase: 'stop', document: document(['1.102']), song: null })).resolves.toEqual({ failed: [] });
    expect(send.mock.calls.map(([request]) => request.action)).toEqual([off('1.101'), off('1.102')]);
    service.close();
  });
});
