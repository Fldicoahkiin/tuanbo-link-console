import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMediaAssetCommand,
  addRundownItemCommand,
  moveContentCommand,
  placeContentCommand,
  removeContentCommand,
  renameProjectCommand,
  replaceCueCommand,
  resolveTimelineState
} from '@tb/core/link';
import { setLightingLibraryViewCommand } from '@tb/core/link';
import { createEmptyLinkProject, createLightingDocument, parseLinkProject, type RundownItem } from '@tb/schema';
import { useDocumentStore } from './document-store';

beforeEach(() => {
  useDocumentStore.getState().setProject(createEmptyLinkProject('初始工程'), null);
});

describe('document store command history', () => {
  it('分类浏览位置不占用撤销，并在撤销和重做业务修改后保留', () => {
    const store=useDocumentStore.getState();store.execute(renameProjectCommand('已修改'));
    const view={section:'front' as const,tone:'bright' as const,people:3,zone:'front' as const,view:'music' as const,effectCategory:'effect:music:0',scope:'all' as const,query:'前区'};
    store.execute(setLightingLibraryViewCommand(view));expect(useDocumentStore.getState().past).toHaveLength(1);
    store.undo();expect(useDocumentStore.getState().project?.name).toBe('初始工程');expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.userLibrary?.view).toEqual(view);
    store.redo();expect(useDocumentStore.getState().project?.name).toBe('已修改');expect(useDocumentStore.getState().project?.ma2MaterialLibrary?.userLibrary?.view).toEqual(view);
  });
  it('编辑单个 Cue 的历史共享未变化节目与素材，撤销重做不改写旧快照', () => {
    const store = useDocumentStore.getState();
    for (const id of ['first', 'second']) store.execute(addRundownItemCommand({ id, title: id, enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [
      { id: `${id}-cue`, name: '原 Cue', enabled: true, notes: '', timecode: { hours: 0, minutes: 0, seconds: 10, frames: 0 }, actions: [] }
    ] }));
    const before = useDocumentStore.getState().project!;
    const oldCue = before.rundown[0]!.cues[0]!;
    store.execute(replaceCueCommand('first', { ...oldCue, name: '修改后', timecode: { ...oldCue.timecode, seconds: 20 } }));
    const after = useDocumentStore.getState().project!;
    expect(after.rundown[1]).toBe(before.rundown[1]);
    expect(after.mediaAssets).toBe(before.mediaAssets);
    expect(after.rundown[0]!.visualLayers).toBe(before.rundown[0]!.visualLayers);
    expect(oldCue.name).toBe('原 Cue'); expect(oldCue.timecode.seconds).toBe(10);
    store.undo(); expect(useDocumentStore.getState().project).toBe(before);
    store.redo(); expect(useDocumentStore.getState().project!.rundown[0]!.cues[0]!.name).toBe('修改后');
    expect(useDocumentStore.getState().project!.rundown[1]).toBe(before.rundown[1]);
  });
  it('改一首歌的内容，别的歌和这首歌的灯光都是原来的对象；撤销重做各算一次修订，撤销回到原来那首歌', () => {
    const song = (id: string): RundownItem => ({ id, title: id, enabled: true, notes: '', lighting: createLightingDocument(),
      visualLayers: [{ id: `${id}-layer`, name: '轨道', visible: true, locked: false }], referenceMediaClips: [],
      cues: [{ id: `${id}-cue`, name: 'Cue', enabled: true, notes: '', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, layerId: `${id}-layer`, actions: [] }] });
    const store = useDocumentStore.getState();
    store.setProject(parseLinkProject({ ...createEmptyLinkProject('三首歌'), schemaVersion: 2, obsOutputMode: 'scenes', rundown: ['a', 'b', 'c'].map(song) }), null);
    const before = useDocumentStore.getState().project!;
    const revision = useDocumentStore.getState().revision;
    store.execute(moveContentCommand('b', { kind: 'cue', id: 'b-cue' }, 4_000, { track: 'b-layer' }));
    const after = useDocumentStore.getState().project!;
    expect(after.rundown[0]).toBe(before.rundown[0]);
    expect(after.rundown[2]).toBe(before.rundown[2]);
    expect(after.rundown[1]).not.toBe(before.rundown[1]);
    expect(after.rundown[1]!.lighting).toBe(before.rundown[1]!.lighting);
    expect(after.rundown[1]!.visualLayers).toBe(before.rundown[1]!.visualLayers);
    expect(after.rundown[1]!.cues[0]!.timecode.seconds).toBe(4);
    expect(useDocumentStore.getState().revision).toBe(revision + 1);
    store.undo();
    expect(useDocumentStore.getState().project).toBe(before);
    expect(useDocumentStore.getState().project!.rundown[1]).toBe(before.rundown[1]);
    expect(useDocumentStore.getState().revision).toBe(revision + 2);
    store.redo();
    expect(useDocumentStore.getState().project!.rundown[0]).toBe(before.rundown[0]);
    expect(useDocumentStore.getState().project!.rundown[1]!.lighting).toBe(before.rundown[1]!.lighting);
    expect(useDocumentStore.getState().revision).toBe(revision + 3);
  });
  it('旧工程以 OBS 场景作为打开基线，编辑撤销不会恢复软件编排模式', () => {
    const project = createEmptyLinkProject('旧画面工程'); project.obsOutputMode = 'managed';
    const store = useDocumentStore.getState(); store.setProject(project, 'C:\\shows\\legacy.tblink');
    expect(project.obsOutputMode).toBe('managed');
    expect(useDocumentStore.getState().project?.obsOutputMode).toBe('scenes');
    expect(useDocumentStore.getState().dirty).toBe(true);
    store.execute(renameProjectCommand('新名称')); store.undo();
    expect(useDocumentStore.getState().project).toMatchObject({ name: '旧画面工程', obsOutputMode: 'scenes' });
  });
  it('已有轨道的未分配 Cue 在打开时放到顶层轨道，后续添加只有一步撤销', () => {
    const project = createEmptyLinkProject('已有图层');
    project.obsOutputMode = 'scenes';
    const cue = { id: 'cue', name: '打点', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, enabled: true, notes: '', actions: [] };
    project.rundown.push({ id: 'song', title: '节目', enabled: true, notes: '', referenceMediaClips: [], cues: [cue], visualLayers: [{ id: 'user-layer', name: '用户图层', visible: true, locked: false }] });
    const store = useDocumentStore.getState();
    store.setProject(project, 'C:\\shows\\layers.tblink');
    const prepared = useDocumentStore.getState().project!.rundown[0]!;
    expect(prepared.cues[0]!.layerId).toBe('user-layer');
    expect(prepared.visualLayers.map((layer) => layer.id)).toEqual(['user-layer']);
    expect(useDocumentStore.getState().past).toHaveLength(0);
    expect(useDocumentStore.getState().dirty).toBe(true);
    expect(project.rundown[0]!.cues[0]!.layerId).toBeUndefined();
    store.execute(placeContentCommand('song', { cue: { ...cue, id: 'added' } }, 'top'));
    expect(useDocumentStore.getState().project!.rundown[0]!.cues[1]!.layerId).toBe('user-layer');
    expect(useDocumentStore.getState().past).toHaveLength(1);
    store.undo();
    expect(useDocumentStore.getState().project!.rundown[0]).toEqual(prepared);
  });
  it('旧工程在历史之前整理：没长度的机位补上长度，首个编辑可直接撤销且不改原输入', () => {
    const project = createEmptyLinkProject('旧工程');
    project.rundown.push({ id: 'legacy', title: '节目', enabled: true, notes: '', visualLayers: [], cues: [{ id: 'camera', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, enabled: true, notes: '', actions: [{ id: 'scene', label: '切机位', kind: 'obs.setProgramScene' as const, sceneName: '机位' }] }], referenceMediaClips: [] });
    const store = useDocumentStore.getState();
    store.setProject(project, 'C:\\shows\\legacy.tblink');
    const prepared = structuredClone(useDocumentStore.getState().project!.rundown[0]!);
    expect(prepared.visualLayers.map((layer) => layer.id)).toEqual(['track-camera']);
    expect(prepared.cues[0]).toMatchObject({ layerId: 'track-camera', durationMs: 5_000 });
    expect(project.rundown[0]!.cues[0]!.durationMs).toBeUndefined();
    expect(useDocumentStore.getState()).toMatchObject({ past: [], dirty: true, upgradeBackupPending: true });
    store.execute(renameProjectCommand('改名'));
    store.undo();
    expect(useDocumentStore.getState().project!.name).toBe('旧工程');
    expect(useDocumentStore.getState().project!.rundown[0]).toEqual(prepared);
    expect(useDocumentStore.getState().past).toHaveLength(0);
  });
  it('新节目和它的轨道只有一个撤销步骤，重做保留轨道身份；空节目没有轨道', () => {
    const store = useDocumentStore.getState();
    store.execute(addRundownItemCommand({ id: 'empty', title: '空节目', enabled: true, notes: '', visualLayers: [{ id: 'unused', name: '图层 1', visible: true, locked: false }], cues: [], referenceMediaClips: [] }));
    expect(useDocumentStore.getState().project!.rundown[0]!.visualLayers).toEqual([]);
    store.execute(addRundownItemCommand({ id: 'new', title: '节目', enabled: true, notes: '', visualLayers: [], cues: [{ id: 'camera', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, enabled: true, notes: '', actions: [{ id: 'scene', label: '切机位', kind: 'obs.setProgramScene' as const, sceneName: '机位' }] }], referenceMediaClips: [] }));
    const layers = structuredClone(useDocumentStore.getState().project!.rundown[1]!.visualLayers);
    expect(layers.map((layer) => layer.id)).toEqual(['track-camera']);
    expect(useDocumentStore.getState().past).toHaveLength(2);
    store.undo();
    expect(useDocumentStore.getState().project!.rundown).toHaveLength(1);
    store.redo();
    expect(useDocumentStore.getState().project!.rundown[1]!.visualLayers).toEqual(layers);
  });
  it('所有修改经 Command 执行并可连续撤销和重做', () => {
    const store = useDocumentStore.getState();
    store.execute(addRundownItemCommand({
      id: 'item-1',
      title: '节目一',
      enabled: true,
      notes: '',
      visualLayers: [],
      referenceMediaClips: [],
      cues: []
    }));
    store.execute(renameProjectCommand('演出工程'));

    expect(useDocumentStore.getState().project).toMatchObject({ name: '演出工程' });
    expect(useDocumentStore.getState().project?.rundown).toHaveLength(1);

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project?.name).toBe('初始工程');
    expect(useDocumentStore.getState().project?.rundown).toHaveLength(1);

    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project?.rundown).toHaveLength(0);

    useDocumentStore.getState().redo();
    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().project).toMatchObject({ name: '演出工程' });
    expect(useDocumentStore.getState().project?.rundown[0]?.title).toBe('节目一');
  });

  it('撤销后执行新命令会清空重做分支', () => {
    useDocumentStore.getState().execute(renameProjectCommand('第一名称'));
    useDocumentStore.getState().undo();
    useDocumentStore.getState().execute(renameProjectCommand('第二名称'));

    expect(useDocumentStore.getState().future).toHaveLength(0);
    expect(useDocumentStore.getState().project?.name).toBe('第二名称');
  });

  it('旧修订保存完成时不会把更新中的工程错误标记为已保存', () => {
    const store = useDocumentStore.getState();
    store.execute(renameProjectCommand('第一名称'));
    const { stateId: savingState, documentId } = useDocumentStore.getState();
    store.execute(renameProjectCommand('第二名称'));
    useDocumentStore.getState().markSaved('C:\\shows\\test.tblink', savingState, documentId);

    expect(useDocumentStore.getState()).toMatchObject({ path: 'C:\\shows\\test.tblink', dirty: true });
    useDocumentStore.getState().markSaved('C:\\shows\\test.tblink', useDocumentStore.getState().stateId, documentId);
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it('撤销或重做回到保存时的状态会清除改动标记，离开后重新标记', () => {
    const store = useDocumentStore.getState();
    store.execute(renameProjectCommand('第一名称'));
    const { stateId, documentId } = useDocumentStore.getState();
    store.markSaved('C:\\shows\\saved.tblink', stateId, documentId);
    expect(useDocumentStore.getState().dirty).toBe(false);

    store.execute(renameProjectCommand('第二名称'));
    expect(useDocumentStore.getState().dirty).toBe(true);
    store.undo();
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, project: { name: '第一名称' } });
    store.undo();
    expect(useDocumentStore.getState()).toMatchObject({ dirty: true, project: { name: '初始工程' } });
    store.redo();
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, project: { name: '第一名称' } });
    store.redo();
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('保存点被新的编辑分支丢弃后，撤销不会误报已保存', () => {
    const store = useDocumentStore.getState();
    store.execute(renameProjectCommand('保存的名称'));
    const { stateId, documentId } = useDocumentStore.getState();
    store.markSaved('C:\\shows\\saved.tblink', stateId, documentId);
    store.undo();
    store.execute(renameProjectCommand('另一分支'));
    store.undo();
    expect(useDocumentStore.getState()).toMatchObject({ dirty: true, project: { name: '初始工程' } });
  });

  it('合并为一步的连续编辑不会沿用保存点', () => {
    const store = useDocumentStore.getState();
    store.execute({ ...renameProjectCommand('拖动 1'), historyGroup: 'drag' });
    const { stateId, documentId } = useDocumentStore.getState();
    store.markSaved('C:\\shows\\saved.tblink', stateId, documentId);
    store.execute({ ...renameProjectCommand('拖动 2'), historyGroup: 'drag' });
    expect(useDocumentStore.getState().past).toHaveLength(1);
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('控台回读改写历史后，任何撤销位置都不再等同磁盘内容', () => {
    const store = useDocumentStore.getState();
    store.execute(renameProjectCommand('已保存'));
    const { stateId, documentId } = useDocumentStore.getState();
    store.markSaved('C:\\shows\\saved.tblink', stateId, documentId);
    const rename = renameProjectCommand('回读名称');
    store.execute({ ...rename, historyRebaseKey: 'readback', rebaseHistory: project => ({ ...project, notes: '控台版本' }) });
    expect(useDocumentStore.getState().dirty).toBe(true);
    store.undo();
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('新建工程不算改动；打开时升级、恢复的未保存内容一开始就有改动', () => {
    const store = useDocumentStore.getState();
    store.setProject(createEmptyLinkProject('新建'), null);
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, upgradeBackupPending: false });

    const current = createEmptyLinkProject('当前格式'); current.obsOutputMode = 'scenes';
    store.setProject(current, 'C:\\shows\\current.tblink');
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, upgradeBackupPending: false });

    store.setProject(current, 'C:\\shows\\upgraded.tblink', { upgraded: true });
    expect(useDocumentStore.getState()).toMatchObject({ dirty: true, upgradeBackupPending: true });

    store.setProject(current, 'C:\\shows\\restored.tblink', { restored: true });
    expect(useDocumentStore.getState()).toMatchObject({ dirty: true, upgradeBackupPending: false });
    store.setProject(current, null, { restored: true });
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('保存会清除升级备份和已同步到控台的标记；切换工程也会清除', () => {
    const store = useDocumentStore.getState();
    const legacy = createEmptyLinkProject('旧工程');
    store.setProject(legacy, 'C:\\shows\\legacy.tblink');
    const { stateId, documentId } = useDocumentStore.getState();
    expect(useDocumentStore.getState().upgradeBackupPending).toBe(true);
    store.markConsoleSynced(documentId);
    expect(useDocumentStore.getState().consoleSynced).toBe(true);
    store.markSaved('C:\\shows\\legacy.tblink', stateId, documentId);
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, upgradeBackupPending: false, consoleSynced: false });

    store.markConsoleSynced(documentId);
    store.setProject(createEmptyLinkProject('其他'), null);
    expect(useDocumentStore.getState().consoleSynced).toBe(false);
    expect(() => useDocumentStore.getState().markConsoleSynced(documentId)).toThrow('工程已切换');
  });

  it('每个打开的文档有自己的恢复副本会话，保存不更换', () => {
    const first = useDocumentStore.getState().sessionId;
    const { stateId, documentId } = useDocumentStore.getState();
    useDocumentStore.getState().markSaved('C:\\shows\\a.tblink', stateId, documentId);
    expect(useDocumentStore.getState().sessionId).toBe(first);
    useDocumentStore.getState().setProject(createEmptyLinkProject('另一个'), null);
    expect(useDocumentStore.getState().sessionId).not.toBe(first);
  });

  it('每次打开文档生成新会话标识，编辑和保存路径变化不更换标识', () => {
    const initialDocumentId = useDocumentStore.getState().documentId;
    useDocumentStore.getState().execute(renameProjectCommand('编辑后'));
    useDocumentStore.getState().markSaved('C:\\shows\\copy.tblink', useDocumentStore.getState().stateId, initialDocumentId);
    expect(useDocumentStore.getState().documentId).toBe(initialDocumentId);

    const copiedProject = useDocumentStore.getState().project;
    if (!copiedProject) throw new Error('测试工程不存在');
    useDocumentStore.getState().setProject(copiedProject, 'C:\\shows\\opened-copy.tblink');
    expect(useDocumentStore.getState().documentId).toBe(initialDocumentId + 1);
  });

  it('旧文档的异步保存和命令不能写入后来打开的工程', () => {
    const oldDocumentId = useDocumentStore.getState().documentId;
    const nextProject = createEmptyLinkProject('后来打开的工程');
    useDocumentStore.getState().setProject(nextProject, 'C:\\shows\\new.tblink');

    useDocumentStore.getState().markSaved('C:\\shows\\old.tblink', useDocumentStore.getState().stateId, oldDocumentId);
    expect(useDocumentStore.getState()).toMatchObject({
      project: { name: '后来打开的工程' },
      path: 'C:\\shows\\new.tblink'
    });
    expect(() => useDocumentStore.getState().executeForDocument(oldDocumentId, renameProjectCommand('错误覆盖')))
      .toThrow('工程已切换');
    expect(useDocumentStore.getState().project?.name).toBe('后来打开的工程');
  });

  it('删除当前有效视频和 OBS Cue 后解析状态立即同步，undo/redo 完整恢复和移除', () => {
    const store = useDocumentStore.getState();
    store.execute(addRundownItemCommand({ id: 'item', title: '节目', enabled: true, notes: '', visualLayers: [], referenceMediaClips: [], cues: [] }));
    store.execute(addMediaAssetCommand({
      id: 'video', name: '视频', kind: 'video', folderId: null,
      relativePath: 'assets/reference-media/video.mp4', sha256: 'a'.repeat(64), byteLength: 10,
      durationMs: 10_000, width: 1080, height: 1920
    }));
    store.execute(placeContentCommand('item', { clip: {
      id: 'clip', assetId: 'video', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      sourceOffsetMs: 0, durationMs: 5_000,
      canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
    } }, 'top'));
    store.execute(placeContentCommand('item', { cue: {
      id: 'obs', name: '显示机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      durationMs: 5_000, enabled: true, notes: '', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
      }]
    } }, 'top'));
    expect(useDocumentStore.getState().project!.rundown[0]!.visualLayers.map((layer) => layer.id)).toEqual(['track-obs', 'track-clip']);

    expect(currentTimelineState()).toMatchObject({ activeVisualClipIds: ['clip'], activeObsCueIds: ['obs'] });
    store.execute(removeContentCommand('item', [{ kind: 'clip', id: 'clip' }]));
    expect(currentTimelineState().activeVisualClipIds).toEqual([]);
    useDocumentStore.getState().undo();
    expect(currentTimelineState().activeVisualClipIds).toEqual(['clip']);
    useDocumentStore.getState().redo();
    expect(currentTimelineState().activeVisualClipIds).toEqual([]);
    useDocumentStore.getState().undo();

    useDocumentStore.getState().execute(removeContentCommand('item', [{ kind: 'cue', id: 'obs' }]));
    expect(currentTimelineState().activeObsCueIds).toEqual([]);
    useDocumentStore.getState().undo();
    expect(currentTimelineState().activeObsCueIds).toEqual(['obs']);
    useDocumentStore.getState().redo();
    expect(currentTimelineState().activeObsCueIds).toEqual([]);
  });
});

function currentTimelineState() {
  const project = useDocumentStore.getState().project;
  if (!project) throw new Error('测试工程不存在');
  const item = project.rundown.find((candidate) => candidate.id === 'item');
  if (!item) throw new Error('测试节目不存在');
  return resolveTimelineState(project, item, 1_000);
}
