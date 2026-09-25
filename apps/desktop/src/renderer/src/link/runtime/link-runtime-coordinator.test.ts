import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { allocateP1TimecodeRanges, frameNumberToTimecode, type LinkDesktopApi } from '@tb/core/link';
import type { MtcQuarterFrameMessage } from '../../registry/link-midi-adapter';
import { LinkRuntimeCoordinator } from './link-runtime-coordinator';
import { useRuntimeStore } from '../stores/runtime-store';

const mocks = vi.hoisted(() => ({
  activateManagedObsOutput: vi.fn(() => Promise.resolve()),
  setInternalAudioCapture: vi.fn(() => Promise.resolve()),
  executeObsAction: vi.fn<() => Promise<void>>(),
  executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(),
  seekManagedMedia: vi.fn<LinkDesktopApi['seekManagedMedia']>(),
  listener: null as ((message: MtcQuarterFrameMessage) => void) | null
}));
vi.mock('../view-models/link-desktop-view-model', () => ({
  linkDesktopViewModel: {
    recordLog: vi.fn(() => Promise.resolve()),
    activateManagedObsOutput: mocks.activateManagedObsOutput,
    setInternalAudioCapture: mocks.setInternalAudioCapture,
    executeObsAction: mocks.executeObsAction,
    executeManagedMediaEvent: mocks.executeManagedMediaEvent,
    seekManagedMedia: mocks.seekManagedMedia
  }
}));
vi.mock('../stores/integration-store', () => ({
  useIntegrationStore: { getState: () => ({
    setMidiPorts: () => undefined,
    profile: { p1: { mtcInputPortProfileId: 'mtc', expectedFrameRate: '30' }, midiPortProfiles: [] }
  }) }
}));
vi.mock('../../registry/link-midi-adapter', () => ({
  LinkMidiAdapter: class {
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
  it('慢速准备与暂停继续不误报断流、不重复启动素材；真正开始后仍检测断流', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.stubGlobal('window', { setInterval, clearInterval });
    mocks.executeObsAction.mockResolvedValue(); mocks.executeManagedMediaEvent.mockResolvedValue(); mocks.seekManagedMedia.mockResolvedValue();
    const project = parseLinkProject({ ...createEmptyLinkProject('慢启动回归'), playbackSource: 'internal', obsOutputMode: 'scenes',
      mediaAssets: [{ id: 'alpha', name: '特效', kind: 'video', relativePath: 'alpha.mov', sha256: 'a'.repeat(64), byteLength: 100, durationMs: 5000, width: 1080, height: 1920 }],
      rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'top', name: '叠加' }, { id: 'bottom', name: '机位' }],
        referenceMediaClips: [{ id: 'clip', label: '透明特效', assetId: 'alpha', layerId: 'top', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 5000 }],
        cues: [{ id: 'camera', name: '机位', layerId: 'bottom', durationMs: 5000, timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, actions: [{ id: 'switch', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Camera' }] }] }] });
    const coordinator = new LinkRuntimeCoordinator(project, 'C:\\show\\alpha.tblink');
    const preflight = async () => { coordinator.beginPreflight('live'); const report = { checkedAt: new Date().toISOString(), mode: 'live' as const, passed: true, checks: [] }; await coordinator.applyPreflight(report); return report; };
    try {
      await coordinator.initializeMidi();
      await coordinator.prepareInternal('song', preflight);
      mocks.executeManagedMediaEvent.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(1200); });
      await coordinator.ingestInternal(0);
      await vi.advanceTimersByTimeAsync(800); // audio.play() has not resolved yet
      expect(useRuntimeStore.getState().state).toBe('running');
      coordinator.startInternalClock(0);
      await vi.advanceTimersByTimeAsync(33); await coordinator.ingestInternal(33);
      await coordinator.pauseInternal(); await vi.advanceTimersByTimeAsync(3000);
      mocks.executeObsAction.mockImplementationOnce(async () => { await vi.advanceTimersByTimeAsync(1200); });
      await coordinator.ingestInternal(33); coordinator.startInternalClock(33);
      expect(useRuntimeStore.getState().state).toBe('running');
      expect(mocks.executeManagedMediaEvent).toHaveBeenCalledTimes(1);
      await coordinator.prepareInternal('song', preflight, 1200);
      expect(mocks.seekManagedMedia.mock.calls.at(-1)?.[0].event.sourceOffsetMs).toBe(1200);
      await vi.advanceTimersByTimeAsync(1000);
      await coordinator.ingestInternal(1200); coordinator.startInternalClock(1200);
      await vi.advanceTimersByTimeAsync(600);
      expect(useRuntimeStore.getState().state).toBe('timecodeLost');
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
  it('本机主控初始化 MIDI 不订阅外部时间码，输出回环不会改变本机播放位置', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
    mocks.executeObsAction.mockResolvedValue();
    const project = parseLinkProject({ ...createEmptyLinkProject('本机时钟隔离'), playbackSource: 'internal', obsOutputMode: 'scenes',
      rundown: [{ id: 'song', title: '歌曲', cues: [] }] });
    const coordinator = new LinkRuntimeCoordinator(project, null);
    try {
      await coordinator.initializeMidi();
      expect(mocks.listener).toBeNull();
      await coordinator.prepareInternal('song', async () => {
        coordinator.beginPreflight('live');
        const report = { checkedAt: new Date().toISOString(), mode: 'live' as const, passed: true, checks: [] };
        await coordinator.applyPreflight(report); return report;
      });
      await coordinator.ingestInternal(0);
      sendTimecode(1800);
      await coordinator.ingestInternal(33);
      expect(useRuntimeStore.getState().state).toBe('running');
      expect(useRuntimeStore.getState().reason).not.toBe('MTC 时间跳变');
    } finally { coordinator.dispose(); }
  });
  it('完整场景从头播放和反复定位只切场景，不发布受管画面或修改来源', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
    mocks.activateManagedObsOutput.mockClear(); mocks.setInternalAudioCapture.mockClear(); mocks.executeObsAction.mockResolvedValue();
    const project = parseLinkProject({ ...createEmptyLinkProject('拉腿场景'), playbackSource: 'internal', obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', cues: [0, 2, 5].map((second) => ({
      id: `cue-${second}`, name: `Scene ${second}`, timecode: { hours: 0, minutes: 0, seconds: second, frames: 0 }, actions: [{ id: `a-${second}`, label: '完整场景', kind: 'obs.setProgramScene', sceneName: `Scene ${second}` }]
    })) }] });
    const coordinator = new LinkRuntimeCoordinator(project, 'C:\\show\\scenes.tblink');
    const preflight = async () => { coordinator.beginPreflight('live'); const report = { checkedAt: new Date().toISOString(), mode: 'live' as const, passed: true, checks: [] }; await coordinator.applyPreflight(report); return report; };
    try {
      await coordinator.prepareInternal('song', preflight); await coordinator.ingestInternal(0);
      expect(mocks.executeObsAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'obs.setProgramScene', sceneName: 'Scene 0' }));
      await coordinator.prepareInternal('song', preflight, 4000);
      expect(mocks.executeObsAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'obs.setProgramScene', sceneName: 'Scene 2' }));
      await coordinator.prepareInternal('song', preflight, 1000);
      expect(mocks.executeObsAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'obs.setProgramScene', sceneName: 'Scene 0' }));
      expect(mocks.activateManagedObsOutput).not.toHaveBeenCalled(); expect(mocks.executeManagedMediaEvent).not.toHaveBeenCalled();
      expect(mocks.setInternalAudioCapture).toHaveBeenCalledWith(true, ['Scene 0', 'Scene 2', 'Scene 5']);
      await coordinator.ingestInternal(1000);
      mocks.setInternalAudioCapture.mockClear(); mocks.executeObsAction.mockClear();
      await coordinator.seekInternal(4000);
      expect(useRuntimeStore.getState().state).toBe('paused');
      expect(mocks.executeObsAction).toHaveBeenLastCalledWith(expect.objectContaining({ sceneName: 'Scene 2' }));
      await coordinator.seekInternal(1000);
      expect(mocks.executeObsAction).toHaveBeenLastCalledWith(expect.objectContaining({ sceneName: 'Scene 0' }));
      expect(mocks.setInternalAudioCapture).not.toHaveBeenCalled();
      await coordinator.ingestInternal(1000);
      expect(useRuntimeStore.getState().state).toBe('running');
      await coordinator.stopAndWait();
    } finally { coordinator.dispose(); }
  });
  it('十首带视频节目循环三轮，上一首停止后才启动下一首，最终无活动素材', async () => {
    vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => undefined });
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
    const project = parseLinkProject({ ...createEmptyLinkProject('十首素材连续联动'),
      mediaAssets: [{ id: 'video', name: 'original.mp4', kind: 'video', relativePath: 'assets/reference-media/original.mp4',
        sha256: 'a'.repeat(64), byteLength: 100, durationMs: 30_000, width: 1080, height: 1920 }],
      rundown: Array.from({ length: 10 }, (_, index) => ({ id: `song-${index}`, title: `歌曲 ${index}`,
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
