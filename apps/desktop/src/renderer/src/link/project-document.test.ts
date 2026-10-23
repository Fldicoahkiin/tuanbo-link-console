import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameProjectCommand } from '@tb/core/link';
import { createEmptyLinkProject } from '@tb/schema';
import { useDocumentStore } from './stores/document-store';
import { requireProjectLocation, requireSavedProjectPath, revertToSaved, saveDocument, saveDocumentWithRecovery } from './project-document';

const bridge = vi.hoisted(() => ({ saveProjectDocument: vi.fn(), confirmProjectLocation: vi.fn(), recordLog: vi.fn(), encode: vi.fn(), confirmRevertToSaved: vi.fn(), openProject: vi.fn(), discardRecoveryCopy: vi.fn(),
  workerState: vi.fn(), restartWorker: vi.fn(), codecFailure: vi.fn(), codecRestart: vi.fn() }));
vi.mock('./view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: { confirmProjectLocation: bridge.confirmProjectLocation, recordLog: bridge.recordLog,
  confirmRevertToSaved: bridge.confirmRevertToSaved, openProject: bridge.openProject, discardRecoveryCopy: bridge.discardRecoveryCopy,
  projectDocumentWorkerState: bridge.workerState, restartProjectDocumentWorker: bridge.restartWorker } }));
vi.mock('./stores/project-codec', () => ({ projectCodec: { encode: bridge.encode, failureReason: bridge.codecFailure, restart: bridge.codecRestart }, isWorkerValidatedProject: () => false }));

function open(path: string | null): void {
  const project = createEmptyLinkProject('保存测试'); project.obsOutputMode = 'scenes';
  useDocumentStore.getState().setProject(project, path);
}

beforeEach(() => {
  vi.stubGlobal('window', { tbLink: { saveProjectDocument: bridge.saveProjectDocument } });
  bridge.encode.mockImplementation((project: { name: string }) => Promise.resolve(JSON.stringify(project)));
  bridge.recordLog.mockResolvedValue(undefined);
  open('C:\\shows\\保存.tblink');
});
afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

describe('saveDocument', () => {
  it('保存当前内容到原路径并清除改动标记', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('已改'));
    bridge.saveProjectDocument.mockResolvedValue('C:\\shows\\保存.tblink');
    expect(await saveDocument()).toEqual({ status: 'saved', path: 'C:\\shows\\保存.tblink' });
    expect(bridge.saveProjectDocument).toHaveBeenCalledWith('C:\\shows\\保存.tblink', expect.stringContaining('已改'), {});
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it('保存期间继续编辑：只标记保存时的版本，新的修改仍算未保存', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('保存时'));
    let finish: (path: string) => void = () => { throw new Error('保存尚未开始'); };
    bridge.saveProjectDocument.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const saving = saveDocument();
    await vi.waitFor(() => expect(bridge.saveProjectDocument).toHaveBeenCalled());
    useDocumentStore.getState().execute(renameProjectCommand('保存后'));
    finish('C:\\shows\\保存.tblink');
    expect((await saving).status).toBe('saved');
    expect(useDocumentStore.getState().dirty).toBe(true);
    useDocumentStore.getState().undo();
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it('另存为总是询问位置，并以当前文件位置作为建议', async () => {
    bridge.saveProjectDocument.mockResolvedValue('D:\\备份\\保存 副本.tblink');
    expect(await saveDocument('save-as')).toEqual({ status: 'saved', path: 'D:\\备份\\保存 副本.tblink' });
    expect(bridge.saveProjectDocument).toHaveBeenCalledWith(null, expect.any(String), { defaultPath: 'C:\\shows\\保存.tblink' });
    expect(useDocumentStore.getState().path).toBe('D:\\备份\\保存 副本.tblink');
  });

  it('打开时升级过的工程：第一次保存到原文件时要求保留 .bak，之后不再要求；另存为不备份原文件', async () => {
    useDocumentStore.getState().setProject(createEmptyLinkProject('旧格式'), 'C:\\shows\\旧.tblink', { upgraded: true });
    bridge.saveProjectDocument.mockResolvedValue('C:\\shows\\旧.tblink');
    await saveDocument();
    expect(bridge.saveProjectDocument).toHaveBeenLastCalledWith('C:\\shows\\旧.tblink', expect.any(String), { backupOriginal: true });
    useDocumentStore.getState().execute(renameProjectCommand('再改'));
    await saveDocument();
    expect(bridge.saveProjectDocument).toHaveBeenLastCalledWith('C:\\shows\\旧.tblink', expect.any(String), {});
    useDocumentStore.getState().setProject(createEmptyLinkProject('旧格式'), 'C:\\shows\\旧.tblink', { upgraded: true });
    bridge.saveProjectDocument.mockResolvedValue('D:\\新.tblink');
    await saveDocument('save-as');
    expect(bridge.saveProjectDocument).toHaveBeenLastCalledWith(null, expect.any(String), { defaultPath: 'C:\\shows\\旧.tblink' });
    expect(useDocumentStore.getState().upgradeBackupPending).toBe(false);
  });

  it('取消保存对话框不改变工程状态', async () => {
    open(null); useDocumentStore.getState().execute(renameProjectCommand('未命名'));
    bridge.saveProjectDocument.mockResolvedValue(null);
    expect(await saveDocument()).toEqual({ status: 'canceled' });
    expect(useDocumentStore.getState()).toMatchObject({ path: null, dirty: true });
  });

  it('写盘失败返回原因，工程仍为未保存', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('失败'));
    bridge.saveProjectDocument.mockRejectedValue(new Error('磁盘已满'));
    expect(await saveDocument()).toEqual({ status: 'failed', message: '工程保存失败：磁盘已满' });
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('序列化失败也明确报出并写日志', async () => {
    bridge.encode.mockRejectedValue(new Error('工程处理超过 30 秒'));
    expect(await saveDocument()).toEqual({ status: 'failed', message: '工程保存失败：工程处理超过 30 秒' });
    expect(bridge.recordLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'error', message: '工程保存失败：工程处理超过 30 秒' }));
    expect(bridge.saveProjectDocument).not.toHaveBeenCalled();
  });

  it('保存期间切换到其他工程：结果不写到新工程上', async () => {
    let finish: (path: string) => void = () => { throw new Error('保存尚未开始'); };
    bridge.saveProjectDocument.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
    const saving = saveDocument();
    await vi.waitFor(() => expect(bridge.saveProjectDocument).toHaveBeenCalled());
    open('C:\\shows\\其他.tblink'); useDocumentStore.getState().execute(renameProjectCommand('其他'));
    finish('C:\\shows\\保存.tblink');
    expect(await saving).toEqual({ status: 'failed', message: '工程保存失败：保存期间已切换到其他工程，当前工程未保存' });
    expect(useDocumentStore.getState()).toMatchObject({ path: 'C:\\shows\\其他.tblink', dirty: true });
  });
});

describe('requireProjectLocation', () => {
  it('已有保存位置时直接返回，不保存也不询问', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('未保存修改'));
    expect(await requireProjectLocation('导入节目')).toBe('C:\\shows\\保存.tblink');
    expect(bridge.confirmProjectLocation).not.toHaveBeenCalled();
    expect(bridge.saveProjectDocument).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().dirty).toBe(true);
  });

  it('未命名工程询问一次，确认后另存并返回位置', async () => {
    open(null);
    bridge.confirmProjectLocation.mockResolvedValue(true);
    bridge.saveProjectDocument.mockResolvedValue('C:\\shows\\新工程.tblink');
    expect(await requireProjectLocation('导入节目')).toBe('C:\\shows\\新工程.tblink');
    expect(bridge.confirmProjectLocation).toHaveBeenCalledWith('导入节目');
    expect(useDocumentStore.getState().path).toBe('C:\\shows\\新工程.tblink');
  });

  it('选择取消或在保存框中取消时返回空，不执行操作', async () => {
    open(null);
    bridge.confirmProjectLocation.mockResolvedValueOnce(false);
    expect(await requireProjectLocation('导入节目')).toBeNull();
    expect(bridge.saveProjectDocument).not.toHaveBeenCalled();
    bridge.confirmProjectLocation.mockResolvedValueOnce(true);
    bridge.saveProjectDocument.mockResolvedValueOnce(null);
    expect(await requireProjectLocation('导入节目')).toBeNull();
  });

  it('后台任务不弹框：未命名工程直接报“工程未保存”', () => {
    open(null);
    expect(() => requireSavedProjectPath('同步控台')).toThrow('工程未保存：请先保存工程，再同步控台');
    open('C:\\shows\\a.tblink');
    expect(requireSavedProjectPath('同步控台')).toBe('C:\\shows\\a.tblink');
  });
});

describe('revertToSaved', () => {
  it('确认后重新打开磁盘上的工程文件，丢弃改动、撤销记录和恢复副本', async () => {
    const disk = createEmptyLinkProject('磁盘版本'); disk.obsOutputMode = 'scenes';
    useDocumentStore.getState().setProject(disk, 'C:\\shows\\恢复.tblink');
    useDocumentStore.getState().execute(renameProjectCommand('未保存修改'));
    useDocumentStore.getState().markConsoleSynced(useDocumentStore.getState().documentId);
    bridge.confirmRevertToSaved.mockResolvedValue(true);
    bridge.openProject.mockResolvedValue({ path: 'C:\\shows\\恢复.tblink', project: disk, upgraded: false });
    bridge.discardRecoveryCopy.mockResolvedValue(true);
    expect(await revertToSaved()).toBe('reverted');
    expect(bridge.confirmRevertToSaved).toHaveBeenCalledWith({ name: '未保存修改', consoleSynced: true });
    expect(useDocumentStore.getState()).toMatchObject({ dirty: false, project: { name: '磁盘版本' }, past: [] });
    expect(bridge.discardRecoveryCopy).toHaveBeenCalledWith({ version: 1, projectPath: 'C:\\shows\\恢复.tblink', projectId: disk.projectId });
  });

  it('取消时保留当前修改', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('保留'));
    bridge.confirmRevertToSaved.mockResolvedValue(false);
    expect(await revertToSaved()).toBe('cancelled');
    expect(useDocumentStore.getState()).toMatchObject({ dirty: true, project: { name: '保留' } });
    expect(bridge.openProject).not.toHaveBeenCalled();
  });

  it('未命名工程没有可恢复的版本', async () => {
    open(null);
    await expect(revertToSaved()).rejects.toThrow('没有可恢复的版本');
  });
});

describe('saveDocumentWithRecovery', () => {
  beforeEach(() => { bridge.codecFailure.mockReturnValue(null); bridge.workerState.mockResolvedValue({ stalled: null }); });

  it('普通失败不重试，也不询问重启', async () => {
    bridge.saveProjectDocument.mockRejectedValue(new Error('磁盘已满'));
    expect((await saveDocumentWithRecovery()).status).toBe('failed');
    expect(bridge.restartWorker).not.toHaveBeenCalled();
    expect(bridge.saveProjectDocument).toHaveBeenCalledOnce();
  });

  it('主进程工程处理超时：操作员确认重启后再保存一次', async () => {
    useDocumentStore.getState().execute(renameProjectCommand('重启后保存'));
    bridge.saveProjectDocument.mockRejectedValueOnce(new Error('工程处理超过 30 秒')).mockResolvedValueOnce('C:\\shows\\保存.tblink');
    bridge.workerState.mockResolvedValue({ stalled: '工程处理超过 30 秒' });
    bridge.restartWorker.mockResolvedValue(true);
    expect(await saveDocumentWithRecovery()).toEqual({ status: 'saved', path: 'C:\\shows\\保存.tblink' });
    expect(bridge.restartWorker).toHaveBeenCalledWith('工程处理超过 30 秒');
    expect(bridge.codecRestart).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().dirty).toBe(false);
  });

  it('界面端工程处理失效：确认后重启它再保存；拒绝则保留失败', async () => {
    bridge.encode.mockRejectedValueOnce(new Error('工程处理超过 30 秒；原文件未改变'));
    bridge.codecFailure.mockReturnValue('工程处理超过 30 秒；原文件未改变');
    bridge.restartWorker.mockResolvedValueOnce(false);
    expect((await saveDocumentWithRecovery()).status).toBe('failed');
    expect(bridge.codecRestart).not.toHaveBeenCalled();
    bridge.encode.mockRejectedValueOnce(new Error('工程处理超过 30 秒；原文件未改变'));
    bridge.restartWorker.mockResolvedValueOnce(true);
    bridge.saveProjectDocument.mockResolvedValue('C:\\shows\\保存.tblink');
    expect((await saveDocumentWithRecovery()).status).toBe('saved');
    expect(bridge.codecRestart).toHaveBeenCalledOnce();
  });
});
