import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renameProjectCommand } from '@tb/core/link';
import { createEmptyLinkProject, type RecoveryCopyDiscard, type RecoveryCopyWrite } from '@tb/schema';
import { useDocumentStore } from './stores/document-store';
import { RecoveryCopyWriter, useRecoveryCopyStore } from './recovery-copy-writer';

vi.mock('./view-models/link-desktop-view-model', () => ({ linkDesktopViewModel: {} }));
vi.mock('./stores/project-codec', () => ({ projectCodec: {}, isWorkerValidatedProject: () => false }));

const writes: RecoveryCopyWrite[] = [];
const discards: RecoveryCopyDiscard[] = [];
const reports: string[] = [];
let failWrite: Error | null = null;
let stop: () => void = () => undefined;
let writer: RecoveryCopyWriter;

function open(path: string | null): void {
  const project = createEmptyLinkProject('恢复测试'); project.obsOutputMode = 'scenes';
  useDocumentStore.getState().setProject(project, path);
}
const rename = (name: string): void => useDocumentStore.getState().execute(renameProjectCommand(name));
const save = (path: string): void => { const { stateId, documentId } = useDocumentStore.getState(); useDocumentStore.getState().markSaved(path, stateId, documentId); };

beforeEach(() => {
  vi.useFakeTimers();
  writes.length = 0; discards.length = 0; reports.length = 0; failWrite = null;
  useRecoveryCopyStore.setState({ writing: false, error: null });
  open('C:\\shows\\恢复.tblink');
  writer = new RecoveryCopyWriter({
    encode: project => Promise.resolve(JSON.stringify(project)),
    write: payload => { if (failWrite) return Promise.reject(failWrite); writes.push(payload); return Promise.resolve(); },
    discard: payload => { discards.push(payload); return Promise.resolve(true); },
    report: message => { reports.push(message); }
  });
  stop = writer.start();
});
afterEach(() => { stop(); vi.useRealTimers(); });

describe('RecoveryCopyWriter', () => {
  it('编辑停顿 1 秒后写一份恢复副本，不写工程文件', async () => {
    rename('改名 1');
    await vi.advanceTimersByTimeAsync(900);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(writes).toHaveLength(1);
    const state = useDocumentStore.getState();
    expect(writes[0]).toMatchObject({ projectPath: 'C:\\shows\\恢复.tblink', projectId: state.project!.projectId, name: '改名 1', sessionId: state.sessionId, revision: state.revision });
    expect(JSON.parse(writes[0]!.content)).toMatchObject({ name: '改名 1' });
  });

  it('连续编辑最迟 5 秒写一次', async () => {
    for (let index = 0; index < 12; index++) { rename(`连续 ${index}`); await vi.advanceTimersByTimeAsync(500); }
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]!.name).not.toBe('连续 11');
  });

  it('没有编辑的新工程、刚打开的工程和刚恢复的内容不写副本', async () => {
    open(null);
    useDocumentStore.getState().setProject(createEmptyLinkProject('恢复的内容'), 'C:\\shows\\x.tblink', { restored: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(0);
    expect(discards).toHaveLength(0);
  });

  it('保存后清除本会话写过的副本，保留保存期间之后的编辑由服务端判断', async () => {
    rename('保存前'); await vi.advanceTimersByTimeAsync(1000);
    save('C:\\shows\\恢复.tblink'); await vi.advanceTimersByTimeAsync(0);
    const state = useDocumentStore.getState();
    expect(discards).toEqual([{ version: 1, projectPath: 'C:\\shows\\恢复.tblink', projectId: state.project!.projectId, keep: { sessionId: state.sessionId, revision: state.revision } }]);
  });

  it('撤销回到保存时的状态同样清除副本', async () => {
    save('C:\\shows\\恢复.tblink');
    rename('临时'); await vi.advanceTimersByTimeAsync(1000);
    useDocumentStore.getState().undo(); await vi.advanceTimersByTimeAsync(0);
    expect(useDocumentStore.getState().dirty).toBe(false);
    expect(discards).toHaveLength(1);
  });

  it('未命名工程另存后仍有新编辑：按新路径写副本，并清除未命名时的副本', async () => {
    open(null);
    rename('未命名编辑'); await vi.advanceTimersByTimeAsync(1000);
    expect(writes[0]!.projectPath).toBeNull();
    const savedState = useDocumentStore.getState().stateId;
    rename('保存期间编辑');
    useDocumentStore.getState().markSaved('C:\\shows\\新路径.tblink', savedState, useDocumentStore.getState().documentId);
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.at(-1)).toMatchObject({ projectPath: 'C:\\shows\\新路径.tblink', name: '保存期间编辑' });
    expect(discards).toEqual([{ version: 1, projectPath: null, projectId: writes[0]!.projectId }]);
  });

  it('写入失败明确报出并记录，不重复写同一版本；下一次编辑重新写入并清除错误', async () => {
    failWrite = new Error('磁盘已满');
    rename('失败'); await vi.advanceTimersByTimeAsync(1000);
    expect(useRecoveryCopyStore.getState().error).toContain('磁盘已满');
    expect(reports).toEqual([expect.stringContaining('恢复副本写入失败')]);
    await writer.flush();
    expect(reports).toHaveLength(1);
    failWrite = null;
    rename('恢复正常'); await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
    expect(useRecoveryCopyStore.getState().error).toBeNull();
  });

  it('切换工程不删除上一工程的副本，也不把旧工程写到新工程名下', async () => {
    rename('旧工程编辑');
    open('C:\\shows\\其他.tblink');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(writes).toHaveLength(0);
    expect(discards).toHaveLength(0);
  });

  it('flush 立即写入当前未保存内容', async () => {
    rename('立即');
    await writer.flush();
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toHaveLength(1);
  });
});
