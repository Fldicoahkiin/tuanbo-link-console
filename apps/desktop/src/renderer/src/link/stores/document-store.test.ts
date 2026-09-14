import { beforeEach, describe, expect, it } from 'vitest';
import {
  addCueCommand,
  addMediaAssetCommand,
  addReferenceMediaClipCommand,
  addRundownItemCommand,
  removeCueCommand,
  removeReferenceMediaClipCommand,
  renameProjectCommand,
  resolveTimelineState
} from '@tb/core/link';
import { createEmptyLinkProject } from '@tb/schema';
import { useDocumentStore } from './document-store';

beforeEach(() => {
  useDocumentStore.getState().setProject(createEmptyLinkProject('初始工程'), null);
});

describe('document store command history', () => {
  it('旧工程以 OBS 场景作为打开基线，编辑撤销不会恢复软件编排模式', () => {
    const project = createEmptyLinkProject('旧画面工程'); project.obsOutputMode = 'managed';
    const store = useDocumentStore.getState(); store.setProject(project, 'C:\\shows\\legacy.tblink');
    expect(project.obsOutputMode).toBe('managed');
    expect(useDocumentStore.getState().project?.obsOutputMode).toBe('scenes');
    expect(useDocumentStore.getState().dirty).toBe(true);
    store.execute(renameProjectCommand('新名称')); store.undo();
    expect(useDocumentStore.getState().project).toMatchObject({ name: '旧画面工程', obsOutputMode: 'scenes' });
  });
  it('已有图层的未分配 Cue 在打开时整理，后续添加与归属只有一步撤销', () => {
    const project = createEmptyLinkProject('已有图层');
    project.obsOutputMode = 'scenes';
    const cue = { id: 'cue', name: '打点', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 }, enabled: true, notes: '', actions: [] };
    project.rundown.push({ id: 'song', title: '节目', enabled: true, notes: '', referenceMediaClips: [], cues: [cue], visualLayers: [{ id: 'timeline-layer-cue', name: '用户图层', visible: true, locked: false }] });
    const store = useDocumentStore.getState();
    store.setProject(project, null);
    const prepared = useDocumentStore.getState().project!.rundown[0]!;
    expect(prepared.cues[0]!.layerId).toBeDefined();
    expect(prepared.cues[0]!.layerId).not.toBe('timeline-layer-cue');
    expect(new Set(prepared.visualLayers.map((layer) => layer.id)).size).toBe(2);
    expect(useDocumentStore.getState().past).toHaveLength(0);
    expect(useDocumentStore.getState().dirty).toBe(true);
    expect(project.rundown[0]!.cues[0]!.layerId).toBeUndefined();
    store.execute(addCueCommand('song', { ...cue, id: 'added' }));
    const addedLayer = useDocumentStore.getState().project!.rundown[0]!.cues[1]!.layerId;
    expect(addedLayer).toBeDefined();
    expect(useDocumentStore.getState().past).toHaveLength(1);
    store.undo();
    expect(useDocumentStore.getState().project!.rundown[0]).toEqual(prepared);
    store.redo();
    expect(useDocumentStore.getState().project!.rundown[0]!.cues[1]!.layerId).toBe(addedLayer);
  });
  it('旧工程图层在历史之前准备，首个编辑可直接撤销且不改原输入', () => {
    const project = createEmptyLinkProject('旧工程');
    project.rundown.push({ id: 'legacy', title: '节目', enabled: true, notes: '', visualLayers: [], cues: [], referenceMediaClips: [] });
    const store = useDocumentStore.getState();
    store.setProject(project, 'C:\\shows\\legacy.tblink');
    const initialLayers = structuredClone(useDocumentStore.getState().project!.rundown[0]!.visualLayers);
    expect(initialLayers).toHaveLength(2);
    expect(project.rundown[0]!.visualLayers).toHaveLength(0);
    expect(useDocumentStore.getState().past).toHaveLength(0);
    expect(useDocumentStore.getState().dirty).toBe(true);
    store.execute(renameProjectCommand('改名'));
    store.undo();
    expect(useDocumentStore.getState().project!.name).toBe('旧工程');
    expect(useDocumentStore.getState().project!.rundown[0]!.visualLayers).toEqual(initialLayers);
    expect(useDocumentStore.getState().past).toHaveLength(0);
  });
  it('新节目与图层只有一个撤销步骤，重做保留图层身份', () => {
    const store = useDocumentStore.getState();
    store.execute(addRundownItemCommand({ id: 'new', title: '节目', enabled: true, notes: '', visualLayers: [], cues: [], referenceMediaClips: [] }));
    const layers = structuredClone(useDocumentStore.getState().project!.rundown[0]!.visualLayers);
    expect(layers).toHaveLength(2);
    expect(useDocumentStore.getState().past).toHaveLength(1);
    store.undo();
    expect(useDocumentStore.getState().project!.rundown).toHaveLength(0);
    store.redo();
    expect(useDocumentStore.getState().project!.rundown[0]!.visualLayers).toEqual(layers);
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
    const savingRevision = useDocumentStore.getState().revision;
    store.execute(renameProjectCommand('第二名称'));
    useDocumentStore.getState().markSaved('C:\\shows\\test.tblink', savingRevision);

    expect(useDocumentStore.getState()).toMatchObject({ path: 'C:\\shows\\test.tblink', dirty: true });
    useDocumentStore.getState().markSaved(undefined, useDocumentStore.getState().revision);
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it('每次打开文档生成新会话标识，编辑和保存路径变化不更换标识', () => {
    const initialDocumentId = useDocumentStore.getState().documentId;
    useDocumentStore.getState().execute(renameProjectCommand('编辑后'));
    useDocumentStore.getState().markSaved('C:\\shows\\copy.tblink');
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

    useDocumentStore.getState().markSaved('C:\\shows\\old.tblink', 0, oldDocumentId);
    expect(useDocumentStore.getState()).toMatchObject({
      project: { name: '后来打开的工程' },
      path: 'C:\\shows\\new.tblink'
    });
    expect(() => useDocumentStore.getState().executeForDocument(oldDocumentId, renameProjectCommand('错误覆盖')))
      .toThrow('当前工程已切换');
    expect(useDocumentStore.getState().project?.name).toBe('后来打开的工程');
  });

  it('删除当前有效视频和 OBS Cue 后解析状态立即同步，undo/redo 完整恢复和移除', () => {
    const store = useDocumentStore.getState();
    store.execute(addRundownItemCommand({
      id: 'item', title: '节目', enabled: true, notes: '',
      visualLayers: [
        { id: 'top', name: '顶部', visible: true, locked: false },
        { id: 'bottom', name: '底部', visible: true, locked: false }
      ],
      referenceMediaClips: [], cues: []
    }));
    store.execute(addMediaAssetCommand({
      id: 'video', name: '视频', kind: 'video', folderId: null,
      relativePath: 'assets/reference-media/video.mp4', sha256: 'a'.repeat(64), byteLength: 10,
      durationMs: 10_000, width: 1080, height: 1920
    }));
    store.execute(addReferenceMediaClipCommand('item', {
      id: 'clip', assetId: 'video', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      sourceOffsetMs: 0, durationMs: 5_000, layerId: 'bottom',
      canvasTransform: { x: 0.5, y: 0.5, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 }
    }));
    store.execute(addCueCommand('item', {
      id: 'obs', name: '显示机位', timecode: { hours: 0, minutes: 0, seconds: 0, frames: 0 },
      durationMs: 5_000, enabled: true, notes: '', layerId: 'top', actions: [{
        id: 'show', label: '显示机位', kind: 'obs.setSceneItemEnabled', sceneName: '团播联动台输出', sourceName: 'Camera', enabled: true
      }]
    }));

    expect(currentTimelineState()).toMatchObject({ activeVisualClipIds: ['clip'], activeObsCueIds: ['obs'] });
    store.execute(removeReferenceMediaClipCommand('item', 'clip'));
    expect(currentTimelineState().activeVisualClipIds).toEqual([]);
    useDocumentStore.getState().undo();
    expect(currentTimelineState().activeVisualClipIds).toEqual(['clip']);
    useDocumentStore.getState().redo();
    expect(currentTimelineState().activeVisualClipIds).toEqual([]);
    useDocumentStore.getState().undo();

    useDocumentStore.getState().execute(removeCueCommand('item', 'obs'));
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
