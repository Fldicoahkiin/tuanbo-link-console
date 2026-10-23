import { describe, expect, it } from 'vitest';
import { RendererSaveRequests, UnsavedChangesGuard, unsavedChangesPrompt, type UnsavedChangesPrompt, type UnsavedDocumentState } from './unsaved-changes-guard';

type Answer = 'save' | 'discard' | 'cancel';
type SaveResult = Awaited<ReturnType<RendererSaveRequests['request']>>;

function guard(state: UnsavedDocumentState, answers: Answer[], saves: SaveResult[] = []) {
  const prompts: UnsavedChangesPrompt[] = []; const logs: string[] = []; let saveCalls = 0;
  const instance = new UnsavedChangesGuard({
    state: () => state,
    ask: prompt => { prompts.push(prompt); return Promise.resolve(answers.shift() ?? 'cancel'); },
    save: () => { saveCalls++; return Promise.resolve(saves.shift() ?? { status: 'saved' }); },
    log: message => { logs.push(message); }
  });
  return { instance, prompts, logs, saveCalls: () => saveCalls };
}
const dirty: UnsavedDocumentState = { dirty: true, consoleSynced: false, name: '演出' };

describe('UnsavedChangesGuard', () => {
  it('没有改动时不询问', async () => {
    const { instance, prompts } = guard({ ...dirty, dirty: false }, []);
    expect(await instance.resolve('quit')).toBe('clean');
    expect(prompts).toHaveLength(0);
  });

  it('取消：不保存、不继续', async () => {
    const { instance, saveCalls } = guard(dirty, ['cancel']);
    expect(await instance.resolve('open')).toBe('cancelled');
    expect(saveCalls()).toBe(0);
  });

  it('不保存：继续并报告已放弃', async () => {
    const { instance, logs } = guard(dirty, ['discard']);
    expect(await instance.resolve('quit')).toBe('discarded');
    expect(logs).toEqual([expect.stringContaining('不保存')]);
  });

  it('保存成功后继续', async () => {
    const { instance, saveCalls } = guard(dirty, ['save']);
    expect(await instance.resolve('new')).toBe('saved');
    expect(saveCalls()).toBe(1);
  });

  it('保存失败留在对话框里并显示原因，不继续；失败写日志', async () => {
    const { instance, prompts, logs } = guard(dirty, ['save', 'cancel'], [{ status: 'failed', message: '工程保存失败：磁盘已满' }]);
    expect(await instance.resolve('quit')).toBe('cancelled');
    expect(prompts.map(prompt => prompt.failure)).toEqual([null, '工程保存失败：磁盘已满']);
    expect(logs).toContainEqual(expect.stringContaining('磁盘已满'));
  });

  it('保存失败后仍可选择不保存', async () => {
    const { instance } = guard(dirty, ['save', 'discard'], [{ status: 'failed', message: '工程保存失败：只读' }]);
    expect(await instance.resolve('quit')).toBe('discarded');
  });

  it('在另存框中取消：回到询问，不当作失败', async () => {
    const { instance, prompts } = guard(dirty, ['save', 'save'], [{ status: 'canceled' }, { status: 'saved' }]);
    expect(await instance.resolve('quit')).toBe('saved');
    expect(prompts.map(prompt => prompt.failure)).toEqual([null, null]);
  });

  it('同一时间只显示一个询问，重复请求视为取消', async () => {
    let answer: (value: Answer) => void = () => { throw new Error('尚未询问'); };
    const instance = new UnsavedChangesGuard({ state: () => dirty, ask: () => new Promise<Answer>(resolve => { answer = resolve; }),
      save: () => Promise.resolve({ status: 'saved' as const }), log: () => undefined });
    const first = instance.resolve('quit');
    expect(await instance.resolve('quit')).toBe('cancelled');
    answer('discard');
    expect(await first).toBe('discarded');
    const next = instance.resolve('reload');
    answer('save');
    expect(await next).toBe('saved');
  });
});

describe('unsavedChangesPrompt', () => {
  it('三个按钮：保存 / 不保存 / 取消，Esc 为取消；已同步到控台时说明不会撤回', () => {
    const options = unsavedChangesPrompt({ ...dirty, consoleSynced: true, reason: 'quit', failure: '工程保存失败：磁盘已满' });
    expect(options).toMatchObject({ title: '工程尚未保存', buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2 });
    expect(options.message).toContain('演出');
    expect(options.detail).toContain('已同步到控台的改动不会撤回');
    expect(options.detail).toContain('磁盘已满');
    expect(unsavedChangesPrompt({ ...dirty, reason: 'open', failure: null }).detail).not.toContain('控台');
  });
});

describe('RendererSaveRequests', () => {
  it('把保存请求发给界面并等待回答；未知回答被忽略', async () => {
    const sent: number[] = [];
    const requests = new RendererSaveRequests(() => ({ send: id => { sent.push(id); } }));
    const pending = requests.request();
    requests.answer(999, { status: 'saved' });
    requests.answer(sent[0]!, { status: 'failed', message: '工程保存失败：只读' });
    expect(await pending).toEqual({ status: 'failed', message: '工程保存失败：只读' });
  });

  it('界面已退出时立即失败；在途请求在界面退出或无响应时失败', async () => {
    const closed = await new RendererSaveRequests(() => null).request();
    expect(closed.status === 'failed' && closed.message).toContain('界面已关闭');
    const requests = new RendererSaveRequests(() => ({ send: () => undefined }));
    const pending = requests.request();
    requests.failAll('界面无响应');
    expect(await pending).toEqual({ status: 'failed', message: '界面无响应' });
  });
});
