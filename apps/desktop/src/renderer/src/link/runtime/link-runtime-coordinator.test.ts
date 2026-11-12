import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type LinkAction } from '@tb/schema';
import type { LinkDesktopApi } from '@tb/core/link';
import { LinkRuntimeCoordinator } from './link-runtime-coordinator';
import { useRuntimeStore } from '../stores/runtime-store';

const mocks = vi.hoisted(() => ({
  activateManagedObsOutput: vi.fn(() => Promise.resolve()),
  executeObsAction: vi.fn<(action: LinkAction) => Promise<void>>(),
  executeMidiAction: vi.fn<(action: LinkAction) => Promise<void>>(() => Promise.resolve()),
  executeManagedMediaEvent: vi.fn<LinkDesktopApi['executeManagedMediaEvent']>(),
  seekManagedMedia: vi.fn<LinkDesktopApi['seekManagedMedia']>(),
  prepareObsMediaScenes: vi.fn<LinkDesktopApi['prepareObsMediaScenes']>().mockResolvedValue(),
  recordLog: vi.fn<(entry: Parameters<LinkDesktopApi['recordLog']>[0]) => Promise<void>>(() => Promise.resolve())
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
    subscribePorts() { return () => undefined; }
    dispose() { return undefined; }
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
  it('显式停止将界面状态同步到已待机的控制器，不遗留暂停锁', async () => {
    const coordinator = new LinkRuntimeCoordinator(createEmptyLinkProject('停止状态同步'), null);
    useRuntimeStore.getState().setState({ state: 'paused', reason: '操作员暂停自动联动' });
    await coordinator.stopAndWait();
    expect(useRuntimeStore.getState().state).toBe('idle');
    expect(mocks.executeObsAction).not.toHaveBeenCalled();
    coordinator.dispose();
  });
});

