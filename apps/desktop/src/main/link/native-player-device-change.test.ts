import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { NativePlaybackCommand, NativePlaybackEvent, NativePlaybackDevices, NativePlayerPrepare } from '@tb/schema';
import type { NativeAudioCache, NativeAudioLease } from './native-audio-cache';
import type { DecodeResult } from './native-audio-decode';
import { NativePlayerService } from './native-player-service';
import type { PortRecoveryReport } from './midi-port-recovery';
import { PreparationSteps, audioErrorLog } from './preparation-log';
import { WindowsMidiHealth, midiHealthMessage, type MidiHealth } from './windows-midi-health';

const native = vi.hoisted(() => ({ devices: vi.fn<(scope: 'all' | 'audio') => Promise<NativePlaybackDevices>>(), commands: vi.fn<(command: NativePlaybackCommand) => void>(),
  emit: null as ((patch: Partial<Extract<NativePlaybackEvent, { kind: 'clock' }>>) => void) | null,
  /** What the engine's MIDI thread reports after a reopen request: the open result, then any send error. */
  reopenResults: [] as { result: number; sendError?: number }[] }));
vi.mock('./native-device-query', () => ({ NativeDeviceQuery: class {
  // Like the real query process: a failed read is kept until the query is reopened.
  private failure: Error | null = null;
  constructor(_executable: string, private readonly scope: 'all' | 'audio' = 'all') {}
  read() {
    if (this.failure) return Promise.reject(this.failure);
    return native.devices(this.scope).catch((error: unknown) => { this.failure = error instanceof Error ? error : new Error(String(error)); throw this.failure; });
  }
  reopenForPreparation() { this.failure = null; return Promise.resolve(); }
  close() { return Promise.resolve(); }
} }));
vi.mock('./native-playback-client', () => ({
  NativePlaybackClient: class {
    readonly identity = { pid: 123, title: 'test', windowClass: 'Static' as const };
    private clock: Extract<NativePlaybackEvent, { kind: 'clock' }> = {
      protocol: 4, kind: 'clock', generation: 0, state: 'empty', positionMs: 0, qpc100ns: '1',
      clockFrequency: 48000, sampleRate: 48000, underruns: 0, midiSent: 0, midiError: 0, midiInterruptions: 0, midiInterruption: 0, midiReopens: 0, midiReopenResult: 0, audioError: 0,
      maxMidiLatenessMs: 0, bufferedFrames: 1000, gain: 1,
      analysis: { fftSize: 2048, peaks: [0, 0], spectrum: Array.from({ length: 1024 }, () => 0) }
    };
    constructor(_executable: string, private readonly changed: (event: NativePlaybackEvent) => void) {
      native.emit = patch => { this.clock = { ...this.clock, ...patch }; this.changed(this.clock); };
    }
    start() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    command(command: NativePlaybackCommand) {
      native.commands(command);
      this.clock = { ...this.clock, generation: command.generation };
      if (command.kind === 'prepare') this.clock = { ...this.clock, state: 'ready', positionMs: command.startMs };
      else if (command.kind === 'play') this.clock.state = 'playing';
      else if (command.kind === 'pause') this.clock.state = 'paused';
      else if (command.kind === 'stop') this.clock.state = 'stopped';
      this.changed(this.clock);
      if (command.kind === 'reopen-mtc') {
        // Like the engine: acknowledged at once, opened on the MIDI thread, reported in telemetry.
        const { result, sendError } = native.reopenResults.shift() ?? { result: 0 };
        setTimeout(() => {
          native.emit!({ midiReopens: this.clock.midiReopens + 1, midiReopenResult: result, midiError: result ? this.clock.midiError : 0 });
          for (let tick = 1; tick <= 3 && !result; tick++) native.emit!(sendError ? { midiError: sendError } : { midiSent: this.clock.midiSent + 4 });
        }, 5);
      }
      return Promise.resolve();
    }
    readClock() { return Promise.resolve(this.clock); }
  }
}));
afterEach(() => { native.devices.mockReset(); native.commands.mockReset(); native.reopenResults = []; });

function fixture() {
  const devices: NativePlaybackDevices = { protocol: 4, audio: [{ id: 'default', name: 'test', isDefault: true }],
    midiOutputs: [{ id: 1, name: 'test-mtc' }], midiInputs: [] };
  native.devices.mockImplementation(() => Promise.resolve(devices));
  const error = vi.fn();
  const checkDeviceHealth = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  // The next song's own errors go to the same spy here; the tests that tell them apart pass their own preloadError.
  const options = { executable: 'test', changed: vi.fn(), error, preloadError: error,
    checkDeviceHealth,
    resolveAudio: () => 'test.wav', cache: { prepare: () => Promise.resolve({ path: 'test.pcm', sampleRate: 48000 as const,
      baseMs: 0, streaming: false, frames: 480000, durationMs: 10000, availableMs: 10000,
      completion: Promise.resolve({ ok: true as const }), release: () => Promise.resolve() }) } };
  const service = new NativePlayerService(options);
  const request: NativePlayerPrepare = { version: 1, sessionId: randomUUID(), generation: 1,
    projectPath: 'C:/test.tblink', audioDeviceId: 'default', midiPortName: 'test-mtc',
    snapshot: { version: 1, projectId: 'test', itemId: 'song', revision: 1,
      audio: { relativePath: 'test.wav', sha256: 'a'.repeat(64), durationMs: 10000 },
      startMs: 500, endMs: 9500, positionMs: 500, offsetMs: 480000, frameRate: 30, sampleRate: 48000, volume: 1 } };
  return { service, options, request, error, devices, checkDeviceHealth };
}

it('系统 MIDI 检测失败不启动完整设备查询；配了时间码端口也只播音频并明确报告，恢复后重新准备才发时间码', async () => {
  const f = fixture();
  f.checkDeviceHealth.mockRejectedValue(new Error('Windows 读取 MIDI 端口没有响应'));
  try {
    await expect(f.service.devices()).rejects.toThrow('读取 MIDI 端口没有响应');
    await expect(f.service.prepare(f.request)).resolves.toMatchObject({ status: 'ready', mtcPortName: null, mtcError: 'MIDI 设备不可用：Windows 读取 MIDI 端口没有响应' });
    expect(native.devices.mock.calls).toEqual([['audio']]);
    expect(f.error).toHaveBeenCalledWith('MIDI 设备不可用，这一首不发时间码：Windows 读取 MIDI 端口没有响应');
    f.checkDeviceHealth.mockResolvedValue(undefined);
    await expect(f.service.prepare({ ...f.request, generation: 2 })).resolves.toMatchObject({ status: 'ready', mtcPortName: 'test-mtc', mtcError: null });
    expect(native.devices.mock.calls).toEqual([['audio'], ['all']]);
  } finally { await f.service.close(); }
});

it('时间码端口按名字交给引擎核对；选了“只发四分之一帧”时准备和定位都带上这个方式', async () => {
  const f = fixture();
  try {
    await f.service.prepare({ ...f.request, mtcQuarterFramesOnly: true });
    await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'seek', positionMs: 2000 });
    const prepared = native.commands.mock.calls.flatMap(([command]) => command.kind === 'prepare' ? [command] : []);
    expect(prepared.slice(-2)).toEqual([expect.objectContaining({ midiDevice: 1, midiPortName: 'test-mtc', quarterFramesOnly: true }),
      expect.objectContaining({ midiDevice: 1, midiPortName: 'test-mtc', quarterFramesOnly: true, startMs: 2000 })]);
  } finally { await f.service.close(); }
});

it('等待设备检测期间关闭服务，迟到结果不能启动设备查询', async () => {
  const f = fixture();
  let finish!: () => void;
  f.checkDeviceHealth.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = expect(f.service.devices()).rejects.toThrow('正在关闭');
  await f.service.close();
  finish(); await pending;
  expect(native.devices).not.toHaveBeenCalled();
});

it('明确关闭 MIDI 的音频播放不进入系统 MIDI 枚举，仍可定位和停止', async () => {
  const f = fixture();
  f.checkDeviceHealth.mockRejectedValue(new Error('Windows MIDI 服务未响应'));
  try {
    await expect(f.service.prepare({ ...f.request, midiPortName: null, autoDetectMtc: false })).resolves.toMatchObject({ status: 'ready', mtcPortName: null });
    await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'play' });
    await f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 3, kind: 'seek', positionMs: 2000 });
    expect(f.service.status).toMatchObject({ status: 'paused', positionMs: 2000 });
    expect(f.checkDeviceHealth).not.toHaveBeenCalled();
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'prepare').every(([command]) => command.kind === 'prepare' && command.midiDevice === null)).toBe(true);
  } finally { await f.service.close(); }
});

it('定位时 MIDI 端口消失只退出时间码通道，音频仍可定位和继续；同一端口回来后，继续播放时自动重新打开', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId };
  try {
    await f.service.prepare(f.request);
    await f.service.control({ ...envelope, generation: 2, kind: 'play' });
    f.devices.midiOutputs = [];
    await f.service.control({ ...envelope, generation: 3, kind: 'seek', positionMs: 2000 });
    expect(f.service.status).toMatchObject({ status: 'paused', positionMs: 2000, offsetMs: 480000,
      audioError: null, mtcPortName: null });
    expect(f.service.status?.mtcError).toContain('断开了，音频照常播放');
    expect(f.error).toHaveBeenCalledOnce();
    const prepared = native.commands.mock.calls.flatMap(([command]) => command.kind === 'prepare' ? [command] : []);
    expect(prepared.at(-1)?.midiDevice).toBeNull();
    f.devices.midiOutputs = [{ id: 2, name: 'test-mtc' }];
    // Paused: the watch only waits; a reopened port is confirmed by the timecode it then sends.
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'reopen-mtc')).toEqual([]);
    await f.service.control({ ...envelope, generation: 4, kind: 'play' });
    await vi.waitFor(() => expect(f.service.status?.mtcRecovered?.portName).toBe('test-mtc'), { timeout: 3000 });
    expect(native.commands.mock.calls.map(([command]) => command)).toContainEqual(expect.objectContaining({ kind: 'reopen-mtc', midiDevice: 2, midiPortName: 'test-mtc' }));
    expect(f.service.status).toMatchObject({ mtcPortName: 'test-mtc', mtcError: null });
    await f.service.control({ ...envelope, generation: 5, kind: 'seek', positionMs: 3000 });
    // The engine opens the port by index and checks the name on the opened port.
    expect(native.commands.mock.calls.flatMap(([command]) => command.kind === 'prepare' ? [command] : []).at(-1)).toMatchObject({ midiDevice: 2, midiPortName: 'test-mtc', quarterFramesOnly: false });
    expect(f.service.status).toMatchObject({ status: 'paused', mtcPortName: 'test-mtc', mtcError: null, audioError: null });
    expect(f.error).toHaveBeenCalledOnce();
  } finally { await f.service.close(); }
});

it('播放中时间码接口断开：同一接口回来后重新打开并从当前位置继续，不重新准备音频；旧遥测不再报断开', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, recovered = vi.fn<(report: PortRecoveryReport) => void>();
  const service = new NativePlayerService({ ...f.options, recovered });
  try {
    await service.prepare(f.request);
    await service.control({ ...envelope, generation: 2, kind: 'play' });
    native.emit!({ midiSent: 40, qpc100ns: '2' });
    f.devices.midiOutputs = [];
    native.emit!({ midiSent: 41, midiError: 6, qpc100ns: '3' });
    native.emit!({ midiSent: 41, midiError: 6, qpc100ns: '4' });
    expect(service.status?.mtcError).toContain('断开了（错误码 6）');
    expect(f.error).toHaveBeenCalledOnce();
    const preparedBefore = native.commands.mock.calls.filter(([command]) => command.kind === 'prepare').length;
    f.devices.midiOutputs = [{ id: 5, name: 'test-mtc' }];
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'reopen-mtc')).toEqual([[expect.objectContaining({ midiDevice: 5, midiPortName: 'test-mtc' })]]);
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'prepare').length).toBe(preparedBefore);
    expect(service.status).toMatchObject({ status: 'playing', mtcPortName: 'test-mtc', mtcError: null });
    expect(recovered.mock.calls[0]?.[0].portName).toBe('test-mtc'); expect(recovered.mock.calls[0]?.[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(service.status?.mtcSent).toBeGreaterThan(41);
    expect(f.error).toHaveBeenCalledOnce();
  } finally { await service.close(); }
});

it('刚出现的端口第一次打开后发送失败：不算恢复、不另报错误，下一秒重新打开并确认发送后才恢复', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, recovered = vi.fn<(report: PortRecoveryReport) => void>();
  const service = new NativePlayerService({ ...f.options, recovered });
  try {
    await service.prepare(f.request);
    await service.control({ ...envelope, generation: 2, kind: 'play' });
    f.devices.midiOutputs = [];
    native.emit!({ midiSent: 41, midiError: 6, qpc100ns: '3' });
    expect(f.error).toHaveBeenCalledOnce();
    // Seen on the dev PC: a port Windows is still creating opens, then its first message fails (error 1).
    native.reopenResults = [{ result: 0, sendError: 1 }, { result: 0 }];
    f.devices.midiOutputs = [{ id: 5, name: 'test-mtc' }];
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 4000 });
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'reopen-mtc')).toHaveLength(2);
    const messages = f.error.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2); expect(messages[0]).toContain('断开了（错误码 6）'); expect(messages[1]).toContain('端口已打开但发送失败（错误码 1）');
    expect(service.status).toMatchObject({ status: 'playing', mtcPortName: 'test-mtc', mtcError: null });
  } finally { await service.close(); }
});

it('接口断开时系统 MIDI 检测超时一次：等待期间重新检测，同一接口回来后照常打开', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, recovered = vi.fn<(report: PortRecoveryReport) => void>();
  // Windows stalls while the port is removed: that one probe times out, later ones pass again.
  const probe = vi.fn<() => Promise<MidiHealth>>().mockResolvedValue('ready'), health = new WindowsMidiHealth(probe);
  const service = new NativePlayerService({ ...f.options, recovered, checkDeviceHealth: async recheck => {
    const result = await health.check(recheck);
    if (result !== 'ready') throw new Error(midiHealthMessage(result));
  } });
  try {
    await service.prepare(f.request);
    await service.control({ ...envelope, generation: 2, kind: 'play' });
    f.devices.midiOutputs = [];
    probe.mockResolvedValueOnce('timeout');
    native.emit!({ midiSent: 41, midiError: 6, qpc100ns: '3' });
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith(expect.stringContaining('读取 MIDI 端口没有响应')), { timeout: 3000 });
    f.devices.midiOutputs = [{ id: 5, name: 'test-mtc' }];
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(native.commands.mock.calls.filter(([command]) => command.kind === 'reopen-mtc')).toEqual([[expect.objectContaining({ midiDevice: 5, midiPortName: 'test-mtc' })]]);
    expect(service.status).toMatchObject({ status: 'playing', mtcPortName: 'test-mtc', mtcError: null });
  } finally { await service.close(); }
});

it('接口断开时设备查询失败一次：等待期间重新打开查询，同一接口回来后照常打开', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, recovered = vi.fn<(report: PortRecoveryReport) => void>();
  const service = new NativePlayerService({ ...f.options, recovered });
  try {
    await service.prepare(f.request);
    await service.control({ ...envelope, generation: 2, kind: 'play' });
    f.devices.midiOutputs = [];
    native.devices.mockRejectedValueOnce(new Error('设备查询失败：Device enumeration failed: -2147467259'));
    native.emit!({ midiSent: 41, midiError: 6, qpc100ns: '3' });
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith(expect.stringContaining('Device enumeration failed')), { timeout: 3000 });
    f.devices.midiOutputs = [{ id: 5, name: 'test-mtc' }];
    await vi.waitFor(() => expect(recovered).toHaveBeenCalledOnce(), { timeout: 3000 });
    expect(service.status).toMatchObject({ status: 'playing', mtcPortName: 'test-mtc', mtcError: null });
  } finally { await service.close(); }
});

it('定位设备查询未返回时切歌，旧设备缺失结果不能清除新歌曲的 MIDI', async () => {
  const f = fixture();
  let release: ((devices: NativePlaybackDevices) => void) | undefined;
  try {
    await f.service.prepare(f.request);
    native.devices.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const seeking = f.service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'seek', positionMs: 2000 });
    const rejected = expect(seeking).rejects.toThrow('取消');
    await vi.waitFor(() => expect(release).toBeDefined());
    const next = f.service.prepare({ ...f.request, sessionId: randomUUID(), snapshot: { ...f.request.snapshot, itemId: 'next' } });
    release!({ ...f.devices, midiOutputs: [], midiInputs: [] });
    await rejected; await next;
    expect(f.service.status).toMatchObject({ itemId: 'next', status: 'ready', mtcPortName: 'test-mtc', mtcError: null, audioError: null });
    expect(f.error).not.toHaveBeenCalled();
  } finally { release?.(f.devices); await f.service.close(); }
});

it('时间码短暂中断：每次记录一次并累计本首次数，不当作 MIDI 故障；定位后引擎重新计数不漏记', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId };
  try {
    await f.service.prepare(f.request);
    await f.service.control({ ...envelope, generation: 2, kind: 'play' });
    native.emit!({ midiInterruptions: 1, midiInterruption: -1, qpc100ns: '2' });
    native.emit!({ midiInterruptions: 1, midiInterruption: -1, qpc100ns: '3' });
    expect(f.service.status).toMatchObject({ status: 'playing', mtcInterruptions: 1, mtcError: null });
    expect(f.error).toHaveBeenCalledOnce();
    expect(f.error.mock.calls[0]?.[0]).toContain('发送线程迟到超过一帧');
    await f.service.control({ ...envelope, generation: 3, kind: 'seek', positionMs: 2000 });
    native.emit!({ midiInterruptions: 0, qpc100ns: '4' });
    native.emit!({ midiInterruptions: 1, midiInterruption: -2, qpc100ns: '5' });
    expect(f.service.status).toMatchObject({ mtcInterruptions: 2, mtcError: null });
    expect(f.error).toHaveBeenCalledTimes(2);
    expect(f.error.mock.calls[1]?.[0]).toContain('音频时钟超过一帧没有更新');
  } finally { await f.service.close(); }
});

function claiming(owners: () => ('时间码' | '动作 MIDI' | '接口检查')[] = () => []) {
  const claims: { name: string; released: boolean }[] = [];
  const claimMidiOutput = (name: string) => {
    const claim = { name, released: false }; claims.push(claim);
    return Promise.resolve({ owner: '时间码' as const, others: owners, release: () => { claim.released = true; } });
  };
  return { claims, claimMidiOutput };
}

it('播放期间占住时间码接口；停止时先停发时间码再归还，界面和其他软件可以再用', async () => {
  const f = fixture(); const { claims, claimMidiOutput } = claiming();
  const service = new NativePlayerService({ ...f.options, claimMidiOutput });
  try {
    await expect(service.prepare(f.request)).resolves.toMatchObject({ status: 'ready', mtcPortName: 'test-mtc' });
    expect(claims).toEqual([{ name: 'test-mtc', released: false }]);
    await service.control({ version: 1, sessionId: f.request.sessionId, generation: 2, kind: 'play' });
    native.commands.mockClear();
    await service.control({ version: 1, sessionId: f.request.sessionId, generation: 3, kind: 'stop' });
    expect(native.commands.mock.calls.map(([command]) => command.kind)).toEqual(['stop', 'stop-mtc']);
    expect(claims[0]!.released).toBe(true);
    expect(service.status).toMatchObject({ status: 'stopped', mtcPortName: null });
  } finally { await service.close(); }
});

it('换歌时先占新接口再还旧接口；不发时间码的歌不占接口', async () => {
  const f = fixture(); const { claims, claimMidiOutput } = claiming();
  f.devices.midiOutputs.push({ id: 2, name: 'other-mtc' });
  const service = new NativePlayerService({ ...f.options, claimMidiOutput });
  try {
    await service.prepare(f.request);
    await service.prepare({ ...f.request, generation: 2, midiPortName: 'other-mtc' });
    expect(claims).toEqual([{ name: 'test-mtc', released: true }, { name: 'other-mtc', released: false }]);
    await service.prepare({ ...f.request, generation: 3, midiPortName: null, autoDetectMtc: false });
    expect(claims).toHaveLength(2);
    expect(claims[1]!.released).toBe(true);
  } finally { await service.close(); }
  expect(claims.every(claim => claim.released)).toBe(true);
});

it('时间码接口被占用时说清是谁：本软件另一处用了同一接口，或其他软件', async () => {
  const shared = fixture(); const owners = claiming(() => ['动作 MIDI']);
  const service = new NativePlayerService({ ...shared.options, claimMidiOutput: owners.claimMidiOutput });
  try {
    await service.prepare(shared.request);
    native.emit!({ midiError: 7, qpc100ns: '5' });
    expect(service.status?.mtcError).toBe('MIDI 接口「test-mtc」同时设成了动作 MIDI、时间码的输出，但它一次只能给一处用。请到「设置 → 音频与 MIDI」给它们选不同的接口。');
  } finally { await service.close(); }
  const other = fixture();
  const alone = new NativePlayerService({ ...other.options, claimMidiOutput: claiming().claimMidiOutput });
  try {
    await alone.prepare(other.request);
    native.emit!({ midiError: 7, qpc100ns: '5' });
    expect(alone.status?.mtcError).toBe('MIDI 接口「test-mtc」正被其他软件占用（错误码 7），时间码没有发出。请关闭 P1 等正在使用它的软件后重新播放。');
  } finally { await alone.close(); }
});

/** Songs with their own audio, prepared from a cache whose leases record their release; a song in
 * `refuse` fails its next release once, like a rename Windows refused while a virus scanner held the file.
 * The run log is kept as in the app (link-main): `error` takes the steps of the preparation so far, whatever goes
 * wrong with the next song prepared ahead goes to `preloadError` without taking them (audioErrorLog), and each
 * 音频已准备好 entry takes what is left (`ready`). */
async function preloading(f: ReturnType<typeof fixture>) {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-player-preload-')), path = join(directory, 'song.wav');
  await writeFile(path, 'audio fixture');
  const refuse = new Set<string>(), released: string[] = [], measured = vi.fn<(phase: string, elapsedMs: number) => void>(), preloadError = vi.fn();
  const lease = (song: string, completion: Promise<DecodeResult> = Promise.resolve({ ok: true })): NativeAudioLease => ({ path: `${song}.pcm`,
    sampleRate: 48000, baseMs: 0, streaming: false, frames: 480000, durationMs: 10000, availableMs: 10000, completion, release: () => {
      if (refuse.delete(song)) return Promise.reject(new Error('EPERM: operation not permitted, rename'));
      released.push(song); return Promise.resolve();
    } });
  const prepare = vi.fn<NativeAudioCache['prepare']>(input => Promise.resolve(lease(input.sourceSha256[0]!)));
  const steps = new PreparationSteps(() => undefined), log = audioErrorLog(steps, () => Promise.resolve());
  const ready: { itemId: string; steps: string[] }[] = [];
  let readyBoundary = '';
  const service = new NativePlayerService({ ...f.options, resolveAudio: () => path, cache: { prepare },
    measured: (phase, elapsedMs) => { measured(phase, elapsedMs); steps.add(phase, elapsedMs); },
    changed: status => {
      const boundary = `${status.sessionId}:${status.generation}`;
      if (status.status !== 'ready' || boundary === readyBoundary) return;
      readyBoundary = boundary; ready.push({ itemId: status.itemId, steps: steps.take().map(({ step }) => step) });
    },
    error: message => { f.error(message); log.error(message); },
    preloadError: message => { preloadError(message); log.preloadError(message); } });
  const song = (id: string) => ({ ...f.request.snapshot, itemId: id, audio: { ...f.request.snapshot.audio, sha256: id.repeat(64) } });
  const preloaded = (count: number) => vi.waitFor(() => expect(measured.mock.calls.filter(([phase]) => phase === '预先准备下一首音频')).toHaveLength(count));
  return { service, prepare, lease, refuse, released, song, preloaded, measured, preloadError, ready };
}

it('下一首提前准备的音频放不掉一次：只记一次错误；换歌、再提前准备、接着播都照常', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, p = await preloading(f);
  try {
    await p.service.prepare({ ...f.request, snapshot: p.song('a'), nextSnapshot: p.song('b') });
    await p.service.control({ ...envelope, generation: 2, kind: 'play' }); await p.preloaded(1);
    // The operator jumps to C while B waits prepared, and letting B go fails once.
    p.refuse.add('b');
    await expect(p.service.prepare({ ...f.request, generation: 3, snapshot: p.song('c'), nextSnapshot: p.song('b') }))
      .resolves.toMatchObject({ itemId: 'c', status: 'ready', audioError: null });
    // Reported apart from C's preparation: it is not C's failure, and C's 音频已准备好 entry keeps all of its steps.
    expect(p.preloadError).toHaveBeenCalledOnce(); expect(p.preloadError).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    expect(p.ready.at(-1)?.itemId).toBe('c');
    expect(p.ready.at(-1)?.steps).toEqual(expect.arrayContaining(['设备检查与旧播放清理', '音源校验与解码预填充', '原生进程准备', '音频设备与时钟准备']));
    // B is prepared ahead again while C plays, and playing on to B uses it.
    await p.service.control({ ...envelope, generation: 4, kind: 'play' }); await p.preloaded(2);
    const decoded = p.prepare.mock.calls.length;
    await expect(p.service.prepare({ ...f.request, generation: 5, snapshot: p.song('b') })).resolves.toMatchObject({ itemId: 'b', status: 'ready' });
    expect(p.prepare).toHaveBeenCalledTimes(decoded);
    expect(p.preloadError).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
  } finally { await p.service.close(); }
});

it('定位时提前准备的下一首放不掉：定位照常完成，只单独记一次错误；接着播放时下一首重新提前准备', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, p = await preloading(f);
  try {
    await p.service.prepare({ ...f.request, snapshot: p.song('a'), nextSnapshot: p.song('b') });
    await p.service.control({ ...envelope, generation: 2, kind: 'play' }); await p.preloaded(1);
    p.refuse.add('b');
    await expect(p.service.control({ ...envelope, generation: 3, kind: 'seek', positionMs: 2000 }))
      .resolves.toMatchObject({ status: 'paused', positionMs: 2000, audioError: null });
    expect(p.preloadError).toHaveBeenCalledOnce(); expect(p.preloadError).toHaveBeenCalledWith(expect.stringContaining('EPERM'));
    expect(f.error).not.toHaveBeenCalled(); expect(p.released).toEqual(['a']);
    // Playing on prepares B ahead again, and moving on to B uses it.
    await p.service.control({ ...envelope, generation: 4, kind: 'play' }); await p.preloaded(2);
    const decoded = p.prepare.mock.calls.length;
    await expect(p.service.prepare({ ...f.request, generation: 5, snapshot: p.song('b') })).resolves.toMatchObject({ itemId: 'b', status: 'ready', audioError: null });
    expect(p.prepare).toHaveBeenCalledTimes(decoded);
    expect(p.preloadError).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
  } finally { await p.service.close(); }
});

it('停止和关闭时提前准备的下一首放不掉：记下错误，停止和关闭照常完成，当前这首的音频照常放掉', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, p = await preloading(f);
  try {
    await p.service.prepare({ ...f.request, snapshot: p.song('a'), nextSnapshot: p.song('b') });
    await p.service.control({ ...envelope, generation: 2, kind: 'play' }); await p.preloaded(1);
    p.refuse.add('b');
    await expect(p.service.control({ ...envelope, generation: 3, kind: 'stop' })).resolves.toMatchObject({ status: 'stopped', audioError: null });
    expect(p.released).toEqual(['a']); expect(p.preloadError).toHaveBeenCalledOnce();
    await p.service.prepare({ ...f.request, generation: 4, snapshot: p.song('c'), nextSnapshot: p.song('d') });
    await p.service.control({ ...envelope, generation: 5, kind: 'play' }); await p.preloaded(2);
    p.refuse.add('d');
    await p.service.close();
    expect(p.service.status).toMatchObject({ status: 'stopped' });
    expect(p.released).toEqual(['a', 'c']); expect(p.preloadError).toHaveBeenCalledTimes(2); expect(f.error).not.toHaveBeenCalled();
  } finally { await p.service.close(); }
});

it('接手提前准备好的下一首时，它的后台解码正好失败：这条单独记，不带走这首的准备步骤；这首重新解码，准备好的那条步骤齐全', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, p = await preloading(f);
  try {
    let fail!: (error: Error) => void;
    const completion = new Promise<DecodeResult>(resolve => { fail = error => resolve({ ok: false, error }); });
    await p.service.prepare({ ...f.request, snapshot: p.song('a'), nextSnapshot: p.song('b') });
    p.prepare.mockResolvedValueOnce(p.lease('b', completion));
    await p.service.control({ ...envelope, generation: 2, kind: 'play' }); await p.preloaded(1);
    // The operator plays B. B's decode stalls just then: after the device check, while B's source file is read.
    p.measured.mockImplementation(phase => { if (phase === '设备检查与旧播放清理') fail(new Error('音频解码 30 秒没有进展，已停止解码')); });
    await expect(p.service.prepare({ ...f.request, generation: 3, snapshot: p.song('b') }))
      .resolves.toMatchObject({ itemId: 'b', status: 'ready', audioError: null });
    expect(p.preloadError).toHaveBeenCalledExactlyOnceWith('下一首提前准备的音频解码失败，播到这首时照常准备。原因：音频解码 30 秒没有进展，已停止解码');
    expect(f.error).not.toHaveBeenCalled();
    // B is decoded again, and its 音频已准备好 entry keeps every step of this preparation.
    expect(p.prepare).toHaveBeenCalledTimes(3); expect(p.released).toEqual(['a', 'b']);
    expect(p.ready.at(-1)?.itemId).toBe('b');
    expect(p.ready.at(-1)?.steps).toEqual(expect.arrayContaining(['设备检查与旧播放清理', '音源校验与解码预填充', '原生进程准备', '音频设备与时钟准备']));
  } finally { await p.service.close(); }
});

it('下一首在后台自己准备失败：单独记一条，不算正在播的这首的错误；播到它时照常重新准备', async () => {
  const f = fixture(), envelope = { version: 1 as const, sessionId: f.request.sessionId }, p = await preloading(f);
  try {
    await p.service.prepare({ ...f.request, snapshot: p.song('a'), nextSnapshot: p.song('b') });
    p.prepare.mockRejectedValueOnce(new Error('音频解码或读取失败：EIO: i/o error, read'));
    await p.service.control({ ...envelope, generation: 2, kind: 'play' });
    await vi.waitFor(() => expect(p.preloadError).toHaveBeenCalledOnce());
    expect(p.preloadError).toHaveBeenCalledWith('下一首的音频没能提前准备好，播到这首时照常准备。原因：音频解码或读取失败：EIO: i/o error, read');
    expect(f.error).not.toHaveBeenCalled();
    expect(p.service.status).toMatchObject({ itemId: 'a', status: 'playing', audioError: null });
    await expect(p.service.prepare({ ...f.request, generation: 3, snapshot: p.song('b') }))
      .resolves.toMatchObject({ itemId: 'b', status: 'ready', audioError: null });
    expect(p.prepare).toHaveBeenCalledTimes(3);
    expect(p.preloadError).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
  } finally { await p.service.close(); }
});
