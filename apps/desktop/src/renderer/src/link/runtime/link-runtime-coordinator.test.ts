import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject, type Ma2PlaybackRequest, type LinkAction } from '@tb/schema';
import { allocateP1TimecodeRanges, frameNumberToTimecode, type LinkDesktopApi } from '@tb/core/link';
import type { MtcQuarterFrameMessage } from '../../registry/link-midi-adapter';
import { LinkRuntimeCoordinator } from './link-runtime-coordinator';
import { useRuntimeStore } from '../stores/runtime-store';

const mocks = vi.hoisted(() => ({
  activateManagedObsOutput: vi.fn(() => Promise.resolve()),
  executeObsAction: vi.fn<(action: LinkAction) => Promise<void>>(),
  executeMidiAction: vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()),
  executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(),
  seekManagedMedia: vi.fn<LinkDesktopApi['seekManagedMedia']>(),
  prepareObsMediaScenes: vi.fn<LinkDesktopApi['prepareObsMediaScenes']>().mockResolvedValue(),
  recordLog: vi.fn<(entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise<void>>(() => Promise.resolve()),
  listener: null as ((message: MtcQuarterFrameMessage) => void) | null
}));
vi.mock('../view-models/link-desktop-view-model', () => ({
  linkDesktopViewModel: {
    recordLog: mocks.recordLog,
    activateManagedObsOutput: mocks.activateManagedObsOutput,
    executeObsAction: mocks.executeObsAction,
    executeManagedMediaEvent: mocks.executeManagedMediaEvent,
    seekManagedMedia: mocks.seekManagedMedia,
    prepareObsMediaScenes: mocks.prepareObsMediaScenes
  }
}));
vi.mock('../stores/integration-store', () => ({
  useIntegrationStore: { getState: () => ({
    obs: { status: 'connected' },
    setMidiPorts: () => undefined,
    profile: { p1: { mtcInputPortProfileId: 'mtc', expectedFrameRate: '30' }, midiPortProfiles: [] }
  }) }
}));
vi.mock('../../registry/link-midi-adapter', () => ({
  LinkMidiAdapter: class {
    supports(action: LinkAction) { return action.kind.startsWith('midi.'); }
    execute(action: LinkAction) { return mocks.executeMidiAction(action); }
    openOutputs() { return Promise.resolve([]); }
    initialize() { return Promise.resolve([]); }
    hasActiveMtcSubscription() { return mocks.listener !== null; }
    subscribePorts() { return () => undefined; }
    subscribeMtc(_id: string, _rate: string, listener: (message: MtcQuarterFrameMessage) => void) {
      mocks.listener = listener;
      return Promise.resolve(() => { mocks.listener = null; });
    }
    dispose() { mocks.listener = null; }
  }
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); mocks.executeObsAction.mockReset(); mocks.executeManagedMediaEvent.mockReset(); mocks.seekManagedMedia.mockReset(); useRuntimeStore.getState().reset(); });

describe('LinkRuntimeCoordinator', () => {
  it('内部停止与暂停记录具体原因，不记为操作员动作；操作员停止照旧记录', async () => {
    vi.stubGlobal('window', globalThis); mocks.recordLog.mockClear();
    const project = parseLinkProject({ ...createEmptyLinkProject('停止来源'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
    const coordinator = new LinkRuntimeCoordinator(project, 'C:/shows/test.tblink');
    const entries = () => mocks.recordLog.mock.calls.map(([entry]) => entry);
    const stateReasons = () => entries().filter(entry => entry.category === 'state').map(entry => entry.details?.['reason']);
    const operatorMessages = () => entries().filter(entry => entry.category === 'operator').map(entry => entry.message);
    try {
      await coordinator.stopAndWait(false, '开始播放前停止上一首');
      expect(stateReasons()).toContain('开始播放前停止上一首');
      expect(operatorMessages()).toEqual([]);
      mocks.recordLog.mockClear();
      await coordinator.stopAndWait();
      expect(stateReasons()).toContain('操作员请求停止');
      expect(operatorMessages()).toEqual(['停止运行']);
    } finally { coordinator.dispose(); }
  });
  it('停止拖动直接更新 OBS，保持 idle，不准备正式音频或布防', async () => {
    mocks.executeObsAction.mockResolvedValue();
    const project = parseLinkProject({ ...createEmptyLinkProject('编辑预览'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '节目', cues: [{ id: 'camera', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
        actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Camera' }] }] }] });
    const coordinator = new LinkRuntimeCoordinator(project, 'C:\\show\\show.tblink');
    try {
      await coordinator.previewEditor('song', 3000, false);
      expect(mocks.executeObsAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sceneName: 'Camera' }));
      expect(useRuntimeStore.getState().state).toBe('idle');
      mocks.executeObsAction.mockClear();
      const pending = coordinator.previewEditor('song', 4000, false);
      await coordinator.stopAndWait(); await pending;
      expect(mocks.executeObsAction).not.toHaveBeenCalled();
    } finally { coordinator.dispose(); }
  });
  it('定位失败后冻结后续拖动请求，显式停止后才能重新定位', async () => {
    mocks.executeObsAction.mockClear();
    mocks.executeObsAction.mockRejectedValueOnce(new Error('OBS 来源冲突')).mockResolvedValue();
    const project = parseLinkProject({ ...createEmptyLinkProject('错误冻结'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '节目', cues: [{ id: 'camera', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 },
        actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Camera' }] }] }] });
    const coordinator = new LinkRuntimeCoordinator(project, 'C:\\show\\show.tblink');
    try {
      await expect(coordinator.previewEditor('song', 3000, false)).rejects.toThrow('OBS 来源冲突');
      for (let position = 3100; position < 4000; position += 100) await coordinator.previewEditor('song', position, false);
      expect(mocks.executeObsAction).toHaveBeenCalledOnce();
      coordinator.cancelEditorPreview();
      await coordinator.previewEditor('song', 4000, false);
      expect(mocks.executeObsAction).toHaveBeenCalledTimes(2);
    } finally { coordinator.dispose(); }
  });
  // 2026-11-01: under P1 follow the console runs the lighting from P1's timecode; the timeline's Cues are never sent.
  it('P1 跟随只走时间码：旧工程存成网络输出的灯光时间线也不发 Cue，暂停和断流照常冻结', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    const playMa2Cue = vi.fn<(_request: Ma2PlaybackRequest) => Promise<void>>().mockResolvedValue();
    const cancelMa2Playback = vi.fn(() => Promise.resolve());
    vi.stubGlobal('window', { setInterval, clearInterval, tbLink: { playMa2Cue, cancelMa2Playback,
      getMa2NetworkStatus: () => Promise.resolve({ state: 'connected', settings: { host: '192.168.0.10', port: 30000, monitorPort: 30001, username: 'operator' }, passwordSaved: false, version: '3.9.60.74', error: null }) } });
    const lighting = { ...createLightingDocument(), outputMode: 'network' as const, tracks: [lightingTrackSchema.parse({ id: 'track', name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '灯光', start: 0, duration: 5000, timeLock: 'time', muted: false, events: [
      { id: 'cue', kind: 'ma2', action: 'goto', sequence: 168, cue: '2', executor: '', label: '正式', at: 400, preparation: { cue: '1', leadMs: 300 } },
      { id: 'skipped', kind: 'ma2', action: 'goto', sequence: 168, cue: '3', executor: '', label: '暂停期间', at: 600 },
      { id: 'lost', kind: 'ma2', action: 'goto', sequence: 168, cue: '4', executor: '', label: '断流后', at: 1200 }
    ] }] })] };
    const project = parseLinkProject({ ...createEmptyLinkProject('P1 灯光链路'), schemaVersion: 2, playbackSource: 'p1', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '测试', lighting }] });
    const coordinator = new LinkRuntimeCoordinator(project, null);
    try {
      coordinator.selectItem('song', false); await coordinator.initializeMidi(); coordinator.beginPreflight('live');
      await coordinator.applyPreflight({ checkedAt: new Date().toISOString(), mode: 'live', passed: true, checks: [] }); await coordinator.armFromStart();
      sendTimecode(0); await vi.advanceTimersByTimeAsync(133); sendTimecode(4); await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(133); sendTimecode(8); await vi.advanceTimersByTimeAsync(133); sendTimecode(12); await vi.advanceTimersByTimeAsync(1);
      coordinator.pause();
      for (const frame of [16, 20, 24]) { await vi.advanceTimersByTimeAsync(133); sendTimecode(frame); }
      coordinator.resume(); await vi.advanceTimersByTimeAsync(133); sendTimecode(28); await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(700);
      expect(useRuntimeStore.getState().state).toBe('timecodeLost');
      sendTimecode(40); await vi.advanceTimersByTimeAsync(1);
      await coordinator.stopAndWait();
      expect(playMa2Cue).not.toHaveBeenCalled(); expect(cancelMa2Playback).not.toHaveBeenCalled();
      expect(useRuntimeStore.getState().state).toBe('idle');
    } finally { coordinator.dispose(); }
  });
  it('显式停止将界面状态同步到已待机的控制器，不遗留暂停锁', async () => {
    const coordinator = new LinkRuntimeCoordinator(createEmptyLinkProject('停止状态同步'), null);
    useRuntimeStore.getState().setState({ state: 'paused', reason: '操作员暂停自动联动' });
    await coordinator.stopAndWait();
    expect(useRuntimeStore.getState().state).toBe('idle');
    expect(mocks.executeObsAction).not.toHaveBeenCalled();
    coordinator.dispose();
  });
  it('本机主控不订阅外部时间码：输出回环收到的时间码不会启动或改变联动', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
    const project = parseLinkProject({ ...createEmptyLinkProject('本机时钟隔离'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
    const coordinator = new LinkRuntimeCoordinator(project, null);
    try {
      await coordinator.initializeMidi();
      expect(mocks.listener).toBeNull();
      sendTimecode(1800);
      expect(useRuntimeStore.getState().state).toBe('idle');
    } finally { coordinator.dispose(); }
  });
  it('十首带视频节目循环三轮，上一首停止后才启动下一首，最终无活动素材', async () => {
    const playMa2Cue = vi.fn<(_request: Ma2PlaybackRequest) => Promise<void>>().mockResolvedValue();
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined, tbLink: { playMa2Cue, cancelMa2Playback: () => Promise.resolve(), getMa2NetworkStatus: () => Promise.resolve({ state: 'connected', settings: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, passwordSaved: false, version: '3.9.60.74', error: null }) } });
    mocks.executeObsAction.mockResolvedValue();
    const active = new Set<string>();
    const order: string[] = [];
    mocks.executeManagedMediaEvent.mockImplementation(({ event }) => {
      if (event.phase === 'start') {
        expect(active.size).toBe(0);
        active.add(event.clipId);
      } else {
        expect(active.delete(event.clipId)).toBe(true);
      }
      order.push(`${event.phase}:${event.clipId}`);
      return Promise.resolve();
    });
    const project = parseLinkProject({ ...createEmptyLinkProject('十首素材连续联动'), schemaVersion: 2,
      mediaAssets: [{ id: 'video', name: 'original.mp4', kind: 'video', relativePath: 'assets/reference-media/original.mp4',
        sha256: 'a'.repeat(64), byteLength: 100, durationMs: 30_000, width: 1080, height: 1920 }],
      rundown: Array.from({ length: 10 }, (_, index) => ({ id: `song-${index}`, title: `歌曲 ${index}`,
        lighting: { ...createLightingDocument(), outputMode: 'network', tracks: [lightingTrackSchema.parse({ id: `lighting-${index}`, name: '灯光', kind: 'ma2', color: '#ffffff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: `lighting-clip-${index}`, name: '开场', start: 0, duration: 30000, timeLock: 'time', muted: false, events: [{ id: `lighting-cue-${index}`, at: 0, kind: 'ma2', sequence: index + 1, cue: '1', executor: '', action: 'goto', label: '开场' }] }] })] },
        referenceAudio: { assetId: `audio-${index}`, relativePath: `assets/${index}.wav`, sha256: 'b'.repeat(64), durationMs: 30_000 },
        visualLayers: [{ id: `layer-${index}`, name: '视频' }],
        referenceMediaClips: [{ id: `clip-${index}`, assetId: 'video', layerId: `layer-${index}`,
          startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 30_000, label: '原始视频' }]
      })) });
    project.p1AutoFollow = allocateP1TimecodeRanges(project);
    const coordinator = new LinkRuntimeCoordinator(project, 'C:\\show\\ten.tblink');
    try {
      await coordinator.enableP1AutoFollow(async () => {
        coordinator.beginPreflight('live');
        const report = { checkedAt: new Date().toISOString(), mode: 'live' as const, passed: true, checks: [] };
        await coordinator.applyPreflight(report);
        return report;
      });
      for (let turn = 0; turn < 30; turn += 1) {
        const index = turn % 10;
        sendTimecode((60 + index * 40) * 30);
        await vi.waitFor(() => expect(order).toHaveLength(turn * 2 + 1), { interval: 1 });
        expect(useRuntimeStore.getState().currentItemId).toBe(`song-${index}`);
        expect(active).toEqual(new Set([`clip-${index}`]));
      }
      // The console follows P1's timecode for each song's lighting; nothing is sent from the timeline (2026-11-01).
      expect(playMa2Cue).not.toHaveBeenCalled();
      coordinator.stop();
      await vi.waitFor(() => expect(useRuntimeStore.getState().state).toBe('idle'), { interval: 1 });
      expect(active.size).toBe(0);
      expect(order).toEqual(Array.from({ length: 30 }, (_, turn) => [`start:clip-${turn % 10}`, `stop:clip-${turn % 10}`]).flat());
    } finally { coordinator.dispose(); }
  });
  it('停止后跳过尚未发送的时间线批次，等待在途动作再完成清理', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
    useRuntimeStore.getState().reset();
    let release = (): void => { throw new Error('尚未初始化'); };
    mocks.executeObsAction.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const project = parseLinkProject({
      ...createEmptyLinkProject('停止回归'),
      rundown: [{ id: 'item', title: '节目', notes: '', cues: [0, 4].map((frame) => ({
        id: `cue-${frame}`, name: `Cue ${frame}`, timecode: { hours: 0, minutes: 0, seconds: 0, frames: frame },
        enabled: true, notes: '', actions: [{ id: `action-${frame}`, label: '切场景', kind: 'obs.setProgramScene', sceneName: '测试' }]
      })) }]
    });
    const coordinator = new LinkRuntimeCoordinator(project, null);
    try {
      coordinator.selectItem('item', false);
      await coordinator.initializeMidi();
      coordinator.beginPreflight('live');
      await coordinator.applyPreflight({ checkedAt: new Date().toISOString(), mode: 'live', passed: true, checks: [] });
      await coordinator.armFromStart();
      sendFrame(0, 0);
      await vi.waitFor(() => expect(mocks.executeObsAction).toHaveBeenCalledTimes(1));
      sendFrame(4, 133);
      coordinator.stop();
      expect(useRuntimeStore.getState().state).toBe('stopping');
      release();
      await vi.waitFor(() => expect(useRuntimeStore.getState().state).toBe('idle'));
      expect(mocks.executeObsAction).toHaveBeenCalledTimes(1);
      expect(useRuntimeStore.getState().reports.flatMap((report) => report.results).map((result) => result.status))
        .toEqual(['succeeded', 'skipped']);
    } finally { coordinator.dispose(); }
  });
});

function sendFrame(frame: number, receivedAt: number): void {
  const values = [frame & 15, (frame >> 4) & 1, 0, 0, 0, 0, 0, 6];
  values.forEach((value, messageType) => mocks.listener?.({ messageType, value, receivedAt }));
}

function sendTimecode(totalFrames: number): void {
  const tc = frameNumberToTimecode(totalFrames, '30');
  const values = [tc.frames & 15, tc.frames >> 4, tc.seconds & 15, tc.seconds >> 4,
    tc.minutes & 15, tc.minutes >> 4, tc.hours & 15, (tc.hours >> 4) | 6];
  values.forEach((value, messageType) => mocks.listener?.({ messageType, value, receivedAt: performance.now() }));
}
