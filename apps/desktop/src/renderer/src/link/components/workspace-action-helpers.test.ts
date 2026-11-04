import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { addMediaAssetCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {
  importMediaAsset: vi.fn(), importReferenceAudio: vi.fn(), prepareObsMediaScenes: vi.fn(), readObsInventory: vi.fn()
}, linkFileViewModel: { getPathForFile: (file: File) => file.name } }));

import { actionsFromObsResource, importWorkspaceMedia } from './workspace-action-helpers';

describe('workspace action helpers', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('新视频原声就绪后才加入可拖动素材库，不把提取等待留到拖入时间线', async () => {
    useDocumentStore.getState().setProject(createEmptyLinkProject('先准备'), 'C:/test/ready.tblink');
    const asset = { id: 'ready', name: 'ready.mp4', kind: 'video' as const, folderId: null, relativePath: 'ready.mp4', sha256: 'a'.repeat(64), byteLength: 10, durationMs: 1000, width: 640, height: 360 };
    vi.spyOn(linkDesktopViewModel, 'importMediaAsset').mockResolvedValueOnce(asset);
    let finish: (() => void) | undefined;
    vi.spyOn(linkDesktopViewModel, 'importReferenceAudio').mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ assetId: 'sound', relativePath: 'sound.wav', sha256: 'b'.repeat(64), durationMs: 1000 });
    }));
    const state = useDocumentStore.getState(); const notify = vi.fn();
    const operation = importWorkspaceMedia({ projectPath: state.path!, files: [new File([], 'ready.mp4')], folderId: null,
      documentId: state.documentId, execute: state.execute, addAsset: addMediaAssetCommand, onImported: vi.fn(), notify });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(useDocumentStore.getState().project!.mediaAssets).toHaveLength(0);
    finish!(); await operation;
    expect(notify.mock.calls.filter(([, tone]) => tone === 'error')).toEqual([]);
    expect(useDocumentStore.getState().project!.mediaAssets).toHaveLength(1);
    useDocumentStore.getState().undo(); expect(useDocumentStore.getState().project!.mediaAssets).toHaveLength(0);
  });
  it('批量导入只准备各自的新素材，原声提前提取，不重复准备已有素材库', async () => {
    const asset = { id: 'old', name: 'old.mp4', kind: 'video' as const, folderId: null, relativePath: 'old.mp4', sha256: 'a'.repeat(64), byteLength: 10, durationMs: 1000, width: 640, height: 360 };
    useDocumentStore.getState().setProject(parseLinkProject({ ...createEmptyLinkProject('导入'), mediaAssets: [asset] }), 'C:/test/show.tblink');
    useIntegrationStore.getState().setObs({ status: 'connected', obsVersion: null, webSocketVersion: null, error: null });
    vi.spyOn(linkDesktopViewModel, 'importMediaAsset').mockResolvedValueOnce({ ...asset, id: 'new1', sha256: 'b'.repeat(64), relativePath: 'new1.mp4' })
      .mockResolvedValueOnce({ ...asset, id: 'new2', sha256: 'c'.repeat(64), relativePath: 'new2.mp4' });
    const imported = vi.spyOn(linkDesktopViewModel, 'importReferenceAudio').mockResolvedValue({ assetId: 'sound', relativePath: 'sound.wav', sha256: 'b'.repeat(64), durationMs: 1000 });
    const prepared = vi.spyOn(linkDesktopViewModel, 'prepareObsMediaScenes').mockResolvedValue();
    const state = useDocumentStore.getState(); const notify = vi.fn();
    await importWorkspaceMedia({ projectPath: state.path!, files: [new File([], 'one.mp4'), new File([], 'two.mp4')], folderId: null,
      documentId: state.documentId, execute: state.execute, addAsset: addMediaAssetCommand, onImported: vi.fn(), notify });
    const calls = prepared.mock.calls;
    expect(notify.mock.calls.filter(([, tone]) => tone === 'error')).toEqual([]);
    expect(calls.map(([, project]) => project.mediaAssets.map(value => value.id))).toEqual([['new1'], ['new2']]);
    for (const [, project] of calls) expect(() => parseLinkProject(project)).not.toThrow();
    expect(imported).toHaveBeenCalledTimes(2);
    useIntegrationStore.getState().setObs({ status: 'disconnected', obsVersion: null, webSocketVersion: null, error: null });
  });
  it('资源库里的 OBS 场景生成一个切换场景动作', () => {
    expect(actionsFromObsResource({ id: 'scene:机位一', kind: 'scene', name: '机位一' })).toMatchObject([{ kind: 'obs.setProgramScene', sceneName: '机位一' }]);
  });
});
