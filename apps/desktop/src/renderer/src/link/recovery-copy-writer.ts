import { useEffect } from 'react';
import { create } from 'zustand';
import type { LinkProject, RecoveryCopyDiscard, RecoveryCopyWrite } from '@tb/schema';
import { useDocumentStore, type DocumentStoreState } from './stores/document-store';
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

/**
 * `JSON.stringify(project)`, byte for byte, without copying the whole project
 * each time. Commands share what they did not change (shareProjectStructure),
 * so a song or a top-level part that kept its reference keeps its text and only
 * what changed is stringified again. The copy is checked when it is restored,
 * like any project file.
 */
export class ProjectJsonEncoder {
  private readonly texts = new WeakMap<object, string>();
  encode(project: LinkProject): string {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(project)) {
      const text = key === 'rundown' && Array.isArray(value) ? `[${value.map(item => this.text(item) ?? 'null').join(',')}]` : this.text(value);
      // JSON.stringify leaves out a field whose value has no JSON form (undefined).
      if (text !== undefined) fields.push(`${JSON.stringify(key)}:${text}`);
    }
    return `{${fields.join(',')}}`;
  }
  private text(value: unknown): string | undefined {
    if (typeof value !== 'object' || value === null) return JSON.stringify(value);
    const known = this.texts.get(value);
    if (known !== undefined) return known;
    const text = JSON.stringify(value);
    this.texts.set(value, text);
    return text;
  }
}

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
    if (previous.dirty && !state.dirty && state.project) {
      // Captured now: a document opened right after the save must not decide which copies go.
      // The current owner may hold a copy from an earlier session that was restored and is now saved.
      const current: Owner = { projectPath: state.path, projectId: state.project.projectId, sessionId: state.sessionId };
      const owners = new Map(this.written); owners.set(ownerKey(current), current);
      this.cancel(); void this.enqueue(() => this.cleanUp(owners, state.sessionId, state.revision));
      return;
    }
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
      // A document replaced meanwhile was saved or discarded by the operator: no copy for it.
      if (useDocumentStore.getState().sessionId !== owner.sessionId) return;
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
      const message = `恢复副本写入失败：${cause instanceof Error ? cause.message : String(cause)}。未保存的修改目前只在内存里，请尽快保存工程。`;
      useRecoveryCopyStore.setState({ error: message });
      this.dependencies.report(message);
    } finally {
      useRecoveryCopyStore.setState({ writing: false });
    }
  }

  private async cleanUp(owners: ReadonlyMap<string, Owner>, sessionId: string, revision: number): Promise<void> {
    try {
      for (const [key, owner] of owners) {
        await this.dependencies.discard({ version: 1, projectPath: owner.projectPath, projectId: owner.projectId, keep: { sessionId, revision } });
        this.written.delete(key);
      }
      this.lastWritten = '';
    } catch (cause) {
      const message = `清理恢复副本失败：${cause instanceof Error ? cause.message : String(cause)}。下次打开时可能还会提示恢复。`;
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
    const encoder = new ProjectJsonEncoder();
    const writer = new RecoveryCopyWriter({
      encode: project => Promise.resolve(encoder.encode(project)),
      write: payload => linkDesktopViewModel.writeRecoveryCopy(payload),
      discard: payload => linkDesktopViewModel.discardRecoveryCopy(payload),
      report: message => reportCoordinatorError(message, reason => useRecoveryCopyStore.setState({ error: reason }))
    });
    activeWriter = writer;
    const stop = writer.start();
    return () => { stop(); if (activeWriter === writer) activeWriter = null; };
  }, []);
}
