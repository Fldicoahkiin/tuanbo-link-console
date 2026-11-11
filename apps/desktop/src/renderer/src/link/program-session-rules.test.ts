import * as React from 'react';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkProject, type NativePlayerControl, type NativePlayerPrepare, type NativePlayerStatus,
  type NativeProgramDocument, type NativeProgramDocumentAnswer, type NativeProgramEvent, type NativeProgramClosed } from '@tb/schema';
import { updateRundownItemCommand, type LinkDesktopApi, type ProgramLightingOutput } from '@tb/core/link';

/**
 * 后台唯一播放会话的规则（0.5.9 S7，design 02 §3.2–§3.7）：一个窗口页面一个长期的节目，修改只把新的一版送过去，不关、不
 * 重开；播放器自己的设置（播完后、歌单、时间码开关）不随修改变；版本按 (sessionId, revision) 认，换了 sessionId 或节目要求
 * 重送时整份重送；退出取消、错误画面上的“重新进入工作区”以后照常接回。界面按 LinkApp 的接法（useInternalPlayer，每次修改
 * 都换 project 和 coordinator），主进程是真的 NativeProgramService、NativeProgramHost 和 NativeProgramPlayer，只有音频引擎、
 * OBS、控台和 MIDI 设备是假的。改代码让这里失败，就是违反了这些规则。
 */

// The smallest document react-dom needs (as CueWorkspace.render-count.test.ts): the hooks under test draw nothing.
vi.hoisted(() => {
  class FakeNode {
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];
    constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeNode | null) {}
    get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
    get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
    get nextSibling(): FakeNode | null { const siblings = this.parentNode?.childNodes ?? []; return siblings[siblings.indexOf(this) + 1] ?? null; }
    get textContent(): string { return ''; }
    set textContent(_value: string) { this.childNodes = []; }
    appendChild(child: FakeNode): FakeNode { this.childNodes.push(child); child.parentNode = this; return child; }
    insertBefore(child: FakeNode, before: FakeNode | null): FakeNode { return before ? (this.childNodes.splice(this.childNodes.indexOf(before), 0, child), child) : this.appendChild(child); }
    removeChild(child: FakeNode): FakeNode { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
    addEventListener(): void { /* events are not sent in this test */ }
    removeEventListener(): void { /* events are not sent in this test */ }
  }
  class FakeElement extends FakeNode {
    readonly style = {};
    constructor(readonly tagName: string, readonly namespaceURI: string, owner: FakeNode | null) { super(1, tagName, owner); }
    setAttribute(): void { /* nothing is drawn */ }
    removeAttribute(): void { /* nothing is drawn */ }
  }
  const html = 'http://www.w3.org/1999/xhtml';
  const document = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
  const root = new FakeElement('HTML', html, document), body = new FakeElement('BODY', html, document);
  root.appendChild(body); document.appendChild(root);
  Object.assign(document, { documentElement: root, body, activeElement: null,
    createElement: (tag: string) => new FakeElement(tag.toUpperCase(), html, document), createTextNode: () => new FakeNode(3, '#text', document) });
  const saved = new Map<string, string>();
  const window = { document, event: undefined, HTMLIFrameElement: class {}, addEventListener: (): void => undefined, removeEventListener: (): void => undefined,
    setInterval, clearInterval, setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); },
      removeItem: (key: string) => { saved.delete(key); }, clear: () => saved.clear(), key: () => null, length: 0 } };
  Object.assign(globalThis, { window, document, localStorage: window.localStorage, IS_REACT_ACT_ENVIRONMENT: true });
});

type Page = Pick<LinkDesktopApi, 'openNativeProgram' | 'controlNativeProgram' | 'documentNativeProgram' | 'onNativeProgramEvent' | 'onNativeProgramClosed'
  | 'onNativePlaybackStatus' | 'recordLog'>;
/** The window's preload bridge (window.tbLink, through linkDesktopViewModel): this test points it at the main process below. */
const bridge = vi.hoisted(() => ({ page: null as Page | null }));
vi.mock('./view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: new Proxy({}, {
  get: (_target, key: string) => (...args: unknown[]) => {
    const page = bridge.page as Record<string, (...values: unknown[]) => unknown> | null;
    const method = page?.[key];
    if (!method) throw new Error(`这个测试没有接 ${key}`);
    return method(...args);
  }
}) }));
/** The action MIDI channels the main process opened: one per program host. */
const midiHosts = vi.hoisted(() => ({ made: 0, prepared: [] as LinkProject[] }));
vi.mock('../../../main/link/native-midi-host', () => ({
  NativeMidiHost: class {
    constructor() { midiHosts.made += 1; }
    prepare(project: LinkProject): Promise<void> { midiHosts.prepared.push(project); return Promise.resolve(); }
    stop(): Promise<void> { return Promise.resolve(); }
    observe(): void { /* no MIDI device in this test */ }
    interrupt(): void { /* no MIDI device in this test */ }
  }
}));

const { createRoot } = await import('react-dom/client');
const { useDocumentStore } = await import('./stores/document-store');
const { useInternalPlayer, programConfiguration, programDocument } = await import('./useInternalPlayer');
const { RemoteNativeProgramPlayer, PROGRAM_PAGE_OWNER } = await import('./runtime/remote-native-program-player');
const { ProgramDocumentFeed } = await import('./runtime/program-document-feed');
const { NativeProgramService } = await import('../../../main/link/native-program-service');
const { NativeProgramHost } = await import('../../../main/link/native-program-host');
const { closedProgramFaultReporter } = await import('../../../main/link/main-process-errors');
const { quitInOrder } = await import('../../../main/link/quit-order');
type Coordinator = Parameters<typeof useInternalPlayer>[0];
type Player = ReturnType<typeof useInternalPlayer>;

const PATH = 'C:/show/现场.tblink';
const referenceAudio = { assetId: 'audio', relativePath: 'song.wav', sha256: 'a'.repeat(64), durationMs: 10000 };
const playback = { startMs: 0, endMs: 9000, mtcOffsetMs: 480000, volume: 100, endAction: 'pause' as const, shortcut: '' };
const show = () => parseLinkProject({ ...createEmptyLinkProject('现场'), playbackSource: 'internal',
  rundown: [{ id: 'song', title: '开场', referenceAudio, playback }, { id: 'next', title: '第二首', referenceAudio, playback }] });

/** The main process as link-main wires it, with a fake playback engine; each page talks to it through its own bridge. */
function mainProcess() {
  let audio: NativePlayerStatus | null = null;
  const engine: NativePlayerControl['kind'][] = [], prepared: NativePlayerPrepare[] = [];
  const hosts: InstanceType<typeof NativeProgramHost>[] = [];
  let closes = 0;
  const pages = new Set<{ event: Set<(event: NativeProgramEvent) => void>; closed: Set<(closed: NativeProgramClosed) => void> }>();
  const lighting: ProgramLightingOutput = { change: () => Promise.resolve({ failed: [] }), stop: () => Promise.resolve({ failed: [] }) };
  const service = new NativeProgramService((project, request, callbacks) => {
    const host = new NativeProgramHost(project, request.projectPath, request.revision, {
      executable: 'tblink-playback.exe', audio: () => audio, midiOutputs: () => Promise.resolve([]), authorize: () => Promise.resolve(),
      configuration: () => callbacks.configuration(), preciseSeeking: () => false, changed: state => callbacks.changed(state),
      midiChanged: () => undefined, midiRecovered: () => undefined, notice: () => undefined, closedFault: (message, itemId) => callbacks.closedFault(message, itemId), lighting,
      api: {
        prepareNativePlayback: request => {
          prepared.push(request); const s = request.snapshot;
          audio = { version: 1, sessionId: request.sessionId, generation: request.generation, itemId: s.itemId, status: 'ready', positionMs: s.positionMs,
            offsetMs: s.offsetMs, sampleRate: s.sampleRate, enginePid: 1, engineTitle: 'TBLINK Audio 1', mtcPortName: null, mtcSent: 0, audioError: null,
            mtcError: null, underruns: 0, mtcInterruptions: 0, gain: s.volume, analysis: null };
          return Promise.resolve(audio);
        },
        controlNativePlayback: command => {
          engine.push(command.kind);
          if (!audio) return Promise.reject(new Error('没有准备音频'));
          audio = { ...audio, generation: command.generation, status: command.kind === 'play' ? 'playing' : command.kind === 'pause' ? 'paused'
            : command.kind === 'stop' ? 'stopped' : audio.status };
          return Promise.resolve(audio);
        },
        getNativePlaybackDevices: () => Promise.resolve({ protocol: 4, audio: [], midiOutputs: [], midiInputs: [] }),
        prepareNativeObs: () => Promise.reject(new Error('测试没有 OBS')), stopNativeObs: () => Promise.resolve(), onNativeObsStatus: () => () => undefined,
        preloadNativeObs: () => Promise.resolve(), cancelNativeObsPreload: () => Promise.resolve()
      }
    });
    hosts.push(host);
    return { controller: host.controller, close: () => { closes += 1; return host.close(); } };
  }, event => {
    // Events reach a page after the call that sent them, as over IPC.
    const copy = structuredClone(event);
    queueMicrotask(() => { for (const page of pages) for (const listener of page.event) listener(copy); });
  }, () => Promise.resolve(), () => undefined, closedProgramFaultReporter(() => Promise.resolve(), () => undefined));
  const opens = vi.spyOn(service, 'open');
  const documents: NativeProgramDocument[] = [];
  /** A page's bridge: invokes run after the call, in the order sent ('listener' channels, link-main). */
  const page = () => {
    const listeners = { event: new Set<(event: NativeProgramEvent) => void>(), closed: new Set<(closed: NativeProgramClosed) => void>() };
    pages.add(listeners);
    const api = {
      openNativeProgram: vi.fn<Page['openNativeProgram']>(request => service.open(structuredClone(request))),
      controlNativeProgram: vi.fn<Page['controlNativeProgram']>(request => Promise.resolve().then(() => service.control(structuredClone(request)))),
      documentNativeProgram: vi.fn<Page['documentNativeProgram']>(request => Promise.resolve().then((): NativeProgramDocumentAnswer => {
        documents.push(structuredClone(request)); return service.document(structuredClone(request));
      })),
      onNativeProgramEvent: (listener: (event: NativeProgramEvent) => void) => { listeners.event.add(listener); return () => { listeners.event.delete(listener); }; },
      onNativeProgramClosed: (listener: (closed: NativeProgramClosed) => void) => { listeners.closed.add(listener); return () => { listeners.closed.delete(listener); }; },
      onNativePlaybackStatus: () => () => undefined,
      recordLog: vi.fn<Page['recordLog']>(() => Promise.reject(new Error('这个测试里不该记提示')))
    } satisfies Page;
    /** The page is gone (reloaded): nothing reaches it any more. */
    const gone = () => { pages.delete(listeners); };
    const closed = (ownerId: string) => { for (const listener of listeners.closed) listener({ version: 1, ownerId }); };
    return { api, gone, closed };
  };
  return { service, hosts, opens, documents, engine, prepared, page, closes: () => closes, audio: () => audio, player: () => hosts.at(-1)!.controller };
}

/** LinkApp as far as the player goes: the project shown, a coordinator made again with each project, useInternalPlayer. */
function AppWindow({ seen }: { seen: { player: Player | null } }): null {
  const project = useDocumentStore(state => state.project);
  const [coordinator, setCoordinator] = React.useState<Coordinator>(null);
  React.useEffect(() => {
    if (!project) { setCoordinator(null); return; }
    // A coordinator per project, as LinkApp makes one; the player only binds its stop.
    const next = { onInternalStop: vi.fn() } satisfies Pick<NonNullable<Coordinator>, 'onInternalStop'>;
    setCoordinator(next as unknown as Coordinator);
  }, [project]);
  seen.player = useInternalPlayer(coordinator, true, project);
  return null;
}

let unmount: (() => void) | null = null;
afterEach(() => {
  React.act(() => { unmount?.(); });
  unmount = null; bridge.page = null; midiHosts.made = 0; midiHosts.prepared = [];
  useDocumentStore.getState().setProject(null, null);
});
const settle = () => React.act(() => new Promise<void>(resolve => { setTimeout(resolve, 5); }));

async function openWindow() {
  const main = mainProcess(), page = main.page();
  bridge.page = page.api;
  useDocumentStore.getState().setProject(show(), PATH);
  const seen: { player: Player | null } = { player: null };
  const root = createRoot(document.createElement('div') as unknown as Element);
  unmount = () => root.unmount();
  React.act(() => { root.render(React.createElement(AppWindow, { seen })); });
  await settle();
  const player = () => { const current = seen.player?.controller; if (!current) throw new Error('窗口没有播放器'); return current; };
  return { main, page, seen, player };
}
const edit = (title: string) => React.act(() => {
  useDocumentStore.getState().execute(updateRundownItemCommand('song', { title, enabled: true, notes: '' }));
});

describe('一个窗口页面一个长期的节目（0.5.9 S7）', () => {
  it('停着时改 10 次：主进程只打开 1 次、不关；节目手里的是最后一版', { timeout: 60000 }, async () => {
    const w = await openWindow();
    expect(w.main.opens).toHaveBeenCalledOnce();
    for (let round = 1; round <= 10; round += 1) { edit(`第 ${round} 版`); await settle(); }
    expect(w.main.opens).toHaveBeenCalledOnce();
    expect(w.main.hosts).toHaveLength(1); expect(w.main.closes()).toBe(0);
    expect(w.page.api.controlNativeProgram.mock.calls.map(call => call[0].operation.kind)).not.toContain('close');
    expect(w.main.player().currentProject().rundown[0]!.title).toBe('第 10 版');
    expect(w.main.documents.at(-1)).toMatchObject({ revision: useDocumentStore.getState().revision, change: { kind: 'full' } });
    // The window knows the version on air exactly.
    expect(w.seen.player).toMatchObject({ outdated: false });
    expect(w.seen.player?.programProject?.rundown[0]!.title).toBe('第 10 版');
  });

  it('改了以后播放器自己的设置不变：播放条上的“播完后”、选的歌单、时间码开关', { timeout: 60000 }, async () => {
    const w = await openWindow();
    React.act(() => { w.player().setEndAction('next'); w.player().setPlaylist('all'); w.player().toggleMtc(); });
    await settle();
    expect(w.seen.player?.state).toMatchObject({ endAction: 'next', defaultEndAction: 'next', playlistId: 'all', mtcEnabled: false });
    for (let round = 1; round <= 10; round += 1) { edit(`第 ${round} 版`); await settle(); }
    expect(w.seen.player?.state).toMatchObject({ endAction: 'next', defaultEndAction: 'next', playlistId: 'all', mtcEnabled: false });
    await React.act(() => w.player().play('song'));
    await settle();
    expect(w.main.prepared).toHaveLength(1);
    expect(w.main.prepared[0]!.midiPortName).toBeNull();
    expect(w.seen.player?.state).toMatchObject({ status: 'playing', defaultEndAction: 'next', mtcEnabled: false });
  });

  it('播放中改：不关、不重开，这首歌照旧；停下以后下一首用最后一版，动作 MIDI 也按它准备', { timeout: 60000 }, async () => {
    const w = await openWindow();
    await React.act(() => w.player().play('song')); await settle();
    for (let round = 1; round <= 5; round += 1) { edit(`播放中第 ${round} 版`); await settle(); }
    expect(w.main.opens).toHaveBeenCalledOnce(); expect(w.main.closes()).toBe(0);
    expect(w.main.player().currentProject().rundown[0]!.title).toBe('开场');
    expect(w.seen.player?.programProject?.rundown[0]!.title).toBe('开场');
    await React.act(() => w.player().stop()); await settle();
    expect(w.main.player().currentProject().rundown[0]!.title).toBe('播放中第 5 版');
    await React.act(() => w.player().play('song')); await settle();
    expect(midiHosts.prepared.at(-1)?.rundown[0]!.title).toBe('播放中第 5 版');
    expect(midiHosts.made).toBe(1);
  });

  it('改完马上播放：播的是刚改的这一版（播放跟在最新的一版后面）', { timeout: 60000 }, async () => {
    const w = await openWindow();
    await React.act(async () => {
      useDocumentStore.getState().execute(updateRundownItemCommand('song', { title: '刚改的', enabled: true, notes: '' }));
      useDocumentStore.getState().execute(updateRundownItemCommand('song', { title: '又改了', enabled: true, notes: '' }));
      await w.player().play('song');
    });
    await settle();
    expect(midiHosts.prepared.at(-1)?.rundown[0]!.title).toBe('又改了');
  });

  it('换了 sessionId（重新打开了同一个文件）：整份重送，不重开；窗口认得节目播的这一版', { timeout: 60000 }, async () => {
    const w = await openWindow();
    const before = useDocumentStore.getState().sessionId;
    React.act(() => { useDocumentStore.getState().setProject(structuredClone(useDocumentStore.getState().project), PATH); });
    await settle();
    const { sessionId, revision } = useDocumentStore.getState();
    expect(sessionId).not.toBe(before);
    expect(w.main.opens).toHaveBeenCalledOnce();
    expect(w.main.documents.at(-1)).toMatchObject({ key: { sessionId }, revision, base: null, change: { kind: 'full', document: JSON.stringify(useDocumentStore.getState().project) } });
    expect(w.seen.player).toMatchObject({ outdated: false });
  });

  it('换了别的工程：停着时打开另一个节目，只关上一个', { timeout: 60000 }, async () => {
    const w = await openWindow();
    React.act(() => { useDocumentStore.getState().setProject(show(), 'C:/show/另一场.tblink'); });
    await settle();
    expect(w.main.opens).toHaveBeenCalledTimes(2); expect(w.main.hosts).toHaveLength(2); expect(w.main.closes()).toBe(1);
  });

  // 复查 A：同一页所有节目用同一个 owner，页面丢掉不比上一条新的事件；新节目的事件要接着往上数。
  it('旧节目已经发过很多事件以后，同一页再开一个节目：页面跟得上新节目的状态', { timeout: 60000 }, async () => {
    const w = await openWindow();
    for (let round = 0; round < 40; round += 1) React.act(() => { w.player().setEndAction(round % 2 ? 'next' : 'stop'); });
    await settle();
    await React.act(() => w.player().play('song')); await settle();
    await React.act(() => w.player().stop()); await settle();
    React.act(() => { useDocumentStore.getState().setProject(show(), 'C:/show/另一场.tblink'); });
    await settle();
    expect(w.main.hosts).toHaveLength(2);
    await React.act(() => w.player().play('next')); await settle();
    expect(w.main.audio()).toMatchObject({ itemId: 'next', status: 'playing' });
    expect(w.seen.player?.state).toMatchObject({ status: 'playing', itemId: 'next' });
    expect(w.seen.player?.programProject?.projectId).toBe(useDocumentStore.getState().project?.projectId);
  });

  // 复查 B：一版没送进去，下一次开歌的控制先把最新一版再送一次；别的时候不自己重送。
  it('一版没送进节目以后：没在播时的事件不重送，下一次按播放先再送一次，放的是这一版', { timeout: 60000 }, async () => {
    const w = await openWindow();
    w.page.api.documentNativeProgram.mockImplementationOnce(() => Promise.reject(new Error('节目这边没收到')));
    edit('没送进去的这一版'); await settle();
    expect(w.page.api.documentNativeProgram).toHaveBeenCalledOnce();
    expect(w.main.player().currentProject().rundown[0]!.title).toBe('开场');
    // Events while stopped do not send it again.
    for (let round = 0; round < 5; round += 1) React.act(() => { w.player().setEndAction(round % 2 ? 'next' : 'stop'); });
    await settle();
    expect(w.page.api.documentNativeProgram).toHaveBeenCalledOnce();
    await React.act(() => w.player().play('song')); await settle();
    expect(w.page.api.documentNativeProgram).toHaveBeenCalledTimes(2);
    expect(midiHosts.prepared.at(-1)?.rundown[0]!.title).toBe('没送进去的这一版');
    await React.act(() => w.player().stop()); await settle();
    await React.act(() => w.player().play('song')); await settle();
    expect(w.page.api.documentNativeProgram).toHaveBeenCalledTimes(2);
  });
});

describe('节目要求整份重送时', () => {
  it('答复 resync：同一版整份再送一次；再要求一次就标红，不再自己重送', async () => {
    const project = show(), sessionId = randomUUID();
    let current = { project, path: PATH, sessionId, revision: 1 };
    const answers: NativeProgramDocumentAnswer[] = [{ kind: 'resync', reason: '节目这边没有这一版' }, { kind: 'applied', revision: 2, effect: 'stopped' }];
    const send = vi.fn((request: NativeProgramDocument): Promise<NativeProgramDocumentAnswer> => Promise.resolve(answers.shift() ?? { kind: 'resync', reason: `第 ${request.revision} 版还是不行` }));
    const failed = vi.fn();
    const feed = new ProgramDocumentFeed(randomUUID(), () => current, send, failed);
    feed.attached(current);
    current = { ...current, revision: 2 }; feed.changed();
    await new Promise(resolve => setTimeout(resolve, 0));
    const whole: unknown = expect.objectContaining({ revision: 2, base: null, change: { kind: 'full', document: JSON.stringify(project) } });
    expect(send.mock.calls.map(call => call[0])).toEqual([whole, whole]);
    expect(failed).not.toHaveBeenCalled();
    current = { ...current, revision: 3 }; feed.changed();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(4);
    expect(failed).toHaveBeenCalledExactlyOnceWith('这次修改没送进节目：第 3 版还是不行');
  });
});

describe('退出取消、重新进入工作区以后照常接回', () => {
  // design 059 00-order 交叉冲突 #9：退出取消时 quitInOrder 告诉窗口它的节目关了，窗口重新打开。
  it('退出时关了节目、灯光没关掉、选“返回软件”：窗口重新打开节目，下一首照常播', { timeout: 60000 }, async () => {
    const w = await openWindow();
    const quitted = await quitInOrder({
      stopAudition: () => Promise.resolve(true), askExternalPrograms: () => Promise.resolve([]), songStarted: () => false,
      program: w.main.service, faults: { collect: async run => { await run(); return ['「开场」的灯光没能完全关闭'] as const; } },
      quitWithLightsOn: () => Promise.resolve(false), programClosed: closed => w.page.closed(closed.ownerId),
      closeOutputs: () => Promise.resolve(), finish: () => Promise.resolve(), record: () => undefined
    });
    expect(quitted).toBe(false);
    await settle();
    expect(w.main.opens).toHaveBeenCalledTimes(2); expect(w.main.closes()).toBe(1);
    await React.act(() => w.player().play('song')); await settle();
    expect(w.seen.player?.state).toMatchObject({ status: 'playing', error: null });
    expect(w.page.api.recordLog).not.toHaveBeenCalled();
  });

  // design 059 00-order 缺口 #5：错误画面上的“重新进入工作区”重新加载界面，新页面接回还在播的节目，MIDI 不另开一份。
  it('播放中重新进入工作区：新页面接回同一个节目，歌不停、不建第二个宿主、动作 MIDI 只有一份；接回以后照常控制', { timeout: 60000 }, async () => {
    const w = await openWindow();
    await React.act(() => w.player().play('song')); await settle();
    expect(midiHosts.made).toBe(1);
    // The page reloads: nothing more reaches the old one, and main lets its program play on (window-page.ts → release).
    w.page.gone();
    expect(await w.main.service.release()).toMatchObject({ status: 'playing' });
    // The new page: the same document store state (the recovery copy reopens the same project), a new page owner.
    const page = w.main.page(), states: string[] = [];
    let attached = 0;
    const reloaded = new RemoteNativeProgramPlayer({ configuration: programConfiguration, document: programDocument, preciseSeeking: () => false,
      changed: state => states.push(state.status), notice: vi.fn(), attached: () => { attached += 1; } }, page.api, vi.fn(), randomUUID());
    await settle();
    expect(reloaded.attached).toBe(true); expect(attached).toBe(1);
    expect(reloaded.project).toBe(useDocumentStore.getState().project);
    expect(w.main.hosts).toHaveLength(1); expect(w.main.closes()).toBe(0); expect(midiHosts.made).toBe(1);
    expect(w.main.engine).not.toContain('stop');
    expect(w.main.audio()?.status).toBe('playing');
    expect(states.at(-1)).toBe('playing');
    await reloaded.stop(); await settle();
    expect(w.main.engine).toContain('stop');
    expect(PROGRAM_PAGE_OWNER).not.toBe(w.main.service.owner());
    await reloaded.dispose();
  });
});
