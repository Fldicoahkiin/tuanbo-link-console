import { useEffect } from 'react';
import { create } from 'zustand';
import type { LinkProject, RecoveryCopyDiscard, RecoveryCopyWrite } from '@tb/schema';
import { useDocumentStore, type DocumentStoreState } from './stores/document-store';
import { projectCodec } from './stores/project-codec';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { reportCoordinatorError } from './runtime/runtime-action-log';

export const useRecoveryCopyStore = create<{ writing: boolean; error: string | null }>(() => ({ writing: false, error: null }));

type Owner = { projectPath: string | null; projectId: string; sessionId: string };
export type RecoveryCopyDependencies = {
  encode(project: LinkProject): Promise<string>;
  write(payload: RecoveryCopyWrite): Promise<void>;
  discard(payload: RecoveryCopyDiscard): Promise<boolean>;
  report(message: string): void;
};

const ownerKey = (owner: Owner): string => `${owner.sessionId}\u0000${owner.projectPath ?? ''}\u0000${owner.projectId}`;

/**
 * The only automatic writer: unsaved edits go to a recovery copy, never to the
 * project file. A save, or undo back to the saved state, removes the copies this
 * document session wrote.
 */
export class RecoveryCopyWriter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince: number | null = null;
  private chain: Promise<void> = Promise.resolve();
  private lastWritten = '';
  private failed = '';
  private readonly written = new Map<string, Owner>();

  constructor(private readonly dependencies: RecoveryCopyDependencies, private readonly idleMs = 1000, private readonly maxDelayMs = 5000) {}

  start(): () => void {
    const unsubscribe = useDocumentStore.subscribe((state, previous) => this.changed(state, previous));
    return () => { unsubscribe(); this.cancel(); };
  }

  /** Writes the current unsaved content now, e.g. before the window reloads. */
  flush(): Promise<void> {
    this.cancel();
    return this.enqueue(() => this.write());
  }

  private changed(state: DocumentStoreState, previous: DocumentStoreState): void {
    if (state.sessionId !== previous.sessionId) {
      // Another document: its copies, if any, stay until that document is saved or discarded.
      this.cancel(); this.written.clear(); this.lastWritten = ''; this.failed = '';
      return;
    }
    if (previous.dirty && !state.dirty) { this.cancel(); void this.enqueue(() => this.cleanUp()); return; }
    if (state.dirty && state.revision > 0 && (state.stateId !== previous.stateId || state.path !== previous.path)) this.schedule();
  }

  private schedule(): void {
    const now = Date.now();
    this.pendingSince ??= now;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(this.idleMs, this.pendingSince + this.maxDelayMs - now));
    this.timer = setTimeout(() => { this.timer = null; this.pendingSince = null; void this.enqueue(() => this.write()); }, delay);
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.pendingSince = null;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.chain = this.chain.then(operation);
    return this.chain;
  }

  private async write(): Promise<void> {
    const state = useDocumentStore.getState();
    if (!state.project || !state.dirty || state.revision === 0) return;
    const owner: Owner = { projectPath: state.path, projectId: state.project.projectId, sessionId: state.sessionId };
    const version = `${ownerKey(owner)}\u0000${state.revision}`;
    if (version === this.lastWritten || version === this.failed) return;
    useRecoveryCopyStore.setState({ writing: true });
    try {
      const content = await this.dependencies.encode(state.project);
      await this.dependencies.write({ version: 1, projectPath: owner.projectPath, projectId: owner.projectId, name: state.project.name,
        sessionId: owner.sessionId, revision: state.revision, content });
      // After Save As the copy kept under the previous owner is out of date.
      for (const [key, stale] of this.written) {
        if (key === ownerKey(owner)) continue;
        await this.dependencies.discard({ version: 1, projectPath: stale.projectPath, projectId: stale.projectId });
        this.written.delete(key);
      }
      this.written.set(ownerKey(owner), owner);
      this.lastWritten = version; this.failed = '';
      useRecoveryCopyStore.setState({ error: null });
    } catch (cause) {
      this.failed = version;
      const message = `恢复副本写入失败，未保存的修改目前只在内存中：${cause instanceof Error ? cause.message : String(cause)}`;
      useRecoveryCopyStore.setState({ error: message });
      this.dependencies.report(message);
    } finally {
      useRecoveryCopyStore.setState({ writing: false });
    }
  }

  private async cleanUp(): Promise<void> {
    const state = useDocumentStore.getState();
    if (state.dirty || !state.project) return;
    const current: Owner = { projectPath: state.path, projectId: state.project.projectId, sessionId: state.sessionId };
    // The current owner may hold a copy from an earlier session that was restored and is now saved.
    const owners = new Map(this.written); owners.set(ownerKey(current), current);
    try {
      for (const [key, owner] of owners) {
        await this.dependencies.discard({ version: 1, projectPath: owner.projectPath, projectId: owner.projectId, keep: { sessionId: state.sessionId, revision: state.revision } });
        this.written.delete(key);
      }
      this.lastWritten = '';
    } catch (cause) {
      const message = `恢复副本清理失败，下次打开时可能再次提示恢复：${cause instanceof Error ? cause.message : String(cause)}`;
      useRecoveryCopyStore.setState({ error: message });
      this.dependencies.report(message);
    }
  }
}

let activeWriter: RecoveryCopyWriter | null = null;

/** Writes the current unsaved content to its recovery copy immediately. */
export async function flushRecoveryCopy(): Promise<void> {
  if (!activeWriter) throw new Error('恢复副本写入尚未启动');
  await activeWriter.flush();
  const error = useRecoveryCopyStore.getState().error;
  if (error) throw new Error(error);
}

export function useRecoveryCopyWriter(): void {
  useEffect(() => {
    const writer = new RecoveryCopyWriter({
      encode: project => projectCodec.encode(project),
      write: payload => linkDesktopViewModel.writeRecoveryCopy(payload),
      discard: payload => linkDesktopViewModel.discardRecoveryCopy(payload),
      report: message => reportCoordinatorError(message, reason => useRecoveryCopyStore.setState({ error: reason }))
    });
    activeWriter = writer;
    const stop = writer.start();
    return () => { stop(); if (activeWriter === writer) activeWriter = null; };
  }, []);
}
