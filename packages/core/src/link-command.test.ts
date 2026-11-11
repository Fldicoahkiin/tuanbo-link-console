import { describe, expect, it } from 'vitest';
import { DEFAULT_REFERENCE_CANVAS_TRANSFORM, createEmptyLinkProject, createLightingDocument, parseLinkProject, type LinkAction, type LinkCue, type LinkProject, type RundownItem } from '@tb/schema';
import {
  addActionCommand,
  addMediaFolderCommand,
  addMediaAssetCommand,
  addRundownItemCommand,
  applyP1ProjectExportCommand,
  createItemContentCommand,
  duplicateRundownItemCommand,
  moveActionCommand,
  moveMediaAssetCommand,
  moveMediaFolderCommand,
  moveRundownItemCommand,
  moveVisualLayerCommand,
  removeActionCommand,
  removeMediaFolderCommand,
  removeMediaAssetCommand,
  removeVisualLayerCommand,
  removeRundownItemCommand,
  renameProjectCommand,
  renameMediaFolderCommand,
  replaceActionCommand,
  replaceCueCommand,
  setReferenceAudioCommand,
  setProjectFrameRateCommand,
  setProjectOutputCanvasCommand,
  setRundownItemP1StartTriggerCommand,
  synchronizeP1ProjectCommand,
  updateVisualLayerCommand,
  updateRundownItemCommand,
  type ItemContentDraft,
  type LinkCommand
} from './link-command';
import { moveContentCommand, normalizeContentTimeline, placeContentCommand, removeContentCommand, withContentTimeline } from './content-timeline';

const timestamp = () => '2026-08-26T00:00:00.000Z';

describe('LinkProject Command', () => {
  it('删除非空轨道与其中片段及 Cue 是一次可撤销操作，保留源素材和其他轨道', () => {
    let project = createEmptyLinkProject('删除轨道');
    project = addMediaAssetCommand({ id: 'asset', name: '图片', kind: 'image', folderId: null, relativePath: 'assets/image.png', sha256: 'a'.repeat(64), byteLength: 10, width: 100, height: 100 }).execute(project);
    project = addRundownItemCommand({ ...rundownItem('item', '节目'),
      visualLayers: ['remove', 'keep'].map(id => ({ id, name: id, locked: false, visible: true })),
      cues: ['remove', 'keep'].map(id => ({ ...linkCue(`cue-${id}`, id), layerId: id })),
      referenceMediaClips: ['remove', 'keep'].map(id => ({ id: `clip-${id}`, assetId: 'asset', layerId: id, label: id, startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 1000, canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM }))
    }).execute(project);
    const command = removeVisualLayerCommand('item', 'remove');
    const result = command.execute(project);
    expect(result.rundown[0]!.visualLayers.map(layer => layer.id)).toEqual(['keep']);
    expect(result.rundown[0]!.cues.map(cue => cue.id)).toEqual(['cue-keep']);
    expect(result.rundown[0]!.referenceMediaClips.map(clip => clip.id)).toEqual(['clip-keep']);
    expect(result.mediaAssets).toEqual(project.mediaAssets);
    expect(command.undo(project)).toEqual(project);
    const locked = updateVisualLayerCommand('item', { ...project.rundown[0]!.visualLayers.find(layer => layer.id === 'remove')!, locked: true }).execute(project);
    expect(() => removeVisualLayerCommand('item', 'remove').execute(locked)).toThrow('解锁');
  });
  it('局部 Cue 修改仍拒绝其他节目的动作 ID、未知图层和超出帧率的时间', () => {
    let project = createEmptyLinkProject('局部校验');
    project = addRundownItemCommand({ ...rundownItem('a', 'A'), cues: [{ ...linkCue('a-cue', 'A Cue'), actions: [programAction('shared-action', 1)] }] }).execute(project);
    project = addRundownItemCommand({ ...rundownItem('b', 'B'), cues: [linkCue('b-cue', 'B Cue')] }).execute(project);
    const before = structuredClone(project);
    const cue = project.rundown[1]!.cues[0]!;
    expect(() => replaceCueCommand('b', { ...cue, actions: [programAction('shared-action', 2)] }).execute(project)).toThrow('ID 重复');
    expect(() => replaceCueCommand('b', { ...cue, layerId: 'missing-layer' }).execute(project)).toThrow();
    const fps24 = setProjectFrameRateCommand('24').execute(project);
    expect(() => replaceCueCommand('b', { ...cue, timecode: { ...cue.timecode, frames: 29 } }).execute(fps24)).toThrow('帧号超出');
    expect(project).toEqual(before);
  });
  it('歌曲内容命令只换这首歌的内容：这首歌的灯光、音频和其他歌都是原来的对象，撤销回到原来那首歌', () => {
    const project = lightingProject();
    const [first, second] = project.rundown;
    const command = withContentTimeline(moveContentCommand('first', { kind: 'cue', id: 'first-cue' }, 3_000, { track: 'first-layer' }));
    const next = command.execute(project);
    const moved = next.rundown[0]!;
    expect(moved).not.toBe(first);
    expect(moved.cues[0]!.timecode.seconds).toBe(3);
    expect(moved.lighting).toBe(first!.lighting);
    expect(moved.referenceAudio).toBe(first!.referenceAudio);
    expect(next.rundown[1]).toBe(second);
    expect(next.rundown[1]!.lighting).toBe(second!.lighting);
    expect(next.mediaAssets).toBe(project.mediaAssets);
    expect(first!.cues[0]!.timecode.seconds).toBe(1);
    expect(command.undo(project).rundown[0]).toBe(first);
    for (const edit of [
      replaceActionCommand('first', 'first-cue', { ...programAction('first-action', 9) }),
      updateVisualLayerCommand('first', { id: 'first-layer', name: '改名', visible: true, locked: false }),
      removeContentCommand('first', [{ kind: 'clip', id: 'first-clip' }])
    ]) {
      const edited = withContentTimeline(edit).execute(project);
      expect(edited.rundown[0]!.lighting).toBe(first!.lighting);
      expect(edited.rundown[1]).toBe(second);
    }
  });
  it('歌曲内容命令照样拒绝坏数据：跨歌和工程级的 ID、找不到的素材、超出素材时长、图层、重叠、帧率和格式', () => {
    const project = lightingProject();
    const before = structuredClone(project);
    const edit = (mutate: (item: ItemContentDraft) => void) => () => createItemContentCommand('测试', 'first', mutate).execute(project);
    const cue = project.rundown[0]!.cues[0]!;
    const clip = project.rundown[0]!.referenceMediaClips[0]!;
    expect(edit((item) => { item.cues.push({ ...linkCue('second-action', '撞上别的歌的动作'), layerId: 'first-layer' }); })).toThrow('ID 重复：second-action');
    expect(edit((item) => { item.cues.push({ ...linkCue('second', '撞上别的歌'), layerId: 'first-layer' }); })).toThrow('ID 重复：second');
    expect(edit((item) => { item.visualLayers.push({ id: 'video', name: '撞上素材', visible: true, locked: false }); })).toThrow('ID 重复：video');
    expect(edit((item) => { item.cues.push({ ...linkCue('first-clip', '撞上自己的片段'), layerId: 'first-layer' }); })).toThrow('ID 重复：first-clip');
    expect(edit((item) => { item.referenceMediaClips[0]!.assetId = 'missing'; })).toThrow('参考素材片段引用不存在的素材：missing');
    expect(edit((item) => { item.referenceMediaClips[0]!.durationMs = 30_000; })).toThrow('超出原素材可用时长');
    expect(edit((item) => { item.cues[0]!.layerId = 'missing-layer'; })).toThrow('Cue 引用不存在的图层');
    expect(edit((item) => { item.referenceMediaClips.push({ ...clip, id: 'overlap' }); })).toThrow('同一视觉图层的时间片段不能重叠');
    expect(edit((item) => { item.cues[0]!.timecode = { ...cue.timecode, frames: 30 }; })).toThrow();
    const fps24 = setProjectFrameRateCommand('24').execute(project);
    expect(() => createItemContentCommand('测试', 'first', (item) => { item.cues[0]!.timecode = { ...cue.timecode, frames: 29 }; }).execute(fps24)).toThrow('帧号超出');
    expect(edit((item) => { item.cues[0]!.name = ''; })).toThrow();
    expect(() => createItemContentCommand('测试', 'missing', () => undefined).execute(project)).toThrow('节目不存在：missing');
    expect(project).toEqual(before);
  });
  it('节目、Cue、动作的全部修改都返回经过校验的新工程', () => {
    const initial = createEmptyLinkProject('初始', new Date('2026-08-25T00:00:00.000Z'));
    const item = rundownItem('item-a', '节目 A');
    const cue = linkCue('cue-a', 'Cue A');
    const action = programAction('action-a', 1);

    const named = renameProjectCommand('联动工程', timestamp).execute(initial);
    const timebaseChanged = setProjectFrameRateCommand('25', timestamp).execute(named);
    const canvasChanged = setProjectOutputCanvasCommand({ width: 1920, height: 1080 }, timestamp).execute(timebaseChanged);
    const withItem = addRundownItemCommand(item, undefined, timestamp).execute(canvasChanged);
    const updatedItem = updateRundownItemCommand('item-a', { title: '节目 A1', enabled: false, notes: '说明' }, timestamp).execute(withItem);
    const withCue = placeContentCommand('item-a', { cue: cue }, 'top', undefined, timestamp).execute(updatedItem);
    const withAction = addActionCommand('item-a', 'cue-a', action, undefined, timestamp).execute(withCue);

    expect(initial.name).toBe('初始');
    expect(withAction.name).toBe('联动工程');
    expect(withAction.timebase.frameRate).toBe('25');
    expect(withAction.outputCanvas).toEqual({ width: 1920, height: 1080 });
    expect(withAction.rundown[0]?.title).toBe('节目 A1');
    expect(withAction.rundown[0]?.enabled).toBe(false);
    expect(withAction.rundown[0]?.cues[0]?.actions[0]).toEqual(action);
    expect(withAction.updatedAt).toBe(timestamp());
  });

  it('覆盖、移动、复制、删除和参考音频命令可组合', () => {
    let project = createEmptyLinkProject('工程');
    project = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp).execute(project);
    project = addRundownItemCommand(rundownItem('b', 'B'), undefined, timestamp).execute(project);
    project = placeContentCommand('a', { cue: linkCue('cue-1', '一') }, 'top', undefined, timestamp).execute(project);
    project = placeContentCommand('a', { cue: linkCue('cue-2', '二') }, 'top', undefined, timestamp).execute(project);
    project = addActionCommand('a', 'cue-1', programAction('x', 1), undefined, timestamp).execute(project);
    project = addActionCommand('a', 'cue-1', programAction('y', 2), undefined, timestamp).execute(project);
    project = replaceActionCommand('a', 'cue-1', programAction('x', 7), timestamp).execute(project);
    project = moveActionCommand('a', 'cue-1', 'y', 0, timestamp).execute(project);
    project = replaceCueCommand('a', { ...linkCue('cue-2', '二改'), layerId: project.rundown[0]!.cues[1]!.layerId, notes: '已改' }, timestamp).execute(project);
    project = moveRundownItemCommand('b', 0, timestamp).execute(project);
    project = duplicateRundownItemCommand('a', sequenceIds('copy', 'copy-cue-1', 'copy-action-1', 'copy-action-2', 'copy-cue-2', 'copy-track'), timestamp).execute(project);
    project = setReferenceAudioCommand('a', {
      assetId: 'audio',
      relativePath: 'assets/reference-audio/a.wav',
      sha256: 'a'.repeat(64),
      durationMs: 1_000
    }, timestamp).execute(project);
    project = removeActionCommand('a', 'cue-1', 'x', timestamp).execute(project);
    project = removeContentCommand('a', [{ kind: 'cue', id: 'cue-2' }], timestamp).execute(project);
    project = removeRundownItemCommand('b', timestamp).execute(project);

    expect(project.rundown.map((item) => item.id)).toEqual(['a', 'copy']);
    expect(project.rundown[0]?.referenceAudio?.sha256).toBe('a'.repeat(64));
    expect(project.rundown[0]?.cues.map((candidate) => candidate.id)).toEqual(['cue-1']);
    expect(project.rundown[0]?.cues[0]?.actions.map((candidate) => candidate.id)).toEqual(['y']);
    expect(project.rundown[1]?.cues.flatMap((candidate) => candidate.actions).map((candidate) => candidate.id))
      .toEqual(['copy-action-1', 'copy-action-2']);
    // The copy has tracks of its own, holding its own cues.
    expect(project.rundown[1]?.visualLayers.map((layer) => layer.id)).toEqual(['copy-track']);
    expect(project.rundown[1]?.cues.map((cue) => cue.layerId)).toEqual(['copy-track', 'copy-track']);
  });

  it('轨道排序、显示锁定和删除全部通过 Command', () => {
    let project = createEmptyLinkProject('图层工程');
    const ids = ['layer-top', 'layer-obs', 'layer-media'];
    project = addRundownItemCommand({ ...rundownItem('item', '节目'), visualLayers: ids.map(id => ({ id, name: id, visible: true, locked: false })),
      cues: ids.map(id => ({ ...linkCue(`cue-${id}`, id), layerId: id })) }, undefined, timestamp).execute(project);
    project = moveVisualLayerCommand('item', 'layer-media', 0, timestamp).execute(project);
    project = updateVisualLayerCommand('item', { id: 'layer-obs', name: '图层 2', visible: false, locked: true }, timestamp).execute(project);
    project = removeVisualLayerCommand('item', 'layer-top', timestamp).execute(project);

    expect(project.rundown[0]?.visualLayers.map((layer) => layer.id)).toEqual(['layer-media', 'layer-obs']);
    expect(project.rundown[0]?.visualLayers[1]).toMatchObject({ visible: false, locked: true });
  });

  it('undo 恢复 execute 前快照', () => {
    const project = createEmptyLinkProject('工程');
    const command = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp);
    const next = command.execute(project);
    expect(next.rundown).toHaveLength(1);
    expect(command.undo(project)).toEqual(project);
  });

  it('P1 播放触发只能通过 Command 设置、替换和移除', () => {
    const initial = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp).execute(createEmptyLinkProject('工程'));
    let project = initial;
    const command = setRundownItemP1StartTriggerCommand('a', {
      id: 'p1-start', label: 'P1 播放', kind: 'p1.midiNotePulse', portProfileId: 'p1-output',
      channel: 1, note: 60, velocity: 127, durationMs: 80
    }, timestamp);
    project = command.execute(project);
    expect(project.rundown[0]?.p1StartTrigger).toMatchObject({ kind: 'p1.midiNotePulse', note: 60 });
    const removed = setRundownItemP1StartTriggerCommand('a', null, timestamp).execute(project);
    expect(removed.rundown[0]?.p1StartTrigger).toBeUndefined();
    expect(command.undo(initial)).toEqual(initial);
  });

  it('唯一相同音频自动绑定手工节目并保留时间线，不生成空白重复节目', () => {
    const imported = p1ImportedItem('a'.repeat(64), 'P1 歌曲', 'list', 'a');
    const existing = { ...rundownItem('manual', '已有编排'), referenceAudio: imported.referenceAudio, cues: [linkCue('existing-cue', '机位')] };
    const project = addRundownItemCommand(existing).execute(createEmptyLinkProject('测试'));
    const next = synchronizeP1ProjectCommand({ sourceSha256: 'b'.repeat(64), playlists: [{ id: 'list', name: '列表', sourceIndex: 0 }], items: [imported] }).execute(project);
    expect(next.rundown).toHaveLength(1);
    expect(next.rundown[0]).toMatchObject({ id: 'manual', cues: [{ id: 'existing-cue' }], p1Media: imported.p1Media });
  });

  it('P1 全量读取按稳定映射更新顺序并保留已有 Cue', () => {
    const playlist = { id: 'p1-playlist-1', name: '演出歌单', sourceIndex: 0 };
    const firstSnapshot = {
      sourceSha256: '1'.repeat(64),
      playlists: [playlist],
      items: [
        p1ImportedItem('a'.repeat(64), '第一首', playlist.id, 'a'),
        p1ImportedItem('b'.repeat(64), '第二首', playlist.id, 'b')
      ]
    };
    let project = synchronizeP1ProjectCommand(firstSnapshot, sequenceIds('item-a', 'item-b'), timestamp)
      .execute(createEmptyLinkProject('P1 工程'));
    project = placeContentCommand('item-a', { cue: linkCue('camera-cue', '切机位') }, 'top', undefined, timestamp).execute(project);

    project = synchronizeP1ProjectCommand({
      sourceSha256: '2'.repeat(64),
      playlists: [playlist],
      items: [
        p1ImportedItem('b'.repeat(64), '第二首（P1 改名）', playlist.id, 'b'),
        p1ImportedItem('a'.repeat(64), '第一首', playlist.id, 'a')
      ]
    }, sequenceIds(), timestamp).execute(project);

    expect(project.rundown.map((item) => item.id)).toEqual(['item-b', 'item-a']);
    expect(project.rundown[0]?.title).toBe('第二首（P1 改名）');
    expect(project.rundown[1]?.cues[0]?.id).toBe('camera-cue');
    expect(project.p1Sync?.sourceSha256).toBe('2'.repeat(64));
  });

  it('P1 写回结果通过 Command 更新绑定，未写入 P1 的节目解除旧绑定', () => {
    const playlist = { id: 'p1-playlist-1', name: '演出歌单', sourceIndex: 0 };
    let project = synchronizeP1ProjectCommand({
      sourceSha256: '1'.repeat(64),
      playlists: [playlist],
      items: [p1ImportedItem('a'.repeat(64), '第一首', playlist.id, 'a')]
    }, sequenceIds('item-a'), timestamp).execute(createEmptyLinkProject('P1 工程'));
    project = addRundownItemCommand(rundownItem('manual', '手工节目'), undefined, timestamp).execute(project);

    project = applyP1ProjectExportCommand({
      sourceSha256: '3'.repeat(64),
      playlists: [playlist],
      itemBindings: [{ itemId: 'manual', p1Media: p1Binding('c'.repeat(64), playlist.id, 'manual.wav') }]
    }, timestamp).execute(project);

    expect(project.rundown.find((item) => item.id === 'item-a')?.p1Media).toBeUndefined();
    expect(project.rundown.find((item) => item.id === 'manual')?.p1Media?.sourceKey).toBe('c'.repeat(64));
    expect(project.p1Sync?.sourceSha256).toBe('3'.repeat(64));
  });

  it('切换工程帧率时拒绝现有 Cue 的非法帧号且不修改原工程', () => {
    let project = createEmptyLinkProject('工程');
    project = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp).execute(project);
    project = placeContentCommand('a', { cue: {
      ...linkCue('cue-1', '一'),
      timecode: { hours: 0, minutes: 0, seconds: 1, frames: 29 }
    } }, 'top', undefined, timestamp).execute(project);

    expect(() => setProjectFrameRateCommand('25', timestamp).execute(project)).toThrow('帧号超出 25 fps 范围');
    expect(project.timebase.frameRate).toBe('30');
  });

  it('每一种工程修改命令都能恢复各自 execute 前快照', () => {
    let base = createEmptyLinkProject('工程');
    base = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp).execute(base);
    base = addRundownItemCommand(rundownItem('b', 'B'), undefined, timestamp).execute(base);
    base = placeContentCommand('a', { cue: linkCue('cue-1', '一') }, 'top', undefined, timestamp).execute(base);
    base = placeContentCommand('a', { cue: linkCue('cue-2', '二') }, 'top', undefined, timestamp).execute(base);
    base = addActionCommand('a', 'cue-1', programAction('x', 1), undefined, timestamp).execute(base);
    base = addActionCommand('a', 'cue-1', programAction('y', 2), undefined, timestamp).execute(base);
    const reference = { assetId: 'audio', relativePath: 'assets/reference-audio/a.wav', sha256: 'a'.repeat(64), durationMs: 1_000 };
    const commands: LinkCommand[] = [
      renameProjectCommand('新名称', timestamp),
      setProjectFrameRateCommand('25', timestamp),
      addRundownItemCommand(rundownItem('c', 'C'), undefined, timestamp),
      updateRundownItemCommand('a', { title: 'A+', enabled: false, notes: '改' }, timestamp),
      removeRundownItemCommand('b', timestamp),
      moveRundownItemCommand('b', 0, timestamp),
      duplicateRundownItemCommand('a', sequenceIds('copy-item', 'copy-cue-1', 'copy-action-1', 'copy-action-2', 'copy-cue-2', 'copy-track'), timestamp),
      setReferenceAudioCommand('a', reference, timestamp),
      setRundownItemP1StartTriggerCommand('a', { id: 'p1', label: 'P1', kind: 'midi.programChange', portProfileId: 'p1-output', channel: 1, program: 1 }, timestamp),
      placeContentCommand('a', { cue: linkCue('cue-3', '三') }, 'top', undefined, timestamp),
      replaceCueCommand('a', { ...linkCue('cue-1', '一改'), layerId: base.rundown[0]!.cues[0]!.layerId, notes: '改' }, timestamp),
      removeContentCommand('a', [{ kind: 'cue', id: 'cue-2' }], timestamp),
      addActionCommand('a', 'cue-1', programAction('z', 3), undefined, timestamp),
      replaceActionCommand('a', 'cue-1', programAction('x', 9), timestamp),
      removeActionCommand('a', 'cue-1', 'x', timestamp),
      moveActionCommand('a', 'cue-1', 'y', 0, timestamp)
    ];
    for (const command of commands) {
      expect(command.execute(base)).not.toEqual(base);
      expect(command.undo(base)).toEqual(base);
    }
  });

  it('媒体素材与参考片段只能经 Command 添加并保持引用安全', () => {
    let project = createEmptyLinkProject('媒体工程');
    project = addRundownItemCommand(rundownItem('a', 'A'), undefined, timestamp).execute(project);
    const asset = {
      id: 'asset',
      name: '参考视频',
      kind: 'video' as const,
      folderId: null,
      relativePath: 'assets/reference-media/a.mp4',
      sha256: 'b'.repeat(64),
      byteLength: 2_048,
      durationMs: 5_000,
      width: 1920,
      height: 1080
    };
    project = addMediaAssetCommand(asset, timestamp).execute(project);
    project = placeContentCommand('a', { clip: {
      id: 'clip',
      assetId: asset.id,
      label: asset.name,
      startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
      sourceOffsetMs: 500,
      durationMs: 4_500,
      canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
    } }, 'top', undefined, timestamp).execute(project);

    expect(project.mediaAssets).toEqual([{ ...asset, folderId: null }]);
    expect(project.rundown[0]?.referenceMediaClips).toHaveLength(1);
    expect(() => removeMediaAssetCommand(asset.id, timestamp).execute(project)).toThrow('素材还在被节目「A」的时间线使用');
    project = removeContentCommand('a', [{ kind: 'clip', id: 'clip' }], timestamp).execute(project);
    expect(project.rundown[0]?.visualLayers).toEqual([]);
    project = removeMediaAssetCommand(asset.id, timestamp).execute(project);
    expect(project.mediaAssets).toHaveLength(0);
  });

  it('资源文件夹的新建、重命名、移动和删除都经过 Command 与引用校验', () => {
    let project = createEmptyLinkProject('资源库工程');
    project = addMediaFolderCommand({ id: 'folder-a', name: '演出素材', parentId: null }, timestamp).execute(project);
    project = addMediaFolderCommand({ id: 'folder-b', name: '开场', parentId: 'folder-a' }, timestamp).execute(project);
    project = renameMediaFolderCommand('folder-b', '开场片', timestamp).execute(project);
    project = addMediaAssetCommand({
      id: 'image',
      name: '开场图',
      kind: 'image',
      folderId: null,
      relativePath: 'assets/reference-media/opening.png',
      sha256: 'c'.repeat(64),
      byteLength: 1_024,
      width: 1080,
      height: 1920
    }, timestamp).execute(project);
    project = moveMediaAssetCommand('image', 'folder-b', timestamp).execute(project);

    expect(project.mediaFolders[1]).toMatchObject({ name: '开场片', parentId: 'folder-a' });
    expect(project.mediaAssets[0]?.folderId).toBe('folder-b');
    expect(() => removeMediaFolderCommand('folder-b', timestamp).execute(project)).toThrow(/媒体素材/);
    expect(() => moveMediaFolderCommand('folder-a', 'folder-b', timestamp).execute(project)).toThrow(/循环/);

    project = moveMediaAssetCommand('image', null, timestamp).execute(project);
    project = removeMediaFolderCommand('folder-b', timestamp).execute(project);
    project = removeMediaFolderCommand('folder-a', timestamp).execute(project);
    expect(project.mediaFolders).toHaveLength(0);
  });
});

function rundownItem(id: string, title: string): RundownItem {
  return { id, title, enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [] };
}

/** Two songs with lighting and audio; the first has a track holding a 5 s video clip and an instant cue. */
function lightingProject(): LinkProject {
  const song = (id: string, marker: string): RundownItem => ({
    ...rundownItem(id, id), lighting: createLightingDocument(),
    referenceAudio: { assetId: `audio-${id}`, relativePath: `assets/${id}.wav`, sha256: marker.repeat(64), durationMs: 60_000 },
    cues: [{ ...linkCue(`${id}-cue`, `${id} Cue`), actions: [programAction(`${id}-action`, 1)] }]
  });
  const first = song('first', 'a');
  first.visualLayers = [{ id: 'first-layer', name: '轨道', visible: true, locked: false }];
  first.cues[0]!.layerId = 'first-layer';
  first.referenceMediaClips = [{ id: 'first-clip', assetId: 'video', label: '视频', layerId: 'first-layer', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, durationMs: 5_000, canvasTransform: DEFAULT_REFERENCE_CANVAS_TRANSFORM }];
  // As opened: under the content timeline rules.
  return normalizeContentTimeline(parseLinkProject({ ...createEmptyLinkProject('内容命令'), schemaVersion: 2, obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '视频', kind: 'video', folderId: null, relativePath: 'assets/video.mp4', sha256: 'c'.repeat(64), byteLength: 1, durationMs: 20_000, width: 1080, height: 1920 }],
    rundown: [first, song('second', 'b')] }));
}

function linkCue(id: string, name: string): LinkCue {
  return {
    id,
    name,
    timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 },
    enabled: true,
    notes: '',
    actions: []
  };
}

function programAction(id: string, program: number): LinkAction {
  return {
    id,
    label: id,
    kind: 'midi.programChange',
    portProfileId: 'p1-output',
    channel: 1,
    program
  };
}

function p1ImportedItem(sourceKey: string, title: string, playlistId: string, marker: string) {
  return {
    title,
    referenceAudio: {
      assetId: `audio-${marker}`,
      relativePath: `assets/reference-audio/${marker}.wav`,
      sha256: marker.repeat(64),
      durationMs: 1_000
    },
    p1Media: p1Binding(sourceKey, playlistId, `${marker}.wav`)
  };
}

function p1Binding(sourceKey: string, playlistId: string, sourceFileName: string) {
  return {
    sourceKey,
    playlistId,
    sourceFileName,
    playEndAction: 'stop' as const,
    volume: 100,
    muted: false,
    shortcut: '',
    midiStartTime: '0'
  };
}

function sequenceIds(...ids: string[]): () => string {
  let index = 0;
  return () => {
    const id = ids[index];
    if (!id) throw new Error('测试 ID 已耗尽');
    index += 1;
    return id;
  };
}
