import { describe, expect, it, vi } from 'vitest';
import { allocateP1TimecodeRanges, frameNumberToTimecode } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, lightingDocumentSchema, lightingMa2BindingSchema, lightingTrackSchema, p1FollowStateSchema,
  type LicenseStatus, type LightingDocument, type LinkProject, type Ma2NetworkStatus, type Ma2PlaybackRequest, type P1FollowCommand, type P1FollowState } from '@tb/schema';
import { LightingOffService } from './lighting-off-service';
import type { MidiInputListener } from './midi-port-broker';
import { followRuns, p1FollowShowInput, wireP1Follow } from './p1-follow-wiring';
import { authorizeRequest, programLicense, type LicenseGate } from './program-license';
import { LicenseAccess } from './license-access';

/** The P1 follow as link-main wires it (0.5.9 P3f): the real host, outputs and lights-off ledger; a fake console, broker
 * and IPC. */

const FPS = 30;
const FRAME_MS = 1000 / FPS;
const OWNER = '6f1c1d2e-3a4b-4c5d-8e9f-0a1b2c3d4e5f';
const settings = { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test', autoConnect: false };

/** `license`: link-main's license instead of a fake one: every request through its check (authorizeRequest), the
 * outputs' check (authorizeOutput) and the follow's running state into programLicense. */
function fixture(project: LinkProject, options: { refuseFiles?: string; license?: LicenseGate & { followRunning(running: boolean): void } } = {}) {
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>();
  const states: P1FollowState[] = [], running: boolean[] = [], faults: string[] = [], listeners: MidiInputListener[] = [];
  const status: Ma2NetworkStatus = { state: 'connected', settings: { ...settings }, passwordSaved: false, version: '3.3.4.3', error: null, connection: 1 };
  const playMa2Cue = vi.fn<(request: Ma2PlaybackRequest) => Promise<void>>(() => Promise.resolve());
  const lights = new LightingOffService({ console: { getMa2NetworkStatus: () => Promise.resolve(status), playMa2Cue }, failed: () => undefined, resending: () => undefined });
  const license = options.license;
  const authorize = vi.fn<() => Promise<void>>(() => license ? license.access.requireOutput() : Promise.resolve());
  const showChanged = vi.fn();
  const windowOpened = vi.fn();
  const release = vi.fn(() => Promise.resolve());
  const wiring = wireP1Follow({
    handle: (channel, listener) => { handlers.set(channel, license
      ? async (event: unknown, value: unknown) => { await authorizeRequest(license, channel, value); return listener(event, value); } : listener); },
    send: (_channel, state) => { states.push(p1FollowStateSchema.parse(state)); },
    broker: {
      claimInput: (_name, owner, listener) => { listeners.push(listener); return Promise.resolve({ owner, release }); },
      claimFormal: () => Promise.reject(new Error('这个测试没有动作 MIDI 端口'))
    },
    executable: 'engine.exe', authorize, midiOutputs: () => Promise.resolve([]),
    checkFiles: () => options.refuseFiles ? Promise.reject(new Error(options.refuseFiles)) : Promise.resolve(),
    lights, faults: { report: message => { faults.push(message); }, windowOpened }, record: () => Promise.resolve(),
    showChanged, running: value => { running.push(value); license?.followRunning(value); }
  });
  const send = (command: P1FollowCommand) => handlers.get('link:p1-follow')!(null, { version: 1, ownerId: OWNER, command });
  const start = (mode: 'manual' | 'auto') => send({ kind: 'start', projectPath: 'C:/show.tblink', sessionId: OWNER, revision: 1, document: JSON.stringify(project),
    mode, runMode: 'live', inputPortName: 'loopMIDI Port', lightingProfile: null });
  const offs = () => playMa2Cue.mock.calls.map(([request]) => request.action.target === 'executor' ? request.action.executor : '');
  const play = (fromFrame: number, frames: number, startMs: number) => {
    const listener = listeners.at(-1)!;
    let lastSampleMs = startMs;
    for (let offset = 0; offset < frames; offset += 2) {
      const tc = frameNumberToTimecode(fromFrame + offset, '30');
      const pieces = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4, tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | (3 << 1)];
      for (const [type, value] of pieces.entries()) {
        const ms = startMs + (offset + type / 4) * FRAME_MS;
        listener.message({ bytes: [0xf1, (type << 4) | value], at100ns: at(ms) });
        if (type === 7) lastSampleMs = ms;
      }
    }
    return { endMs: startMs + frames * FRAME_MS, lastSampleMs };
  };
  return { wiring, handlers, states, running, faults, listeners, lights, playMa2Cue, offs, authorize, showChanged, windowOpened, release, send, start, play, status };
}

describe('P1 跟随接到主进程（P3f）', () => {
  it('在联动台按停止：经那一张关灯清单关这首歌的执行器；P1 自己停、断码、等下一首都不发', async () => {
    const project = autoProject({ a: ['1.101', '1.102'], b: ['1.102', '1.103'] });
    const f = fixture(project);
    await f.start('auto');
    expect(f.windowOpened).toHaveBeenCalledOnce();
    await f.send({ kind: 'arm', itemId: null });
    const a = f.play(songFrame(project, 'a'), 30, 1_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'running', itemId: 'a' }));
    // P1 stops by itself: frozen, no Off.
    for (const listener of f.listeners) listener.idle(at(a.lastSampleMs + 600));
    expect(f.wiring.host.state.phase).toBe('frozen');
    await f.lights.settled();
    expect(f.offs()).toEqual([]);
    // P1 plays song b: only what a has alone goes off.
    const b = f.play(songFrame(project, 'b'), 30, a.lastSampleMs + 2_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'running', itemId: 'b' }));
    await f.lights.settled();
    expect(f.offs()).toEqual(['1.101']);
    // While P1 follows b, a stop of the window's own preview on 1.102 does not switch it off: one ledger.
    await f.lights.receive({ version: 1, source: 'preview', phase: 'stop', document: document(['1.102', '1.104']), song: null });
    expect(f.offs()).toEqual(['1.101', '1.104']);
    // The operator stops following: b's executors go off; P1 plays on, nothing more goes out.
    await f.send({ kind: 'stop' });
    await f.lights.settled();
    expect(f.offs()).toEqual(['1.101', '1.104', '1.102', '1.103']);
    f.play(songFrame(project, 'b') + 30, 30, b.endMs);
    await f.lights.settled();
    expect(f.offs()).toHaveLength(4);
    expect(f.lights.owed()).toEqual([]);
    expect(f.playMa2Cue.mock.calls.every(([request]) => request.action.target === 'executor' && request.action.action === 'off')).toBe(true);
  });

  it('关不掉的灯：记成错误、红字只出一次、留在清单里等退出时问；关掉跟随（close）也关这首的', async () => {
    const project = manualProject(['1.201', '1.202']);
    const f = fixture(project);
    f.status.state = 'disconnected';
    await f.start('manual');
    await f.send({ kind: 'arm', itemId: 'song' });
    f.play(0, 30, 1_000);
    await f.send({ kind: 'close' });
    // Two executors of one song that did not go off: one red line for the song.
    await vi.waitFor(() => expect(f.faults.length).toBeGreaterThan(0));
    expect(f.faults).toHaveLength(1);
    expect(f.faults[0]).toContain('歌曲');
    expect(f.lights.quitMessages()).toHaveLength(1);
    expect(f.lights.owed()).toMatchObject([{ executor: '1.201', cause: 'close' }, { executor: '1.202', cause: 'close' }]);
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('界面重新加载（2026-11-12）：跟随照跟、不关灯、授权和节目状态照旧；退出才结束并关这首的灯', async () => {
    const project = manualProject(['1.301']);
    const f = fixture(project);
    await f.start('manual'); await f.send({ kind: 'arm', itemId: 'song' });
    const first = f.play(0, 30, 1_000);
    await f.wiring.pageGone();
    expect(f.wiring.host.state).toMatchObject({ phase: 'running', ownerId: null, projectName: 'P1 手动跟随' });
    f.play(30, 30, first.endMs);
    await f.lights.settled();
    expect(f.offs()).toEqual([]);
    expect(f.running).toEqual([true]);
    expect(f.wiring.running()).toBe(true);
    expect(f.wiring.showInput()).toEqual({ state: 'running', itemId: 'song' });
    expect(f.release).not.toHaveBeenCalled();
    await f.wiring.dispose();
    await f.lights.settled();
    expect(f.offs()).toEqual(['1.301']);
    expect(f.running).toEqual([true, false]);
  });

  it('节目状态和授权：跟随时由主进程的跟随定，等下一首算拿着；停了交回', async () => {
    const f = fixture(manualProject([]));
    expect(f.wiring.showInput()).toBeUndefined();
    await f.start('manual');
    expect(f.wiring.showInput()).toBeNull();
    expect(f.running).toEqual([]);
    await f.send({ kind: 'arm', itemId: 'song' });
    expect(f.wiring.showInput()).toEqual({ state: 'armed', itemId: 'song' });
    expect(f.running).toEqual([true]);
    f.play(0, 30, 1_000);
    expect(f.wiring.showInput()).toEqual({ state: 'running', itemId: 'song' });
    await f.send({ kind: 'stop' });
    expect(f.wiring.showInput()).toBeNull();
    expect(f.running).toEqual([true, false]);
    expect(f.showChanged).toHaveBeenCalled();
    await f.wiring.dispose();
    expect(f.wiring.showInput()).toBeUndefined();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('每个阶段在节目状态里是什么', () => {
    const base = { version: 1, ownerId: OWNER, projectId: 'p', projectPath: 'C:/show.tblink', projectName: '演出', mode: 'manual', runMode: 'live', itemId: 'song', sessionId: null, generation: 0, positionMs: null,
      cause: null, reason: null, input: { portName: 'loopMIDI Port', state: 'open', reason: null }, mtc: null, outputs: { actionMidi: null } } as const;
    const show = (phase: P1FollowState['phase']) => p1FollowShowInput({ ...base, phase });
    expect([show('waiting'), show('preparing'), show('running'), show('frozen'), show('takeover'), show('failed')].map(input => input?.state))
      .toEqual(['armed', 'preflight', 'running', 'timecodeLost', 'paused', 'error']);
    expect(show('standby')).toBeNull();
    expect(p1FollowShowInput({ ...base, phase: 'closed', ownerId: null, projectId: null, projectPath: null, projectName: null, mode: null, runMode: null, input: null, itemId: null })).toBeUndefined();
    // Auto-follow listening for its first song runs nothing yet: the window's run was idle then; after a song it holds.
    const listening = { ...base, mode: 'auto', phase: 'waiting', itemId: null } as const;
    expect(p1FollowShowInput(listening)).toBeNull();
    expect(followRuns(listening)).toBe(false);
    expect(p1FollowShowInput({ ...listening, itemId: 'song' })).toEqual({ state: 'armed', itemId: 'song' });
    expect((['closed', 'standby', 'waiting', 'preparing', 'running', 'frozen', 'takeover', 'failed'] as const).map(phase => followRuns({ ...base, phase })))
      .toEqual([false, false, true, true, true, true, true, true]);
  });

  it('打开工程：联动台播放的工程、文件检查不过都不开始；P1 放的歌过不了授权就不开始，写明原因', async () => {
    const internal = fixture({ ...manualProject([]), playbackSource: 'internal' });
    await expect(internal.start('manual')).rejects.toThrow('只有“P1 跟随”的工程才能跟随 P1');
    expect(internal.listeners).toHaveLength(0);
    const files = fixture(manualProject([]), { refuseFiles: '找不到音频文件 assets/a.wav' });
    await expect(files.start('manual')).rejects.toThrow('找不到音频文件');
    expect(files.listeners).toHaveLength(0);
    const project = autoProject({ a: [], b: [] });
    const f = fixture(project);
    f.authorize.mockRejectedValueOnce(new Error('授权已过期，请重新激活'));
    await f.start('auto'); await f.send({ kind: 'arm', itemId: null });
    f.play(songFrame(project, 'b'), 30, 1_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'failed', itemId: 'b', reason: '授权已过期，请重新激活' }));
    expect(f.authorize).toHaveBeenCalledOnce();
  });

  it('动作 MIDI 自己报的状态随跟随的状态出去：开不了标红并写明原因', async () => {
    const project = manualProject([]);
    project.rundown[0]!.cues = [{ id: 'cue', name: '开场', timecode: frameNumberToTimecode(0, '30'), enabled: true, notes: '', actions: [
      { id: 'note', label: '开场', kind: 'midi.noteOn', portProfileId: 'out', channel: 1, note: 60, velocity: 100, durationMs: 100 }] }];
    const f = fixture(project);
    await f.start('manual'); await f.send({ kind: 'arm', itemId: 'song' });
    expect(f.wiring.host.state.outputs.actionMidi).toBeNull();
    f.play(0, 30, 1_000);
    await vi.waitFor(() => expect(f.states.at(-1)?.outputs.actionMidi).toMatchObject({ itemId: 'song', state: 'failed' }));
    expect(f.states.at(-1)?.outputs.actionMidi?.reason).toContain('MIDI 输出设置不存在');
    expect(f.wiring.host.state.outputs.actionMidi?.state).not.toBe('running');
  });

  it('授权（P4）：跟随在跑时授权失效，P1 放的下一首照常准备、照常开始，界面什么都不用确认；停了以后再待命要重新检查', async () => {
    const f = licensed(autoProject({ a: [], b: [] }));
    await f.start('auto'); await f.send({ kind: 'arm', itemId: null });
    const a = f.play(songFrame(f.project, 'a'), 30, 1_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'running', itemId: 'a' }));
    f.lapse(lapsedLicense.到期!);
    f.play(songFrame(f.project, 'b'), 30, a.lastSampleMs + 2_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'running', itemId: 'b', reason: null }));
    // Each song's preparation asked the license, and it held both times.
    expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(f.authorize.mock.settledResults.map(result => result.type)).toEqual(f.authorize.mock.calls.map(() => 'fulfilled'));
    expect(f.refused).not.toHaveBeenCalled();
    await f.send({ kind: 'stop' });
    await expect(f.send({ kind: 'arm', itemId: null })).rejects.toThrow('有效授权');
  });

  it('授权（P4）：自动选歌只在听、还没跟歌时不拿授权：这时失效，P1 点的第一首就不开始', async () => {
    const f = licensed(autoProject({ a: [], b: [] }));
    await f.start('auto'); await f.send({ kind: 'arm', itemId: null });
    f.lapse(lapsedLicense.到期!);
    f.play(songFrame(f.project, 'a'), 30, 1_000);
    await vi.waitFor(() => expect(f.wiring.host.state).toMatchObject({ phase: 'failed', itemId: 'a' }));
    expect(f.wiring.host.state.reason).toContain('有效授权');
  });

  it('授权（P4）：手动跟随待命时的检查通过以后，授权失效、界面不在，这首歌的输出照旧过授权', async () => {
    const f = licensed(manualProject([]));
    await f.start('manual'); await f.send({ kind: 'arm', itemId: 'song' });
    await vi.waitFor(() => expect(f.running).toEqual([true]));
    f.lapse(lapsedLicense.离线期到!);
    await f.wiring.pageGone();
    f.play(0, 30, 1_000);
    expect(f.wiring.host.state).toMatchObject({ phase: 'running', itemId: 'song' });
    await expect(f.access.requireOutput()).resolves.toBeUndefined();
    await f.send({ kind: 'stop' });
    await expect(f.access.requireOutput()).rejects.toThrow('有效授权');
  });
});

const validLicense: LicenseStatus = {
  machineCode: `TB1-${'A'.repeat(64)}`, state: 'active', message: '本机授权有效', enforcement: 'required', onlineAvailable: true,
  claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '测试客户', machineCode: `TB1-${'A'.repeat(64)}`,
    kind: 'subscription', issuedAt: '2026-09-27T00:00:00Z', useUntil: '2026-11-09T12:00:00Z', updatesUntil: '2027-09-27T00:00:00Z' }
};
const lapsedLicense: Record<string, LicenseStatus> = {
  到期: { ...validLicense, state: 'expired', message: '授权已到期；工程文件不受影响' },
  离线期到: { ...validLicense, state: 'renewal-required', message: '离线使用期已到，请联网验证一次授权（买断授权本身没有到期）' },
  时间回拨: { ...validLicense, state: 'invalid', claims: null, message: '读取或校验授权失败：检测到系统时间被调回过，请校正系统日期后联网验证' }
};

/** The follow on link-main's license: a real LicenseAccess and programLicense, valid until `lapse`. */
function licensed(project: LinkProject) {
  let status = validLicense;
  const access = new LicenseAccess(() => Promise.resolve(status));
  const gate: LicenseGate = { access, changing: () => false };
  const refused = vi.fn<(error: unknown) => void>();
  const outputs = programLicense(gate, { ready: Promise.resolve(), status: () => { throw new Error('这个测试不连控台'); }, send: () => Promise.resolve() }, refused);
  const f = fixture(project, { license: { ...gate, followRunning: running => { outputs.followRunningChanged(running); } } });
  return { ...f, project, access, refused, lapse: (next: LicenseStatus) => { status = next; } };
}

/** A song whose console timeline runs `executors`. */
function document(executors: string[]): LightingDocument {
  const track = (index: number) => lightingTrackSchema.parse({ id: `track-${index}`, name: `Track ${index}`, kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false,
    locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [] });
  const binding = lightingMa2BindingSchema.parse({ id: 'binding', timecode: 1, name: '歌曲', readAt: '2026-11-11T00:00:00.000Z', sourceXml: '<MA/>',
    baselineTracks: executors.map((_executor, index) => track(index)), mappings: [],
    trackMappings: executors.map((executor, index) => ({ trackId: `track-${index}`, path: `Track ${index}`, executor, subtracks: [] })) });
  return lightingDocumentSchema.parse({ ...createLightingDocument(), ma2Bindings: [binding] });
}

function manualProject(executors: string[]): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('P1 手动跟随'), schemaVersion: 2, playbackSource: 'p1', rundown: [{ id: 'song', title: '歌曲', cues: [],
    ...executors.length ? { lighting: document(executors) } : {} }] });
}

function autoProject(executors: Record<'a' | 'b', string[]>): LinkProject {
  const project = parseLinkProject({ ...createEmptyLinkProject('P1 自动选歌'), schemaVersion: 2, playbackSource: 'p1', rundown: (['a', 'b'] as const).map(id => ({
    id, title: id, cues: [], referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: 'a'.repeat(64), durationMs: 30_000 },
    ...executors[id].length ? { lighting: document(executors[id]) } : {}
  })) });
  project.p1AutoFollow = allocateP1TimecodeRanges(project);
  return project;
}

function songFrame(project: LinkProject, itemId: string): number {
  return project.p1AutoFollow!.ranges.find(range => range.itemId === itemId)!.startSeconds * FPS;
}

function at(ms: number): bigint { return BigInt(Math.round(ms * 10_000)); }
