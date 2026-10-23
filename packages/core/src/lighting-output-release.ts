import { ma2NetworkStatusSchema, type LightingDocument, type Ma2NetworkTarget, type Ma2PlaybackAction } from '@tb/schema';
import type { LinkDesktopApi } from './link-desktop-contract';

/** Scope Stop to the selected song. No global Off, Master or blackout command. */
export function lightingReleaseActions(document: LightingDocument): Ma2PlaybackAction[] {
  if (document.outputMode === 'direct') return [];
  const actions: Ma2PlaybackAction[] = [];
  if (document.outputMode === 'timecode') {
    for (const binding of document.ma2Bindings ?? []) {
      for (const mapping of [...binding.mappings, ...binding.trackMappings ?? []]) actions.push({ target: 'executor', executor: mapping.executor, action: 'off' });
    }
    // The song's own console sequence keeps its last Cue on after the timecode stops.
    if (document.consoleSong?.executor) actions.push({ target: 'executor', executor: document.consoleSong.executor, action: 'off' });
  }
  else for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
    if (track.muted || document.tracks.some(value => value.solo && !value.muted) && !track.solo || clip.muted || event.kind !== 'ma2') continue;
    if (event.executor) actions.push({ target: 'executor', executor: event.executor, action: 'off' });
    else if (event.sequence) actions.push({ target: 'sequence', sequence: event.sequence, action: 'off' });
  }
  return [...new Map(actions.map(action => [JSON.stringify(action), action])).values()];
}

export class LightingOutputRelease {
  private plan: { network: Ma2NetworkTarget; actions: Ma2PlaybackAction[] } | null = null;
  private generation = 0;
  private unavailable: string | null = null;
  constructor(private readonly api: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'playMa2Cue'>) {}
  async prepare(document: LightingDocument): Promise<void> {
    const generation = ++this.generation; this.plan = null; this.unavailable = null;
    const actions = lightingReleaseActions(document);
    if (!actions.length) return;
    const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
    if (generation !== this.generation) return;
    if (status.state !== 'connected' || !status.settings) { this.unavailable = '时间码已停止；未连接 MA2 网络，无法发送本节目执行器关闭指令'; return; }
    const { host, port, monitorPort, username } = status.settings;
    this.plan = { network: { host, port, monitorPort, username }, actions };
  }
  cancelPreparation(): void { ++this.generation; }
  async release(): Promise<void> {
    ++this.generation;
    const plan = this.plan; this.plan = null;
    const unavailable = this.unavailable; this.unavailable = null;
    if (unavailable) throw new Error(unavailable);
    if (!plan) return;
    const status = ma2NetworkStatusSchema.parse(await this.api.getMa2NetworkStatus());
    if (status.state !== 'connected' || !status.settings || Object.entries(plan.network).some(([key, value]) => Reflect.get(status.settings!, key) !== value)) throw new Error('灯光关闭未发送：控台连接已改变');
    const sessionId = crypto.randomUUID();
    for (const action of plan.actions) await this.api.playMa2Cue({ network: plan.network, action, sessionId, deadlineAt: Date.now() + 2000 });
  }
}
