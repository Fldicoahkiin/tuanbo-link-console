import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, type NativeObsPrepare } from '@tb/schema';
import { createObsProgramSnapshot } from '@tb/core/link';
import { prepareNextObsFiles } from './native-obs-files';
import type { LinkProjectService } from './link-project-service';
import type { MediaPreviewService } from './media-preview-service';

function fixture() {
  const project = parseLinkProject({ ...createEmptyLinkProject('文件预备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: Array.from({ length: 6 }, (_, index) => ({ id: `a${index}`, name: `视频${index}`, kind: 'video',
      relativePath: `assets/${index}.mp4`, sha256: 'a'.repeat(64), byteLength: 1, durationMs: 10000, width: 1920, height: 1080 })),
    rundown: [{ id: 'song', title: '歌曲', referenceMediaClips: Array.from({ length: 6 }, (_, index) => ({ id: `c${index}`, assetId: `a${index}`, label: '视频',
      startTimecode: { hours: 0, minutes: 0, seconds: index, frames: 0 }, durationMs: 1000, sourceOffsetMs: 500 })) }] });
  const snapshot = createObsProgramSnapshot(project, 'song', 1);
  const request: NativeObsPrepare = { version: 1, sessionId: '64f37673-7a65-4c81-b5b4-09c1b9f94cb3', generation: 1,
    projectPath: 'C:/show/test.tblink', preciseSeeking: true, snapshot, nextFiles: { snapshot, positionMs: 0 } };
  let active = 0, maximum = 0;
  const inspectMediaAssets = vi.fn<LinkProjectService['inspectMediaAssets']>(async (_path, assets) => {
    active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return Object.fromEntries(assets.map(asset => [asset.id, { fileAvailable: true }]));
  });
  const ensureObsSeekVideo = vi.fn<MediaPreviewService['ensureObsSeekVideo']>(() => Promise.resolve('cache'));
  return { request, inspectMediaAssets, ensureObsSeekVideo, maximum: () => maximum,
    services: { projects: { inspectMediaAssets }, media: { ensureObsSeekVideo } } };
}

it('下一节目文件按两路准备，未接入任何设备控制，也不改变原始快照', async () => {
  const t = fixture(), original = JSON.stringify(t.request);
  await prepareNextObsFiles(t.request, t.services, () => undefined);
  expect(t.maximum()).toBe(2); expect(t.inspectMediaAssets).toHaveBeenCalledTimes(6);
  expect(t.ensureObsSeekVideo).toHaveBeenCalledTimes(6); expect(JSON.stringify(t.request)).toBe(original);
  expect(t.ensureObsSeekVideo.mock.calls.every(call => call[5] === 'background')).toBe(true);
  expect(t.ensureObsSeekVideo.mock.calls.map(call => [call[1], call[3]])).toEqual([
    ['assets/0.mp4', 'hardware'], ['assets/1.mp4', 'hardware'],
    ['assets/2.mp4', 'software'], ['assets/3.mp4', 'software'],
    ['assets/4.mp4', 'software'], ['assets/5.mp4', 'software']
  ]);
});

it('校验等待期间取消不能继续转码或开始后续文件', async () => {
  const t = fixture(); let valid = true;
  t.inspectMediaAssets.mockImplementation(async () => { await Promise.resolve(); valid = false; return { a0: { fileAvailable: true } }; });
  await expect(prepareNextObsFiles(t.request, t.services, () => { if (!valid) throw new Error('已取消'); })).rejects.toThrow('已取消');
  expect(t.inspectMediaAssets).toHaveBeenCalledTimes(2); expect(t.ensureObsSeekVideo).not.toHaveBeenCalled();
});

it('同素材跨轨占用硬解和软解时提前准备两份对应缓存，重复软解轨不重复生成', async () => {
  const t = fixture();
  const snapshot = t.request.nextFiles!.snapshot;
  snapshot.item.visualLayers = ['one', 'two', 'three'].map(id => ({ id, name: id, visible: true, locked: false }));
  const first = snapshot.item.referenceMediaClips[0]!;
  snapshot.item.referenceMediaClips = [
    { ...first, layerId: 'one' },
    { ...first, id: 'second', layerId: 'two' },
    { ...first, id: 'third', layerId: 'three' }
  ];
  await prepareNextObsFiles(t.request, t.services, () => undefined);
  expect(t.ensureObsSeekVideo.mock.calls.filter(call => call[1] === 'assets/0.mp4').map(call => call[3]))
    .toEqual(['hardware', 'software']);
});

it('缺失文件明确失败，关闭精确定位时仍校验原文件但不生成定位缓存', async () => {
  const t = fixture(); t.request.preciseSeeking = false;
  await prepareNextObsFiles(t.request, t.services, () => undefined); expect(t.ensureObsSeekVideo).not.toHaveBeenCalled();
  t.inspectMediaAssets.mockResolvedValue({ a0: { fileAvailable: false } });
  await expect(prepareNextObsFiles(t.request, t.services, () => undefined)).rejects.toThrow('文件读不了');
});
