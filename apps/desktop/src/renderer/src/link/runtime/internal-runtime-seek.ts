import type { CueActionRunner, CueRuntime, MtcSample, RuntimeUpdate } from '@tb/core/link';
import { timecodeToMilliseconds } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { internalSeekState } from './internal-timeline';
import type { ManagedOutputRuntime } from './managed-output-runtime';
import { executeManagedOutputCleanup } from './managed-output-cleanup';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

/** Explicit operator seek skips crossed cues and retains the loaded media session. */
export async function seekInternalRuntime(project: LinkProject, projectPath: string | null, itemId: string,
  sample: MtcSample, runtime: CueRuntime, managed: ManagedOutputRuntime, runner: CueActionRunner,
  apply: (update: RuntimeUpdate) => void): Promise<void> {
  if (!projectPath || project.playbackSource !== 'internal' || project.obsOutputMode !== 'scenes') throw new Error('原生定位需要已保存的本机场景工程');
  const work = internalSeekState(project, itemId, timecodeToMilliseconds(sample.timecode, project.timebase.frameRate));
  const targets = work.media.map(event => managed.alignEvent(event, sample.totalFrames));
  const cleanup = managed.takeCleanup();
  await executeManagedOutputCleanup({ ...cleanup, mediaEvents: cleanup.mediaEvents.filter((event) => !targets.some(target => target.sourceName === event.sourceName)) }, managed, runner);
  const mode = runtime.getMode();
  apply(runtime.stop()); apply(runtime.completeStop()); apply(runtime.selectItem(itemId));
  apply(runtime.beginPreflight(mode)); apply(runtime.arm(performance.now(), sample));
  apply(runtime.pauseAutomatic());
  for (const entry of work.cues) for (const action of entry.cue.actions) await desktop.executeObsAction(action);
  for (const event of targets) await desktop.seekManagedMedia({ projectPath, event });
  managed.adoptSeek(targets, sample.totalFrames);
}
