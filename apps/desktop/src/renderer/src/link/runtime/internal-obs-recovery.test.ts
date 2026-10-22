import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { CueRuntime, ManagedOutputRuntime, type LinkDesktopApi } from '@tb/core/link';
import { recoverInternalObs } from './internal-obs-recovery';
import { rebuildTimelinePicture } from './timeline-work';
const prepareObsMediaScenes = vi.hoisted(() => vi.fn<LinkDesktopApi['prepareObsMediaScenes']>());
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { prepareObsMediaScenes } }));

function project() {
  return parseLinkProject({ ...createEmptyLinkProject('重连'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: ['video', 'other'].map(id => ({ id, name: id, kind: 'video', relativePath: `${id}.mp4`, sha256: 'a'.repeat(64), byteLength: 10, durationMs: 30000, width: 360, height: 640 })),
    rundown: [{ id: 'song', title: '节目', visualLayers: [{ id: 'camera-layer', name: '机位' }, { id: 'show-layer', name: '来源' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: [{ id: 'clip', assetId: 'video', label: 'video', layerId: 'video-layer', startTimecode: { hours: 0, minutes: 0, seconds: 2, frames: 0 }, durationMs: 20000, sourceOffsetMs: 1000 }],
      cues: [{ id: 'camera', name: '机位', layerId: 'camera-layer', timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, durationMs: 2000,
        actions: [{ id: 'scene', label: '机位', kind: 'obs.setProgramScene', sceneName: 'Camera' }] },
      { id: 'show', name: '显示', layerId: 'show-layer', timecode: { hours: 0, minutes: 0, seconds: 4, frames: 0 }, durationMs: 4000,
        actions: [{ id: 'flag', label: '显示来源 · 旗帜', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: '旗帜', enabled: true }] }] },
    { id: 'next', title: '下一首', visualLayers: [{ id: 'other-layer', name: '视频' }], referenceMediaClips: [{ id: 'other-clip', assetId: 'other', label: 'other', layerId: 'other-layer', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000 }], cues: [] }] });
}

it('OBS 重连后按当前位置从零重建画面：素材按此刻位置起播，区间内的显示来源此刻显示，结束时照常隐藏', async () => {
  const value = project(), runtime = new CueRuntime(value), managed = new ManagedOutputRuntime(value, 'C:/show/show.tblink', { executeManagedMediaEvent: () => Promise.resolve(), recordLog: entry => Promise.resolve({ ...entry, id: 'log', sessionId: 'test', timestamp: '2026-10-22T00:00:00Z', monotonicMs: 0 }) });
  runtime.selectItem('song'); runtime.beginPreflight('live'); runtime.arm(0); managed.selectItem('song');
  const sent: Array<[string[], string[]]> = [];
  const rebuilt = await rebuildTimelinePicture(() => 180, runtime, managed, (cues, media) => { sent.push([cues.map(entry => `${entry.cue.id}@${entry.scheduledFrame}`), media.map(event => `${event.clipId}@${event.frameNumber}`)]); return Promise.resolve(); });
  expect(sent).toEqual([[['show@181'], ['clip@180']]]); expect(rebuilt).toBe(2);
  expect(runtime.getNextCueId(180)).toBe('camera');
  const camera = await rebuildTimelinePicture(() => 330, runtime, managed, cues => { sent.push([cues.map(entry => entry.cue.id), []]); return Promise.resolve(); });
  expect(sent.at(-1)).toEqual([['camera'], []]); expect(camera).toBe(1);
});

it('播放中重连：只重新准备这首歌的素材场景再重建并标红；暂停中按暂停位置重新准备；失败也标红', async () => {
  const value = project(), notices: string[] = [], faults: string[] = [];
  const player = { seek: vi.fn(() => Promise.resolve()), reportFault: (message: string) => faults.push(message) };
  const coordinator = { rebuildPicture: vi.fn(() => Promise.resolve(3)) };
  const base = { project: value, path: 'C:/show/show.tblink', itemId: 'song', positionMs: 9000, coordinator, player, notice: (message: string) => notices.push(message) };
  prepareObsMediaScenes.mockResolvedValue();
  await recoverInternalObs({ ...base, status: 'playing' });
  expect(prepareObsMediaScenes.mock.calls[0]?.[1].mediaAssets.map(asset => asset.id)).toEqual(['video']);
  expect(faults).toEqual(['OBS 已重新连接：画面按当前位置重建，发送 3 项']); expect(notices).toEqual(faults);
  await recoverInternalObs({ ...base, status: 'paused' });
  expect(player.seek).toHaveBeenCalledWith(9000); expect(faults.at(-1)).toBe('OBS 已重新连接：已在暂停位置重新准备画面');
  prepareObsMediaScenes.mockRejectedValueOnce(new Error('场景创建失败'));
  await recoverInternalObs({ ...base, status: 'playing' });
  expect(faults.at(-1)).toBe('OBS 重新连接后画面重建失败：场景创建失败');
  await recoverInternalObs({ ...base, status: 'stopped' }); expect(faults).toHaveLength(3);
});
