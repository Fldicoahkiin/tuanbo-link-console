import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, requiredSchemaVersion, schemaVersion3Reasons, type LinkProject, type ReferenceCanvasTransform, type ReferenceMediaClip } from '@tb/schema';
import { canvasTransformFromObs, clipLookOnlyInPreview, clipObsTransform, obsMaterialPresentation, stagePlacement } from './media-obs-transform';
import { clipOfMaterialSource, collectManagedMediaTimeline, lockedLayerMessage, materialSceneNames } from './managed-media-timeline';
import { replaceReferenceMediaClipCommand } from './link-command';

const look: ReferenceCanvasTransform = { x: 0.25, y: 0.75, scale: 0.5, scaleX: 1.5, scaleY: 0.8, rotation: -30 };
const canvas = { width: 1080, height: 1920 };

/** One video, `clips` clips of it on one track; `edited` lists the clips whose look the project sends to OBS. */
function project(clips = 1, edited: readonly string[] = []): LinkProject {
  return parseLinkProject({ ...createEmptyLinkProject('样子'), schemaVersion: edited.length ? 3 : 1, playbackSource: 'internal', obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 1, durationMs: 60000, width: 1920, height: 1080 }],
    rundown: [{ id: 'song', title: '歌曲', visualLayers: [{ id: 'track', name: '视频' }],
      referenceMediaClips: Array.from({ length: clips }, (_, index) => ({ id: `clip-${index}`, assetId: 'video', layerId: 'track', label: '视频',
        startTimecode: { hours: 0, minutes: 0, seconds: index * 10, frames: 0 }, durationMs: 5000, canvasTransform: look,
        ...(edited.includes(`clip-${index}`) ? { obsTransform: 'project' as const } : {}) })) }] });
}

describe('素材在 OBS 里的样子（0.5.9 E16）', () => {
  it('映射和 8c409fe1 删掉之前的一样：中心对齐，位置按画布比例，缩放是 scale 乘各自方向，旋转照搬；外加不用边框', () => {
    // The managed output before 8c409fe1: positionX x*baseWidth, positionY y*baseHeight, scaleX scale*scaleX,
    // scaleY scale*scaleY, rotation, alignment 0. Material scene items are created with a bounding box, so it is set off.
    expect(obsMaterialPresentation(look, canvas)).toEqual({ sceneItemTransform: {
      positionX: 270, positionY: 1440, scaleX: 0.75, scaleY: 0.4, rotation: -30, alignment: 0, boundsType: 'OBS_BOUNDS_NONE' } });
    expect(obsMaterialPresentation({ x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }, { width: 1920, height: 1080 }).sceneItemTransform)
      .toMatchObject({ positionX: 960, positionY: 540, scaleX: 1, scaleY: 1 });
    expect(() => obsMaterialPresentation(look, { width: 0, height: 1920 })).toThrow('画布尺寸无效');
  });

  it('编辑器舞台按同一份映射画：位置、宽高和旋转和以前的 CSS 算法一致', () => {
    const source = { width: 1920, height: 1080 };
    const placed = stagePlacement(look, source, canvas);
    // The stage's CSS before E16: width source/canvas*scale*scaleX, left x, rotate rotation.
    expect(placed.left).toBeCloseTo(look.x, 9);
    expect(placed.top).toBeCloseTo(look.y, 9);
    expect(placed.width).toBeCloseTo(source.width / canvas.width * look.scale * look.scaleX, 9);
    expect(placed.height).toBeCloseTo(source.height / canvas.height * look.scale * look.scaleY, 9);
    expect(placed.rotation).toBe(look.rotation);
  });

  it('只有在编辑器里改过的片段把样子送到 OBS；以前调过但没送过的片段只算编辑器预览', () => {
    const clip = (values: Partial<ReferenceMediaClip>) => ({ canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }, ...values });
    expect(clipObsTransform(clip({}))).toBeUndefined();
    expect(clipObsTransform(clip({ canvasTransform: look }))).toBeUndefined();
    expect(clipObsTransform(clip({ canvasTransform: look, obsTransform: 'project' }))).toEqual(look);
    // Adjusted before 0.5.9 (only the preview has it): told once on the clip. Never adjusted, or already decided: not.
    expect(clipLookOnlyInPreview(clip({ canvasTransform: look }))).toBe(true);
    expect(clipLookOnlyInPreview(clip({ canvasTransform: { ...look, x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 } }))).toBe(false);
    expect(clipLookOnlyInPreview(clip({}))).toBe(false);
    expect(clipLookOnlyInPreview(clip({ canvasTransform: look, obsTransform: 'project' }))).toBe(false);
  });

  it('时间线事件只给送 OBS 的片段带样子；没设的片段不带，OBS 照旧', () => {
    const starts = (value: LinkProject) => collectManagedMediaTimeline(value, 'song').events.filter(event => event.phase === 'start');
    expect(starts(project(2)).map(event => event.transform)).toEqual([undefined, undefined]);
    expect(starts(project(2, ['clip-1'])).map(event => event.transform)).toEqual([undefined, look]);
  });

  it('打开以前的工程不需要新格式；有片段的样子要送 OBS 时才要 schema 3，原因写成 look', () => {
    const older = project(2);
    expect(schemaVersion3Reasons(older)).toEqual([]);
    expect(requiredSchemaVersion(older)).toBe(1);
    expect(schemaVersion3Reasons(project(2, ['clip-0']))).toEqual(['look']);
    expect(() => parseLinkProject({ ...project(2, ['clip-0']), schemaVersion: 2 })).toThrow('schema 3');
  });

  it('改片段的样子这一步把工程升到 schema 3，撤销拿回原来的版本', () => {
    const before = project(1);
    const clip = before.rundown[0]!.referenceMediaClips[0]!;
    const command = replaceReferenceMediaClipCommand('song', { ...clip, obsTransform: 'project' });
    const after = command.execute(before);
    expect(after.schemaVersion).toBe(3);
    expect(after.rundown[0]!.referenceMediaClips[0]!.obsTransform).toBe('project');
    expect(command.undo(before).schemaVersion).toBe(1);
  });

  it('实时画布上拖素材：认出这首歌里是哪一段；用户自己的来源不归这里；好几段又没选中时不猜', () => {
    const value = project(2);
    const { sourceName } = materialSceneNames(value.projectId, value.mediaAssets[0]!);
    expect(clipOfMaterialSource(value, 'song', '用户的摄像头', null)).toBeNull();
    expect(clipOfMaterialSource(value, 'song', `${sourceName}·预备`, 'clip-1')).toBe('clip-1');
    expect(clipOfMaterialSource(value, 'song', sourceName, 'clip-0')).toBe('clip-0');
    expect(() => clipOfMaterialSource(value, 'song', sourceName, null)).toThrow('先在时间线上选中要改的那一段');
    const single = project(1);
    expect(clipOfMaterialSource(single, 'song', materialSceneNames(single.projectId, single.mediaAssets[0]!).sourceName, null)).toBe('clip-0');
    expect(() => clipOfMaterialSource(value, 'song', '团播联动台·素材·别的·0000000·来源', null)).toThrow('不在当前这首歌里');
  });

  it('实时画布上的画面是播放头下那一段：先认播放头下的，不在任何一段上时才看选中的；轨道锁着时不让拖，说法和检查面板一样', () => {
    const value = project(2);
    const { sourceName } = materialSceneNames(value.projectId, value.mediaAssets[0]!);
    // clip-0 runs 0–5 s, clip-1 runs 10–15 s.
    expect(clipOfMaterialSource(value, 'song', sourceName, 'clip-0', 12000)).toBe('clip-1');
    expect(clipOfMaterialSource(value, 'song', sourceName, 'clip-1', 1000)).toBe('clip-0');
    expect(clipOfMaterialSource(value, 'song', sourceName, 'clip-1', 7000)).toBe('clip-1');
    expect(() => clipOfMaterialSource(value, 'song', sourceName, null, 7000)).toThrow('先在时间线上选中要改的那一段');
    const locked = { ...value, rundown: value.rundown.map(item => ({ ...item, visualLayers: item.visualLayers.map(layer => ({ ...layer, locked: true })) })) };
    expect(() => clipOfMaterialSource(locked, 'song', sourceName, null, 12000)).toThrow(lockedLayerMessage({ name: '视频' }));
    expect(lockedLayerMessage({ name: '视频' })).toBe('图层“视频”已锁定。');
  });

  it('实时画布上拖到哪，记下的样子送回 OBS 就在哪', () => {
    const source = { width: 1920, height: 1080 };
    const obs = obsMaterialPresentation({ ...look, rotation: 30 }, canvas).sceneItemTransform;
    const back = canvasTransformFromObs({ centerX: obs.positionX, centerY: obs.positionY, width: source.width * obs.scaleX, height: source.height * obs.scaleY, rotation: obs.rotation }, source, canvas);
    const again = obsMaterialPresentation(back, canvas).sceneItemTransform;
    for (const key of ['positionX', 'positionY', 'scaleX', 'scaleY', 'rotation'] as const) expect(again[key]).toBeCloseTo(obs[key], 9);
    // Kept inside what the project holds.
    expect(canvasTransformFromObs({ centerX: -5000, centerY: 0, width: 1, height: 100000, rotation: 270 }, source, canvas))
      .toEqual({ x: -1, y: 0, scale: 1, scaleX: 0.05, scaleY: 8, rotation: -90 });
  });
});
