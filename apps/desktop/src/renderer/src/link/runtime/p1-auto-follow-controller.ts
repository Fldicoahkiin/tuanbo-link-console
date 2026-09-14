import { locateP1Sample, nominalFramesPerSecond, validateP1TimecodeRanges, type MtcSample } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

type Target = { itemId: string; sample: MtcSample; session: number };
type Dependencies = {
  prepare: (itemId: string, isCurrent: () => boolean) => Promise<void>;
  ingest: (sample: MtcSample) => Promise<void>;
  fail: (error: unknown) => void;
  interrupt: () => void;
};

export class P1AutoFollowController {
  private enabled = true;
  private pending: Target | null = null;
  private observed: Target | null = null;
  private activeSession = -1;
  private session = 0;
  private pumping = false;
  private disposed = false;
  private awaitingRestart = false;

  constructor(private readonly project: LinkProject, private readonly dependencies: Dependencies) {
    validateP1TimecodeRanges(project);
  }

  suspend(): void { this.enabled = false; this.pending = null; }
  enable(): void { this.enabled = true; this.observed = null; this.activeSession = -1; this.awaitingRestart = false; }
  dispose(): void { this.disposed = true; this.suspend(); }

  push(raw: MtcSample): void {
    if (!this.enabled || this.disposed) return;
    const located = locateP1Sample(this.project, raw);
    if (!located) {
      this.freeze(new Error('收到未映射的 P1 时间码或帧率不匹配。请在 P1 打开本工程生成的联动 .hia，并从歌曲开头播放。'));
      return;
    }
    const newStart = !this.observed || located.itemId !== this.observed.itemId
      || located.sample.totalFrames < this.observed.sample.totalFrames;
    if (this.awaitingRestart) {
      if (!newStart || located.sample.totalFrames > nominalFramesPerSecond(located.sample.frameRate) * 2) {
        this.observed = { ...located, session: this.session };
        return;
      }
      this.awaitingRestart = false;
    }
    if (newStart) {
      this.session += 1;
      this.dependencies.interrupt();
    }
    this.observed = { ...located, session: this.session };
    this.pending = this.observed;
    if (!this.pumping) void this.pump();
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (this.pending && this.enabled && !this.disposed) {
        const target = this.pending;
        this.pending = null;
        if (target.session !== this.activeSession) {
          if (target.sample.totalFrames > nominalFramesPerSecond(target.sample.frameRate) * 2) {
            throw new Error('请从 P1 歌曲开头播放以建立自动联动；不能把中途时间码当成歌曲开始');
          }
          const isCurrent = (): boolean => this.enabled && !this.disposed && this.observed?.session === target.session;
          try { await this.dependencies.prepare(target.itemId, isCurrent); }
          catch (error) { if (isCurrent()) throw error; else continue; }
          if (!this.enabled || this.disposed) break;
          if (this.observed?.session !== target.session) continue;
          this.activeSession = target.session;
          const latest = this.pending ?? target;
          this.pending = null;
          if (performance.now() - latest.sample.receivedAtMs > 500) throw new Error('准备期间 P1 已停止，请恢复监听后重新点击歌曲');
          this.deliver(latest);
        } else {
          this.deliver(target);
        }
      }
    } catch (error) {
      if (!this.disposed && this.enabled) this.freeze(error);
    } finally { this.pumping = false; }
  }

  private deliver(target: Target): void {
    // Clock ingestion must not wait for OBS to open/decode a media file.
    void this.dependencies.ingest(target.sample).catch((error: unknown) => {
      if (this.enabled && !this.disposed && target.session === this.observed?.session) {
        this.freeze(error);
      }
    });
  }

  private freeze(error: unknown): void {
    this.pending = null;
    if (this.awaitingRestart) return;
    this.awaitingRestart = true;
    this.dependencies.fail(error);
  }
}
