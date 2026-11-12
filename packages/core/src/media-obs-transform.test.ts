import { describe, expect, it } from 'vitest';
import { createEmptyLinkProject, parseLinkProject, requiredSchemaVersion, schemaVersion3Reasons, serializeLinkProject, type LinkProject, type ReferenceCanvasTransform, type ReferenceMediaClip } from '@tb/schema';
import { canvasTransformFromObs, clipLookOnlyInPreview, clipObsTransform, lookPartsOf, obsMaterialPresentation, quarterTurn, stagePlacement, withLookParts } from './media-obs-transform';
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

describe('镜像、转 90°、裁剪和不透明度（0.5.9 E17）', () => {
  const source = { width: 1920, height: 1080 };
  const plain: ReferenceCanvasTransform = { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };

  it('镜像是场景项缩放取负，和转 90° 叠在一起各管各的；转 90° 一直在 -180 到 180 之间', () => {
    const mirrored = quarterTurn(withLookParts(look, { flipX: true }), 1);
    expect(obsMaterialPresentation(mirrored, canvas).sceneItemTransform).toMatchObject({ scaleX: -0.75, scaleY: 0.4, rotation: 60, alignment: 0, boundsType: 'OBS_BOUNDS_NONE' });
    expect(obsMaterialPresentation(withLookParts(plain, { flipY: true }), canvas).sceneItemTransform).toMatchObject({ scaleX: 1, scaleY: -1 });
    expect(quarterTurn({ ...plain, rotation: 180 }, 1).rotation).toBe(-90);
    expect(quarterTurn({ ...plain, rotation: -90 }, -1).rotation).toBe(180);
    expect(quarterTurn({ ...plain, rotation: 90 }, 1).rotation).toBe(180);
    expect([1, 2, 3, 4].reduce(value => quarterTurn(value, -1), look).rotation).toBe(look.rotation);
  });

  it('裁剪按素材原来的尺寸换成像素；不知道尺寸时说明没法裁剪', () => {
    const cropped = withLookParts(plain, { crop: { top: 0.25, right: 0, bottom: 0.1, left: 0.1 } });
    expect(obsMaterialPresentation(cropped, canvas, source).sceneItemTransform).toMatchObject({ cropTop: 270, cropRight: 0, cropBottom: 108, cropLeft: 192 });
    expect(() => obsMaterialPresentation(cropped, canvas)).toThrow('不知道素材原来有多大，没法裁剪');
    expect(() => obsMaterialPresentation(cropped, canvas, { width: 0, height: 1080 })).toThrow('没法裁剪');
    // No crop of its own: no crop fields, the scene item keeps the crop the material has in OBS.
    expect(Object.keys(obsMaterialPresentation(look, canvas, source).sceneItemTransform).some(key => key.startsWith('crop'))).toBe(false);
  });

  it('不透明度只给滤镜的设置；完全不透明时没有滤镜设置；回到平常的值就不再存', () => {
    expect(obsMaterialPresentation(withLookParts(look, { opacity: 0.5 }), canvas).filterSettings).toEqual({ opacity: 0.5 });
    expect(obsMaterialPresentation(withLookParts(look, { opacity: 0 }), canvas).filterSettings).toEqual({ opacity: 0 });
    expect(obsMaterialPresentation({ ...look, opacity: 1 }, canvas).filterSettings).toBeUndefined();
    const edited = withLookParts(look, { flipX: true, flipY: true, crop: { top: 0.1, right: 0, bottom: 0, left: 0 }, opacity: 0.4 });
    expect(withLookParts(edited, { flipX: false, flipY: false, crop: { top: 0, right: 0, bottom: 0, left: 0 }, opacity: 1 })).toEqual(look);
    expect(withLookParts(edited, { crop: null })).not.toHaveProperty('crop');
    expect(lookPartsOf(edited)).toEqual({ flipX: true, flipY: true, crop: { top: 0.1, right: 0, bottom: 0, left: 0 }, opacity: 0.4 });
    expect(lookPartsOf(look)).toEqual({});
  });

  it('编辑器舞台按同一份换算画：裁剪后的大小、镜像、裁掉多少、不透明度都从 OBS 拿到的数里来', () => {
    const edited = withLookParts(look, { flipX: true, crop: { top: 0, right: 0.25, bottom: 0.5, left: 0.25 }, opacity: 0.5 });
    const placed = stagePlacement(edited, source, canvas);
    expect(placed.width).toBeCloseTo(source.width * 0.5 / canvas.width * look.scale * look.scaleX, 9);
    expect(placed.height).toBeCloseTo(source.height * 0.5 / canvas.height * look.scale * look.scaleY, 9);
    expect(placed).toMatchObject({ left: look.x, top: look.y, rotation: look.rotation, flipX: true, flipY: false, opacity: 0.5,
      crop: { top: 0, right: 0.25, bottom: 0.5, left: 0.25 } });
    expect(stagePlacement(look, source, canvas)).toMatchObject({ flipX: false, flipY: false, opacity: 1, crop: { top: 0, right: 0, bottom: 0, left: 0 } });
  });

  it('实时画布上拖镜像过、裁剪过的素材：镜像和裁剪留着，送回 OBS 还在原处、原大小', () => {
    const edited = withLookParts({ ...look, rotation: 30 }, { flipX: true, crop: { top: 0.1, right: 0.2, bottom: 0, left: 0.1 } });
    const obs = obsMaterialPresentation(edited, canvas, source).sceneItemTransform;
    const shown = { width: (source.width - obs.cropLeft! - obs.cropRight!) * obs.scaleX, height: (source.height - obs.cropTop! - obs.cropBottom!) * obs.scaleY };
    const back = canvasTransformFromObs({ centerX: obs.positionX, centerY: obs.positionY, width: Math.abs(shown.width), height: Math.abs(shown.height), rotation: obs.rotation,
      flipX: obs.scaleX < 0, flipY: obs.scaleY < 0, cropPixels: { top: obs.cropTop!, right: obs.cropRight!, bottom: obs.cropBottom!, left: obs.cropLeft! } }, source, canvas);
    expect(back.flipX).toBe(true);
    expect(back).not.toHaveProperty('flipY');
    const again = obsMaterialPresentation(back, canvas, source).sceneItemTransform;
    for (const key of ['positionX', 'positionY', 'scaleX', 'scaleY', 'rotation'] as const) expect(again[key]).toBeCloseTo(obs[key], 9);
    expect([again.cropTop, again.cropRight, again.cropBottom, again.cropLeft]).toEqual([obs.cropTop, obs.cropRight, obs.cropBottom, obs.cropLeft]);
  });

  it('文件：没有这些字段的工程读进来存出去一字不差；片段带了其中任何一样就要 schema 3，原因写成 look；裁掉的不能比整个画面多', () => {
    const older = project(2), text = serializeLinkProject(older);
    expect(serializeLinkProject(parseLinkProject(JSON.parse(text)))).toBe(text);
    expect(text).not.toMatch(/flipX|flipY|"crop"|opacity/u);
    const withPart = (part: Partial<ReferenceCanvasTransform>) => ({ ...older, rundown: older.rundown.map(item => ({ ...item,
      referenceMediaClips: item.referenceMediaClips.map((clip, index) => index ? clip : { ...clip, canvasTransform: { ...clip.canvasTransform, ...part } }) })) });
    for (const part of [{ flipX: true }, { flipY: false }, { crop: { top: 0.1, right: 0, bottom: 0, left: 0 } }, { opacity: 0.5 }]) {
      expect(schemaVersion3Reasons(withPart(part))).toEqual(['look']);
      expect(() => parseLinkProject(withPart(part))).toThrow('schema 3');
      expect(parseLinkProject({ ...withPart(part), schemaVersion: 3 }).rundown[0]!.referenceMediaClips[0]!.canvasTransform).toMatchObject(part);
    }
    expect(() => parseLinkProject({ ...withPart({ crop: { top: 0, right: 0.5, bottom: 0, left: 0.5 } }), schemaVersion: 3 })).toThrow('裁剪掉的部分不能比整个画面还多');
    expect(() => parseLinkProject({ ...withPart({ opacity: 1.5 }), schemaVersion: 3 })).toThrow();
  });

  it('检查面板的「送到 OBS / 用 OBS 里的样子」把镜像、裁剪、不透明度当成位置和大小一样看', () => {
    const clip = (canvasTransform: ReferenceCanvasTransform, obsTransform?: 'project') => ({ canvasTransform, ...(obsTransform ? { obsTransform } : {}) });
    expect(clipLookOnlyInPreview(clip({ ...plain, flipX: true }))).toBe(true);
    expect(clipLookOnlyInPreview(clip({ ...plain, opacity: 0.5 }))).toBe(true);
    expect(clipLookOnlyInPreview(clip({ ...plain, crop: { top: 0.1, right: 0, bottom: 0, left: 0 } }))).toBe(true);
    expect(clipLookOnlyInPreview(clip({ ...plain, flipX: true }, 'project'))).toBe(false);
    expect(clipObsTransform(clip({ ...plain, opacity: 0.5 }))).toBeUndefined();
  });

  it('时间线事件只给带裁剪的片段带上素材原来的尺寸；别的片段的事件和以前一样', () => {
    const value = project(2, ['clip-0', 'clip-1']);
    const cropped = parseLinkProject({ ...value, rundown: value.rundown.map(item => ({ ...item, referenceMediaClips: item.referenceMediaClips.map((entry, index) => index
      ? { ...entry, canvasTransform: withLookParts(entry.canvasTransform, { crop: { top: 0.1, right: 0, bottom: 0, left: 0 } }) } : entry) })) });
    const starts = collectManagedMediaTimeline(cropped, 'song').events.filter(event => event.phase === 'start');
    expect(starts.map(event => event.sourceSize)).toEqual([undefined, source]);
    expect(Object.keys(starts[0]!)).not.toContain('sourceSize');
  });
});
