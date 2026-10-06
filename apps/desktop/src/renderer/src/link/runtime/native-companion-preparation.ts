import type { CueRuntime, MtcSample, PreflightReport, RuntimeUpdate } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import type { InternalPreparationScope } from './internal-preparation-scope';
import type { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { internalSample } from './internal-timeline';

/** OBS and MTC are already owned by background services. Prepare only local MIDI
 * actions; a program without those actions observes native playback, never MTC. */
export async function prepareNativeCompanionRuntime(project: LinkProject, itemId: string, positionMs: number, deps: {
  scope: InternalPreparationScope;
  stop(): Promise<void>;
  select(): void;
  beginPreflight(): void;
  initializeMidi(): Promise<void>;
  midi: LinkMidiAdapter;
  applyPreflight(report: PreflightReport): Promise<void>;
  runtime: CueRuntime;
  sample(sample: MtcSample | null): void;
  apply(update: RuntimeUpdate): void;
}, signal?: AbortSignal): Promise<void> {
  await deps.scope.run(() => deps.stop(), async assertCurrent => {
    deps.select(); assertCurrent();
    const item = project.rundown.find(entry => entry.id === itemId);
    if (!item) throw new Error('节目不存在');
    const ports = [...new Set(item.cues.filter(cue => cue.enabled).flatMap(cue => cue.actions.flatMap(action =>
      action.kind.startsWith('midi.') && 'portProfileId' in action ? [action.portProfileId] : [])))];
    deps.beginPreflight();
    if (ports.length) {
      await deps.initializeMidi(); assertCurrent();
      const errors = await deps.midi.openOutputs(ports); assertCurrent();
      if (errors.length) throw new Error(`MIDI Cue 未参与：${errors.join('；')}`);
    }
    await deps.applyPreflight({ checkedAt: new Date().toISOString(), mode: 'live', passed: true,
      checks: [{ id: 'midi.nativeCompanion', label: '通用 MIDI Cue', status: 'passed', detail: ports.length
        ? `已准备 ${ports.length} 个输出目标` : '当前节目没有通用 MIDI Cue；音频、时间码和画面由后台服务报告' }] });
    assertCurrent();
    const sample = positionMs > 0 ? internalSample(project, positionMs) : null;
    deps.sample(sample);
    deps.apply(deps.runtime.arm(performance.now(), sample, 'awaiting-external-start', ports.length ? 'local' : 'external'));
  }, signal);
}
