import { resolve } from 'node:path';
import type { LinkProject } from '@tb/schema';

/** `backupOriginal` keeps the file as it was before this batch's first write over it (an in-memory upgrade).
 * `replaceOlderFormat`: the operator agreed to save over a file that only older releases open (link-project-service). */
export type ProjectSaveOptions = { backupOriginal?: boolean; replaceOlderFormat?: boolean };
/** Resolves to the backup of an older-format file the write kept, or null. */
type Waiter = { resolve: (kept: string | null) => void; reject: (error: unknown) => void };
type Batch = { project: LinkProject; options: Required<ProjectSaveOptions>; waiters: Waiter[] };
type Queue = { path: string; pending: Batch | null; waiters: number };

/** One write in flight plus one latest pending revision per file. A merged caller
 * is acknowledged only after the newer revision really reaches disk. Merged saves keep either agreement. */
export class ProjectWriteQueue {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly write: (path: string, project: LinkProject, options: Required<ProjectSaveOptions>) => Promise<string | null>) {}

  enqueue(path: string, project: LinkProject, options: ProjectSaveOptions = {}): Promise<string | null> {
    const absolute = resolve(path), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const active = this.queues.get(key);
    if ((active?.waiters ?? 0) >= 256 || (!active && this.queues.size >= 64)) return Promise.reject(new Error('保存排队已满，当前修改还没保存'));
    const wanted = { backupOriginal: options.backupOriginal === true, replaceOlderFormat: options.replaceOlderFormat === true };
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (active) {
        if (active.pending) {
          active.pending.project = project;
          active.pending.options = { backupOriginal: active.pending.options.backupOriginal || wanted.backupOriginal, replaceOlderFormat: active.pending.options.replaceOlderFormat || wanted.replaceOlderFormat };
          active.pending.waiters.push(waiter);
        }
        else active.pending = { project, options: wanted, waiters: [waiter] };
        active.waiters++;
      } else {
        const queue: Queue = { path: absolute, pending: { project, options: wanted, waiters: [waiter] }, waiters: 1 };
        this.queues.set(key, queue);
        void this.drain(key, queue);
      }
    });
  }

  private async drain(key: string, queue: Queue): Promise<void> {
    while (queue.pending) {
      const batch = queue.pending; queue.pending = null;
      try {
        const kept = await this.write(queue.path, batch.project, batch.options);
        for (const waiter of batch.waiters) waiter.resolve(kept);
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
      }
      queue.waiters -= batch.waiters.length;
    }
    this.queues.delete(key);
  }
}
