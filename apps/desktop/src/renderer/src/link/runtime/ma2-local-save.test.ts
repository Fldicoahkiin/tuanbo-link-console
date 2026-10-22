import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createEmptyLinkProject, createLightingDocument } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { savePendingMa2Edits, useMa2LocalSaveStore } from './ma2-local-save';
const { save, log } = vi.hoisted(() => ({ save: vi.fn(), log: vi.fn() }));
vi.mock('../view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { saveProject: save, recordLog: log } }));
function load() {
  const project = createEmptyLinkProject('本地待同步');
  project.schemaVersion = 2;
  project.rundown = [{ id: 'song', title: '歌曲', enabled: true, notes: '', cues: [], visualLayers: [], referenceMediaClips: [], lighting: createLightingDocument() }];
  useDocumentStore.getState().setProject(project, 'C:/song.tblink');
  useDocumentStore.setState({ dirty: true, revision: 1, stateId: 'edit-1' });
}
beforeEach(() => {
  vi.clearAllMocks(); save.mockResolvedValue('C:/song.tblink'); log.mockResolvedValue(undefined);
  vi.stubGlobal('window', { tbLink: {} });
  useMa2LocalSaveStore.setState({ saving: false, error: null }); load();
});
afterEach(() => vi.unstubAllGlobals());
it('无需控台连接即可保存待同步修改', async () => {
  await savePendingMa2Edits();
  expect(save).toHaveBeenCalledOnce(); expect(useDocumentStore.getState().dirty).toBe(false);
});
it('保存期间仍可编辑；旧保存完成不清除新修改，也不并行写文件', async () => {
  let finish: (path: string) => void = () => { throw new Error('save not started'); };
  save.mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve; }));
  const pending = savePendingMa2Edits();
  useDocumentStore.setState({ revision: 2, dirty: true, stateId: 'edit-2' });
  await savePendingMa2Edits(); expect(save).toHaveBeenCalledOnce();
  finish('C:/song.tblink'); await pending;
  expect(useDocumentStore.getState().dirty).toBe(true);
  await savePendingMa2Edits(); expect(useDocumentStore.getState().dirty).toBe(false);
});
it('磁盘写入失败不假报保存、不反复写同一版本，新编辑仍可继续保存', async () => {
  save.mockRejectedValueOnce(new Error('磁盘不可写'));
  await savePendingMa2Edits(); await savePendingMa2Edits();
  expect(save).toHaveBeenCalledOnce(); expect(useDocumentStore.getState().dirty).toBe(true);
  expect(useMa2LocalSaveStore.getState().error).toContain('磁盘不可写');
  useDocumentStore.setState({ revision: 2 }); await savePendingMa2Edits();
  expect(useMa2LocalSaveStore.getState().error).toBeNull();
});
