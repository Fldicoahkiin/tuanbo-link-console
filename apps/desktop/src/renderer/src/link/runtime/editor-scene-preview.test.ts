import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import type { LinkDesktopApi } from '@tb/core/link';
import { previewEditorScene } from './editor-scene-preview';
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));

function fixture() {
  const project = parseLinkProject({ ...createEmptyLinkProject('停止拖动预览'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: ['video', 'other'].map(id => ({ id, name: id, kind: 'video', relativePath: `${id}.mp4`, sha256: 'a'.repeat(64), byteLength: 10, durationMs: 30000, width: 360, height: 640 })),
    rundown: [{ id: 'song', title: '节目', visualLayers: [{ id: 'camera-layer', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: ['video', 'other'].map((id, index) => ({ id: `${id}-clip`, assetId: id, label: id, layerId: 'video-layer',
        startTimecode: { hours: 0, minutes: 0, seconds: index ? 20 : 2, frames: 0 }, durationMs: 10000, sourceOffsetMs: 1000, embeddedAudioEnabled: true })),
      cues: [{ id: 'camera', name: '机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 6, frames: 0 }, durationMs: 2000,
        actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Camera' },
          { id: 'light', label: '灯光', kind: 'midi.noteOn', portProfileId: 'lighting', channel: 1, note: 60, velocity: 127 }] }] }] });
  const desktop = { prepareObsMediaScenes: vi.fn<LinkDesktopApi['prepareObsMediaScenes']>().mockResolvedValue(),
    executeObsAction: vi.fn<LinkDesktopApi['executeObsAction']>().mockResolvedValue(),
    seekManagedMedia: vi.fn<LinkDesktopApi['seekManagedMedia']>().mockResolvedValue() };
  const preview = (position: number, current = () => true) => previewEditorScene(project, 'C:\\show\\show.tblink', 'song', position, false, desktop, current);
  return { project, desktop, preview };
}

describe('停止状态时间线画面定位', () => {
  it('29.97df 编辑预览与正式播放使用同一实际帧时长', async () => {
    const { project, desktop, preview } = fixture();
    project.timebase.frameRate = '29.97df';
    const item = project.rundown[0]!;
    item.cues = []; item.referenceMediaClips = [item.referenceMediaClips[0]!];
    item.referenceMediaClips[0]!.durationMs = 900000;
    await preview(600000);
    expect(desktop.seekManagedMedia.mock.calls[0]?.[0].event.sourceOffsetMs).toBe(1000 + Math.round((17982 - 60) * 1001 / 30));
  });
  it('未经播放就能往返定位，包含片段入点，预览保持静音，准备 DTO 通过工程关系校验', async () => {
    const { desktop, preview } = fixture();
    for (const position of [5000, 9000, 3000]) await preview(position);
    expect(desktop.seekManagedMedia.mock.calls.map(([value]) => value.event.sourceOffsetMs)).toEqual([4000, 8000, 2000]);
    expect(desktop.seekManagedMedia.mock.calls.every(([value]) => !value.event.embeddedAudioEnabled)).toBe(true);
    for (const [, project] of desktop.prepareObsMediaScenes.mock.calls) {
      expect(() => parseLinkProject(project)).not.toThrow();
      expect(project.mediaAssets.map(asset => asset.id)).toEqual(['video']);
    }
  });
  it('机位区间只切对应场景，不补发灯光；离开机位恢复视频当前位置', async () => {
    const { desktop, preview } = fixture();
    await preview(7000);
    expect(desktop.executeObsAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'obs.setProgramScene', sceneName: 'Camera' }));
    expect(desktop.prepareObsMediaScenes).not.toHaveBeenCalled();
    await preview(9000);
    expect(desktop.seekManagedMedia).toHaveBeenCalledOnce();
    expect(desktop.seekManagedMedia.mock.calls[0]?.[0].event.sourceOffsetMs).toBe(8000);
  });
  it('叠加层先准备再切场景，所有视频保持各自的暂停位置', async () => {
    const { project, desktop, preview } = fixture(); project.rundown[0]!.visualLayers.reverse();
    await preview(7000);
    const action = desktop.executeObsAction.mock.calls[0]?.[0];
    expect(action?.kind === 'obs.setProgramScene' && action.sceneLayers).toContain('Camera');
    expect(desktop.prepareObsMediaScenes.mock.invocationCallOrder[0]).toBeLessThan(desktop.executeObsAction.mock.invocationCallOrder[0]!);
    expect(desktop.seekManagedMedia.mock.calls[0]?.[0].event).toMatchObject({ deferSceneSwitch: true, sourceOffsetMs: 6000 });
  });
  it('停止或切换工程后，迟到的素材准备不会再切画面；失败向上传递且不重试', async () => {
    const { desktop, preview } = fixture(); let current = true;
    desktop.prepareObsMediaScenes.mockImplementationOnce(() => { current = false; return Promise.resolve(); });
    await preview(3000, () => current);
    expect(desktop.seekManagedMedia).not.toHaveBeenCalled();
    desktop.prepareObsMediaScenes.mockRejectedValueOnce(new Error('素材损坏'));
    await expect(preview(4000)).rejects.toThrow('素材损坏');
    expect(desktop.prepareObsMediaScenes).toHaveBeenCalledTimes(2);
    expect(desktop.seekManagedMedia).not.toHaveBeenCalled();
  });
});
