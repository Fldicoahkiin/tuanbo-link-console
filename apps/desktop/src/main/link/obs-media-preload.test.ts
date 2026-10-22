import { expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { SceneOutputTimeline } from '@tb/core/link';
import { ObsMediaPreload } from './obs-media-preload';
import type { ObsMediaScenes } from './obs-media-scenes';

function setup(camera = false, kind: 'audio' | 'video' = 'video') {
  const project = parseLinkProject({ ...createEmptyLinkProject('预备'), playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind, relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'camera', name: '机位' }, { id: 'video-layer', name: '视频' }],
      referenceMediaClips: [0, 12, 24].map((seconds, index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'video-layer', label: '视频',
        startTimecode: { hours: 0, minutes: 0, seconds, frames: 0 }, durationMs: 12000, sourceOffsetMs: 100 })),
      cues: camera ? [{ id: 'camera-cue', name: '机位', layerId: 'camera', timecode: { hours: 0, minutes: 0, seconds: 4, frames: 0 }, durationMs: 2000,
        actions: [{ id: 'camera-action', kind: 'obs.setProgramScene', label: '机位', sceneName: '机位1' }] }] : [] }] });
  const scenes = { prepareStandby: vi.fn<ObsMediaScenes['prepareStandby']>(name => Promise.resolve(`${name}·预备`)),
    copyPresentation: vi.fn<ObsMediaScenes['copyPresentation']>(() => Promise.resolve()),
    prime: vi.fn<ObsMediaScenes['prime']>(async (_event, _path, run) => { await run(); }),
    execute: vi.fn<ObsMediaScenes['execute']>(() => Promise.resolve()), seek: vi.fn<ObsMediaScenes['seek']>(() => Promise.resolve()) };
  const native = { prime: vi.fn<(name: string, restartRetained: boolean, kind: 'audio' | 'video') => Promise<void>>(() => Promise.resolve()), seek: vi.fn<(name: string, position: number) => Promise<void>>(() => Promise.resolve()) };
  const preload = new ObsMediaPreload(project, 'song', scenes, native), timeline = new SceneOutputTimeline(project, 'song');
  const events = timeline.preloadEntries(), path = 'C:/shows/assets/video.mp4';
  preload.register(project.projectId, project.mediaAssets[0]!, path);
  return { project, preload, scenes, native, timeline, events, path };
}
const current = (): void => undefined;

it('正式播放前预热首段和接续段，播放中不重复创建或预热；再下一段仍复用原解码器', async () => {
  const t = setup(true);
  const unique = t.events.filter((event, index, events) => events.findIndex(candidate => candidate.clipId === event.clipId) === index);
  const first = unique[0]!, second = unique[1]!, third = unique[2]!;
  await t.preload.prime(first, current); await t.preload.primeFollowing(first, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  expect(t.scenes.execute).not.toHaveBeenCalled();
  await t.preload.execute(first, t.path); await t.preload.upcoming(60, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  await t.preload.execute(second, t.path);
  expect(t.preload.resolveSource(first.sourceName)).toBe(`${first.sourceName}·预备`);
  await t.preload.prime(third, current);
  expect(t.native.prime).toHaveBeenLastCalledWith(first.sourceName, true, 'video');
  await t.preload.close();
});

it('正式播放前取消时两份解码器都关闭，预备失败不进入时间线', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current);
  t.native.prime.mockRejectedValueOnce(new Error('预备解码失败'));
  await expect(t.preload.primeFollowing(first, current)).rejects.toThrow('预备解码失败');
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.map(([event]) => [event.sourceName, event.phase]))
    .toEqual([[first.sourceName, 'stop'], [`${first.sourceName}·预备`, 'stop']]);
});

it.each(['audio', 'video'] as const)('按 %s 类型预热初次和复用解码器，保留裁剪定位', async kind => {
  const t = setup(false, kind);
  for (const event of t.events) {
    await t.preload.prime(event, current); await t.preload.execute(event, t.path);
  }
  expect(t.native.prime.mock.calls.map(([, retained, mediaKind]) => [retained, mediaKind]))
    .toEqual([[false, kind], [false, kind], [true, kind]]);
  expect(t.native.seek.mock.calls.map(([, ms]) => ms)).toEqual([100, 100, 100]);
  await t.preload.close();
});

it('曲尾已成功停止的解码器不在关闭会话时再停一次，尚未播放的预备输入仍被清理', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current); await t.preload.execute(first, t.path);
  await t.preload.upcoming(60, current);
  await t.preload.execute({ ...first, phase: 'stop', frameNumber: 1080 }, t.path);
  await t.preload.close(); await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName))
    .toEqual([first.sourceName, `${first.sourceName}·预备`]);
});

it('播放中的四路纹理预热分散到音频时钟周期，全部仍在原边界前就绪', async () => {
  const base = setup(), item = base.project.rundown[0]!;
  const assets = Array.from({ length: 4 }, (_, index) => ({ ...base.project.mediaAssets[0]!, id: `video-${index}` }));
  const project = parseLinkProject({ ...base.project, mediaAssets: assets, rundown: [{ ...item,
    visualLayers: assets.map(asset => ({ id: `${asset.id}-layer`, name: asset.id })),
    referenceMediaClips: assets.flatMap(asset => item.referenceMediaClips.map(clip => ({ ...clip,
      id: `${asset.id}-${clip.id}`, assetId: asset.id, layerId: `${asset.id}-layer` }))) }] });
  const preload = new ObsMediaPreload(project, item.id, base.scenes, base.native);
  for (const asset of assets) preload.register(project.projectId, asset, base.path);
  const events = new SceneOutputTimeline(project, item.id).preloadEntries();
  for (const event of events.filter(event => event.frameNumber === 0)) {
    await preload.prime(event, current); await preload.execute(event, base.path);
  }
  expect(base.native.prime).toHaveBeenCalledTimes(4);
  for (let frame = 60; frame <= 105; frame++) {
    await preload.upcoming(frame, current);
    expect(base.native.prime).toHaveBeenCalledTimes(5 + Math.floor((frame - 60) / 15));
  }
  for (const event of events.filter(event => event.frameNumber === 360)) await preload.execute(event, base.path);
  expect(base.scenes.execute).toHaveBeenCalledTimes(8);
});

it('当前边界仍排队时不覆盖开场预备槽，也不因更后面的片段误报失败', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current);
  await t.preload.upcoming(60, current);
  expect(t.native.prime).toHaveBeenCalledTimes(1);
  await t.preload.execute(first, t.path); await t.preload.upcoming(75, current);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
});

it('相邻三片段交替使用主、预备、主解码器；边界只切换已准备输入', async () => {
  const t = setup(), [first, second, third] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  await t.preload.upcoming(30, current); expect(t.native.prime).toHaveBeenCalledTimes(1);
  await t.preload.upcoming(60, current); expect(t.native.prime).toHaveBeenCalledTimes(2);
  await t.preload.upcoming(90, current); expect(t.native.prime).toHaveBeenCalledTimes(2);
  const standby = `${first!.sourceName}·预备`;
  await t.preload.execute(second!, t.path);
  expect(t.preload.resolveSource(first!.sourceName)).toBe(standby);
  expect(t.scenes.execute).toHaveBeenLastCalledWith({ ...second!, sourceName: standby }, t.path, first!.sourceName, 'pause');
  await t.preload.upcoming(420, current); await t.preload.execute(third!, t.path);
  expect(t.scenes.copyPresentation).toHaveBeenCalledWith(standby, first!.sourceName);
  expect(t.native.prime).toHaveBeenCalledTimes(3);
  expect(t.native.prime.mock.calls.map(([, retained]) => retained)).toEqual([false, false, true]);
  expect(t.native.seek.mock.calls.map(call => call[1])).toEqual([100, 100, 100]);
  expect(t.preload.resolveSource(first!.sourceName)).toBe(first!.sourceName);
  await t.preload.close();
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop').map(([event]) => event.sourceName)).toEqual([first!.sourceName]);
});

it('机位结束恢复同一片段不抢占后续片段的预备位置', async () => {
  const t = setup(true), first = t.events[0]!;
  expect(t.events.map(event => [event.clipId, event.frameNumber, event.sourceOffsetMs])).toEqual([
    ['clip-0', 0, 100], ['clip-0', 180, 6100], ['clip-1', 360, 100], ['clip-2', 720, 100]
  ]);
  await t.preload.prime(first, current); await t.preload.execute(first, t.path);
  await t.preload.upcoming(90, current);
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1']);
});

it('预备未完成、失败、过期时均不能把下一片段显示为可播，也不能自动重发', async () => {
  const t = setup(), event = t.events[0]!;
  let release = (): void => { throw new Error('测试未初始化'); };
  t.native.prime.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  let valid = true;
  const preparing = t.preload.prime(event, () => { if (!valid) throw new Error('已取消'); });
  await expect(t.preload.execute(event, t.path)).rejects.toThrow('未在播放边界前');
  await expect(t.preload.prime(event, current)).rejects.toThrow('不能重复准备');
  valid = false; release(); await expect(preparing).rejects.toThrow('已取消');
  await t.preload.close();
  expect(t.native.prime).toHaveBeenCalledTimes(1);
  expect(t.scenes.execute.mock.calls.every(([event]) => event.phase === 'stop')).toBe(true);
  await expect(t.preload.seek(event, t.path)).rejects.toThrow('会话已改变');
});

it('错过播放边界的片段在当前位置仍应播出时先预备一次并交回，之后不再重复预备', async () => {
  const t = setup(), [first, second] = t.events;
  await t.preload.prime(first!, current); await t.preload.execute(first!, t.path);
  await expect(t.preload.execute(second!, t.path)).rejects.toThrow('未在播放边界前');
  expect(await t.preload.upcoming(390, current)).toMatchObject({ clipId: second!.clipId });
  await t.preload.execute({ ...second!, sourceOffsetMs: 1100 }, t.path);
  expect(t.native.prime).toHaveBeenCalledTimes(2);
  expect(await t.preload.upcoming(420, current)).toMatchObject({ clipId: 'clip-2' });
  expect(t.scenes.prime.mock.calls.map(([event]) => event.clipId)).toEqual(['clip-0', 'clip-1', 'clip-2']);
  await t.preload.close();
});

it('一个输入停止失败仍清理另一输入，错误返回上层', async () => {
  const t = setup(), first = t.events[0]!;
  await t.preload.prime(first, current); await t.preload.execute(first, t.path); await t.preload.upcoming(60, current);
  t.scenes.execute.mockRejectedValueOnce(new Error('主来源失去响应'));
  await expect(t.preload.close()).rejects.toThrow('主来源失去响应');
  await expect(t.preload.close()).rejects.toThrow('主来源失去响应');
  expect(t.scenes.execute.mock.calls.filter(([event]) => event.phase === 'stop')).toHaveLength(2);
});
