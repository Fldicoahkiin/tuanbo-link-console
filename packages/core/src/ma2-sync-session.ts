import { ma2SyncSnapshotSchema, type Ma2SyncSnapshot } from '@tb/schema';
import { resolveMa2Sync, sameMa2Content, type Ma2SyncChoice, type Ma2SyncPreview } from './ma2-sync';
import { holdForShow, type ShowGateReader } from './show-state';

// A real adapter must validate these guarantees against the target console version.
// No production adapter is enabled until the MA2 protocol acceptance gate passes.
export type Ma2SyncPort = {
  read(bindingId: string): Promise<unknown>;
  backup(snapshot: Ma2SyncSnapshot): Promise<{ backupId: string; revision: string }>;
  apply(snapshot: Ma2SyncSnapshot, expectedRevision: string): Promise<void>;
};

export type Ma2SyncResult =
  | { status: 'verified'; baseline: Ma2SyncSnapshot; backupId: string | null }
  | { status: 'incomplete'; stage: 'preflight' | 'read' | 'backup' | 'write' | 'verify'; message: string; backupId: string | null; mayHaveWritten: boolean };

export class Ma2SyncSession {
  private busy = false;

  get isBusy(): boolean { return this.busy; }

  /** `show`: paused, ended and P1 waiting sync; a moving program waits (2026-11-10 第 3 题). */
  constructor(private readonly port: Ma2SyncPort, private readonly show: ShowGateReader) {}

  async apply(preview: Ma2SyncPreview, choices: ReadonlyMap<string, Ma2SyncChoice>): Promise<Ma2SyncResult> {
    if (this.busy) return { status: 'incomplete', stage: 'preflight', message: '已有同步正在进行', backupId: null, mayHaveWritten: false };
    this.busy = true;
    let stage: 'preflight' | 'read' | 'backup' | 'write' | 'verify' = 'preflight';
    let backupId: string | null = null;
    let mayHaveWritten = false;
    try {
      this.requireStopped();
      const desired = resolveMa2Sync(preview, choices);
      const expectedRemote = ma2SyncSnapshotSchema.parse(preview.remote);
      stage = 'read';
      const current = ma2SyncSnapshotSchema.parse(await this.port.read(desired.bindingId));
      if (current.revision !== expectedRemote.revision || !sameMa2Content(current, expectedRemote)) {
        throw new Error('预览之后控台数据有变化，请重新读取差异');
      }
      if (sameMa2Content(current, desired)) return { status: 'verified', baseline: current, backupId: null };
      this.requireStopped();
      stage = 'backup';
      const backup = await this.port.backup(current);
      if (!backup.backupId.trim() || backup.revision !== current.revision) throw new Error('控台备份与当前版本不一致');
      backupId = backup.backupId;
      this.requireStopped();
      stage = 'write';
      mayHaveWritten = true;
      await this.port.apply(desired, current.revision);
      stage = 'verify';
      const verified = ma2SyncSnapshotSchema.parse(await this.port.read(desired.bindingId));
      if (!sameMa2Content(desired, verified)) throw new Error('控台读回的内容和要写入的不一致，同步没有完成');
      return { status: 'verified', baseline: verified, backupId };
    } catch (error) {
      return { status: 'incomplete', stage, message: error instanceof Error ? error.message : String(error), backupId, mayHaveWritten };
    } finally {
      this.busy = false;
    }
  }

  private requireStopped(): void {
    holdForShow(this.show, 'ma2.sync.write');
  }
}
