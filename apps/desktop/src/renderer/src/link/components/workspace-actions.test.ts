import { describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { materialSceneNames } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { createWorkspaceActions } from './workspace-actions';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {}, linkFileViewModel: {} }));

function fixture(locked = false, withCue = false, withClip = false) {
  const project = parseLinkProject({ ...createEmptyLinkProject('素材场景'), obsOutputMode: 'scenes',
    mediaAssets: [{ id: 'video', name: '片段.mp4', kind: 'video', relativePath: 'assets/video.mp4', sha256: 'a'.repeat(64), byteLength: 10, durationMs: 12000, width: 1080, height: 1920 }],
    rundown: [{ id: 'song', title: '节目', referenceMediaClips: withClip ? [{ id: 'clip', assetId: 'video', label: '视频', startTimecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, durationMs: 2000, layerId: 'layer' }] : [], cues: withCue ? [{ id: 'cue', name: '机位', timecode: { hours: 0, minutes: 0, seconds: 1, frames: 0 }, durationMs: 2000, layerId: 'layer', actions: [{id: 'action', label: '场景', kind: 'obs.setProgramScene', sceneName: 'Camera'}] }] : [], visualLayers: [{ id: 'layer', name: '画面', visible: true, locked }] }]
  });
  useDocumentStore.getState().setProject(project, null);
  const notify = vi.fn();
  const actions = createWorkspaceActions({ project, projectPath: null, documentId: 0, item: project.rundown[0]!, cue: null,
    playheadMs: 3000, coordinator: null, execute: useDocumentStore.getState().execute, notify,
    setSelectedCueId: vi.fn(), setSelectedClipId: vi.fn(), setSelectedAssetId: vi.fn(), setSelectedObsResource: vi.fn() });
  return { actions, notify, sceneName: materialSceneNames(project.projectId, project.mediaAssets[0]!).sceneName };
}

describe('拖入 OBS 场景', () => {
  it('视频下拖新建轨道保留片段属性并一次撤销', () => {
    const { actions } = fixture(false, false, true);
    const before = useDocumentStore.getState().project;
    actions.moveClip('clip', 6000, null);
    const item = useDocumentStore.getState().project!.rundown[0]!;
    expect(item.visualLayers).toHaveLength(2);
    expect(item.referenceMediaClips[0]).toMatchObject({ id: 'clip', durationMs: 2000, layerId: item.visualLayers[1]!.id, startTimecode: { seconds: 6 } });
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project).toEqual(before);
  });
  it('底部新建素材轨道与内容一次撤销、重做', () => {
    const { actions } = fixture();
    const before = useDocumentStore.getState().project;
    expect(actions.addAssetClip('video', 4000, null)).toBe(true);
    const item = useDocumentStore.getState().project!.rundown[0]!;
    expect(item.visualLayers).toHaveLength(2);
    expect(item.referenceMediaClips[0]).toMatchObject({ layerId: item.visualLayers[1]!.id, startTimecode: { seconds: 4 } });
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project).toEqual(before);
    useDocumentStore.getState().redo();
    expect(useDocumentStore.getState().project!.rundown[0]).toEqual(item);
  });
  it('场景下拖新建底部轨道，取消操作可一次撤销', () => {
    const { actions } = fixture(false, true);
    const before = useDocumentStore.getState().project;
    actions.moveCue('cue', 4000, null);
    const item = useDocumentStore.getState().project!.rundown[0]!;
    expect(item.visualLayers).toHaveLength(2);
    expect(item.cues[0]).toMatchObject({ layerId: item.visualLayers[1]!.id, timecode: { seconds: 4 } });
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project).toEqual(before);
  });
  it('锁定内容不能通过下拖新建轨道', () => {
    const { actions, notify } = fixture(true, true);
    const before = useDocumentStore.getState().project;
    actions.moveCue('cue', 4000, null);
    expect(useDocumentStore.getState().project).toEqual(before);
    expect(notify).toHaveBeenCalledWith('图层“画面”已锁定。', 'error');
  });
  it('当前工程素材场景创建媒体片段，保留时长和入点并支持撤销', () => {
    const { actions, sceneName } = fixture();
    expect(actions.addObsResource({ id: sceneName, kind: 'scene', group: '场景', name: sceneName, sceneName }, 3000, 'layer')).toBe(true);
    const item = useDocumentStore.getState().project!.rundown[0]!;
    expect(item.cues).toHaveLength(0);
    expect(item.referenceMediaClips).toEqual([expect.objectContaining({ assetId: 'video', sourceOffsetMs: 0, durationMs: 12000,
      layerId: 'layer', startTimecode: { hours: 0, minutes: 0, seconds: 3, frames: 0 } })]);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project!.rundown[0]!.referenceMediaClips).toHaveLength(0);
  });
  it('普通机位仍创建场景切换片段', () => {
    const { actions } = fixture();
    expect(actions.addObsResource({ id: 'camera', kind: 'scene', group: '场景', name: '机位一', sceneName: '机位一' }, 3000, 'layer')).toBe(true);
    const item = useDocumentStore.getState().project!.rundown[0]!;
    expect(item.referenceMediaClips).toHaveLength(0);
    expect(item.cues[0]).toMatchObject({ durationMs: 5000, actions: [{ kind: 'obs.setProgramScene', sceneName: '机位一' }] });
  });
  it('素材场景不能绕过轨道锁定', () => {
    const { actions, sceneName, notify } = fixture(true);
    expect(actions.addObsResource({ id: sceneName, kind: 'scene', group: '场景', name: sceneName, sceneName }, 3000, 'layer')).toBe(false);
    expect(notify).toHaveBeenCalledWith('图层“画面”已锁定。', 'error');
    expect(useDocumentStore.getState().project!.rundown[0]!.referenceMediaClips).toHaveLength(0);
  });
});


describe('时间线右键复制机位', () => {
  it('复制到指定时间，生成独立 Cue 和动作编号并可撤销', () => {
    const { actions } = fixture(false, true);
    actions.duplicateCue('cue', 5000);
    const cues = useDocumentStore.getState().project!.rundown[0]!.cues;
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ durationMs: 2000, timecode: { seconds: 5 }, actions: [{ sceneName: 'Camera' }] });
    expect(cues[1]!.id).not.toBe(cues[0]!.id);
    expect(cues[1]!.actions[0]!.id).not.toBe(cues[0]!.actions[0]!.id);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().project!.rundown[0]!.cues).toHaveLength(1);
  });
  it('锁定图层拒绝复制', () => {
    const { actions, notify } = fixture(true, true);
    actions.duplicateCue('cue', 5000);
    expect(useDocumentStore.getState().project!.rundown[0]!.cues).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith('图层“画面”已锁定。', 'error');
  });
});
