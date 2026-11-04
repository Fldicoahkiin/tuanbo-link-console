import type { CueRuntime, RuntimeUpdate } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

/** Arms the timeline to start when the external timecode starts (P1 follow mode). */
export async function prepareRuntimeArm(project: LinkProject, context: { runtime: CueRuntime; assertCurrent(): void }): Promise<RuntimeUpdate> {
  context.assertCurrent();
  if (project.obsOutputMode !== 'scenes') await desktop.activateManagedObsOutput();
  context.assertCurrent();
  return context.runtime.arm(performance.now(), null, 'awaiting-external-start');
}
