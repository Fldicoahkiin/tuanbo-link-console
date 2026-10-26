import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { NativePlaybackCommand, NativePlaybackEvent, NativePlaybackDevices, NativePlayerPrepare } from '@tb/schema';
import { NativePlayerService } from './native-player-service';
import type { PortRecoveryReport } from './midi-port-recovery';
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
  const options = { executable: 'test', changed: vi.fn(), error,
    checkDeviceHealth,
    resolveAudio: () => 'test.wav', cache: { prepare: () => Promise.resolve({ path: 'test.pcm', sampleRate: 48000 as const,
      baseMs: 0, streaming: false, frames: 480000, durationMs: 10000,
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
  f.checkDeviceHealth.mockRejectedValue(new Error('Windows MIDI 端口枚举未响应'));
  try {
    await expect(f.service.devices()).rejects.toThrow('端口枚举未响应');
    await expect(f.service.prepare(f.request)).resolves.toMatchObject({ status: 'ready', mtcPortName: null, mtcError: 'MIDI 设备不可用：Windows MIDI 端口枚举未响应' });
    expect(native.devices.mock.calls).toEqual([['audio']]);
    expect(f.error).toHaveBeenCalledWith('MIDI 设备不可用，本首时间码未参与：Windows MIDI 端口枚举未响应');
    f.checkDeviceHealth.mockResolvedValue(undefined);
    await expect(f.service.prepare({ ...f.request, generation: 2 })).resolves.toMatchObject({ status: 'ready', mtcPortName: 'test-mtc', mtcError: null });
    expect(native.devices.mock.calls).toEqual([['audio'], ['all']]);
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
    expect(f.service.status?.mtcError).toContain('接口已断开');
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
    expect(native.commands.mock.calls.flatMap(([command]) => command.kind === 'prepare' ? [command] : []).at(-1)?.midiDevice).toBe(2);
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
    await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith(expect.stringContaining('端口枚举未响应')), { timeout: 3000 });
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
    expect(f.error.mock.calls[1]?.[0]).toContain('音频时钟超过一帧未更新');
  } finally { await f.service.close(); }
});

function claiming(owners: () => ('时间码' | '动作 MIDI' | '灯光 MIDI' | '接口检查')[] = () => []) {
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
    expect(service.status?.mtcError).toBe('MIDI 接口「test-mtc」同时设成了动作 MIDI、时间码的输出，但它一次只能给一处用。请到 设置 → 音频与 MIDI 给它们选不同的接口。');
  } finally { await service.close(); }
  const other = fixture();
  const alone = new NativePlayerService({ ...other.options, claimMidiOutput: claiming().claimMidiOutput });
  try {
    await alone.prepare(other.request);
    native.emit!({ midiError: 7, qpc100ns: '5' });
    expect(alone.status?.mtcError).toBe('MIDI 接口「test-mtc」正被其他软件占用（错误码 7），时间码没有发出。请关闭 P1 等正在使用它的软件后重新播放。');
  } finally { await alone.close(); }
});
