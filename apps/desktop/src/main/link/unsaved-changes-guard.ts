import type { MessageBoxOptions } from 'electron';

export type UnsavedDocumentState = { dirty: boolean; consoleSynced: boolean; name: string | null };
/** What the operator is about to do when asked: it changes only the wording of the prompt. */
export type UnsavedChangesReason = 'quit' | 'open' | 'new' | 'reload' | 'update' | 'restore-archive';
export type UnsavedChangesPrompt = UnsavedDocumentState & { reason: UnsavedChangesReason; failure: string | null };
export type RendererSaveResult = { status: 'saved' } | { status: 'canceled' } | { status: 'failed'; message: string };
/** `clean`: nothing to save; `saved` / `discarded`: go ahead; `cancelled`: stay. */
export type UnsavedChangesDecision = 'clean' | 'saved' | 'discarded' | 'cancelled';

/**
 * The one question before any action that would drop the open document:
 * 保存 / 不保存 / 取消. A failed save stays in the question with its reason;
 * cancelling the Save As dialog asks again.
 */
export class UnsavedChangesGuard {
  private running = false;
  constructor(private readonly deps: {
    state(): UnsavedDocumentState;
    ask(prompt: UnsavedChangesPrompt): Promise<'save' | 'discard' | 'cancel'>;
    save(): Promise<RendererSaveResult>;
    /** info: the operator chose to discard; error: saving failed and the question stays open. */
    log(level: 'info' | 'error', message: string): void;
  }) {}

  async resolve(reason: UnsavedChangesReason): Promise<UnsavedChangesDecision> {
    // One question at a time; a second request while it is open does not go ahead.
    if (this.running) return 'cancelled';
    this.running = true;
    try { return await this.ask(reason); }
    finally { this.running = false; }
  }

  private async ask(reason: UnsavedChangesReason): Promise<UnsavedChangesDecision> {
    let failure: string | null = null;
    for (;;) {
      const state = this.deps.state();
      if (!state.dirty) return 'clean';
      const choice = await this.deps.ask({ ...state, reason, failure });
      if (choice === 'cancel') return 'cancelled';
      if (choice === 'discard') {
        this.deps.log('info', `未保存的修改：操作员选择不保存（${reasonLabel[reason]}）`);
        return 'discarded';
      }
      const result = await this.deps.save();
      if (result.status === 'saved') return 'saved';
      failure = result.status === 'failed' ? result.message : null;
      if (failure) this.deps.log('error', `未保存的修改：保存失败，仍在询问（${reasonLabel[reason]}）：${failure}`);
    }
  }
}

const reasonLabel: Record<UnsavedChangesReason, string> = {
  quit: '退出', open: '打开其他工程', new: '新建工程', reload: '刷新界面', update: '安装更新', 'restore-archive': '恢复存档'
};

export function unsavedChangesPrompt(prompt: UnsavedChangesPrompt): MessageBoxOptions {
  const detail = [
    `不保存会丢掉这些修改，然后${reasonLabel[prompt.reason]}。`,
    ...prompt.consoleSynced ? ['已同步到控台的改动不会撤回。'] : [],
    ...prompt.failure ? ['', `上次保存失败：${prompt.failure}`] : []
  ];
  return { type: 'warning', title: '工程还没保存', noLink: true, buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2,
    message: `是否保存对「${prompt.name ?? '未命名工程'}」的修改？`, detail: detail.join('\n') };
}

/** Saves run in the window that holds the document; the main process asks and waits for its answer. */
export class RendererSaveRequests {
  private sequence = 0;
  private readonly pending = new Map<number, (result: RendererSaveResult) => void>();
  constructor(private readonly window: () => { send(id: number): void } | null) {}

  request(): Promise<RendererSaveResult> {
    const target = this.window();
    if (!target) return Promise.resolve({ status: 'failed', message: '界面已关闭，无法保存。未保存的修改已存进恢复副本，下次打开工程时可以恢复' });
    const id = ++this.sequence;
    // No fixed time limit: the Save As dialog waits for the operator. A window
    // that exits or stops responding fails the request (failAll).
    const result = new Promise<RendererSaveResult>(resolve => this.pending.set(id, resolve));
    target.send(id);
    return result;
  }

  answer(id: number, result: RendererSaveResult): void {
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(result);
  }

  failAll(message: string): void {
    for (const resolve of this.pending.values()) resolve({ status: 'failed', message });
    this.pending.clear();
  }
}
