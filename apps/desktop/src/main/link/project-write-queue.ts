import { resolve } from 'node:path';
import type { LinkProject } from '@tb/schema';

type Waiter = { resolve: () => void; reject: (error: unknown) => void };
/** `backupOriginal` keeps the file as it was before this batch's first write over it. */
type Batch = { project: LinkProject; backupOriginal: boolean; waiters: Waiter[] };
type Queue = { path: string; pending: Batch | null; waiters: number };

/** One write in flight plus one latest pending revision per file. A merged caller
 * is acknowledged only after the newer revision really reaches disk. */
export class ProjectWriteQueue {
  private readonly queues = new Map<string, Queue>();
  constructor(private readonly write: (path: string, project: LinkProject, backupOriginal: boolean) => Promise<void>) {}

  enqueue(path: string, project: LinkProject, backupOriginal = false): Promise<void> {
    const absolute = resolve(path), key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    const active = this.queues.get(key);
    if ((active?.waiters ?? 0) >= 256 || (!active && this.queues.size >= 64)) return Promise.reject(new Error('工程保存队列已满，当前修改尚未保存'));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      if (active) {
        if (active.pending) { active.pending.project = project; active.pending.backupOriginal ||= backupOriginal; active.pending.waiters.push(waiter); }
        else active.pending = { project, backupOriginal, waiters: [waiter] };
        active.waiters++;
      } else {
        const queue: Queue = { path: absolute, pending: { project, backupOriginal, waiters: [waiter] }, waiters: 1 };
        this.queues.set(key, queue);
        void this.drain(key, queue);
      }
    });
  }

  private async drain(key: string, queue: Queue): Promise<void> {
    while (queue.pending) {
      const batch = queue.pending; queue.pending = null;
      try {
        await this.write(queue.path, batch.project, batch.backupOriginal);
        for (const waiter of batch.waiters) waiter.resolve();
      } catch (error) {
        for (const waiter of batch.waiters) waiter.reject(error);
      }
      queue.waiters -= batch.waiters.length;
    }
    this.queues.delete(key);
  }
}
