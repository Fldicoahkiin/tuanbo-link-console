import { ma2NetworkStatusSchema, type LightingDocument, type Ma2NetworkTarget, type Ma2PlaybackAction } from '@tb/schema';
import type { LinkDesktopApi } from './link-desktop-contract';
import type { LightingReleaseSong, ProgramLightingOutput } from './program-player';

/** Scope Stop to the selected song: the executors its console timeline runs. No global Off, Master or
 * blackout command. This is the only lighting command a playing song sends besides timecode. */
export function lightingReleaseActions(document: LightingDocument): Ma2PlaybackAction[] {
  const actions: Ma2PlaybackAction[] = [];
  for (const binding of document.ma2Bindings ?? []) {
    for (const mapping of [...binding.mappings, ...binding.trackMappings ?? []]) actions.push({ target: 'executor', executor: mapping.executor, action: 'off' });
  }
  // The song's own console sequence keeps its last Cue on after the timecode stops.
  if (document.consoleSong?.executor) actions.push({ target: 'executor', executor: document.consoleSong.executor, action: 'off' });
  return [...new Map(actions.map(action => [JSON.stringify(action), action])).values()];
}

/** As long as an audition Off may wait: a sync job already on the wire finishes first. */
const releaseDeadlineMs = 7000;

/** A stop's Off that did not all go out: executors of `song`, the song the plan was prepared for, may still be on
 * (null for an editor preview, which names no song). The message is the reason. */
export class LightingReleaseFailure extends Error {
  constructor(readonly song: LightingReleaseSong | null, reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason), { cause: reason });
  }
}

export class LightingOutputRelease implements ProgramLightingOutput {
  /** Each knows its song: a song without lighting does not prepare, so the plan can be an earlier song's. */
  private plan: { song: LightingReleaseSong | null; network: Ma2NetworkTarget; actions: Ma2PlaybackAction[] } | null = null;
  private generation = 0;
  private unavailable: { song: LightingReleaseSong | null; reason: string } | null = null;
  constructor(private readonly api: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'playMa2Cue'>) {}
  /** `song`: the rundown song the Off is for, which a failure names. The program always passes it; an editor preview
   * (use-lighting-preview.ts) shows its own failure and passes none. */
  async prepare(document: LightingDocument, song: LightingReleaseSong | null = null): Promise<void> {
    const generation = ++this.generation; this.plan = null; this.unavailable = null;
    const actions = lightingReleaseActions(document);
    if (!actions.length) return;
    const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
    if (generation !== this.generation) return;
    if (status.state !== 'connected' || !status.settings) { this.unavailable = { song, reason: '时间码已停止；没有连接 MA2 网络，无法发送这个节目的执行器关闭指令' }; return; }
    const { host, port, monitorPort, username } = status.settings;
    this.plan = { song, network: { host, port, monitorPort, username }, actions };
  }
  cancelPreparation(): void { ++this.generation; }
  async release(): Promise<void> {
    ++this.generation;
    const plan = this.plan; this.plan = null;
    const unavailable = this.unavailable; this.unavailable = null;
    if (unavailable) throw new LightingReleaseFailure(unavailable.song, unavailable.reason);
    if (!plan) return;
    try {
      const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
      if (status.state !== 'connected' || !status.settings || Object.entries(plan.network).some(([key, value]) => Reflect.get(status.settings!, key) !== value)) throw new Error('关灯指令没有发送：控台连接变了');
      const sessionId = crypto.randomUUID(), deadlineAt = Date.now() + releaseDeadlineMs;
      // All Offs reach the console back to back, ahead of queued sync jobs; one failure never holds back the rest.
      const results = await Promise.allSettled(plan.actions.map(action => this.api.playMa2Cue({ network: plan.network, action, sessionId, deadlineAt })));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason));
    } catch (error) { throw new LightingReleaseFailure(plan.song, error); }
  }
}
