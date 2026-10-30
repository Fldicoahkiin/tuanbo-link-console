import type { CueRuntime, RuntimeUpdate } from '@tb/core/link';
import type { LinkProject, RundownItem, IntegrationProfile } from '@tb/schema';
import type { P1LightingOutput } from './p1-lighting-output';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

/** Arms the timeline to start when the external timecode starts (P1 follow mode). */
export async function prepareRuntimeArm(project: LinkProject, item: RundownItem | undefined, context: {
  profile: IntegrationProfile | null; autoFollow: boolean; lighting: P1LightingOutput; runtime: CueRuntime; assertCurrent(): void;
}): Promise<RuntimeUpdate> {
  context.assertCurrent();
  if (project.obsOutputMode !== 'scenes') await desktop.activateManagedObsOutput();
  context.assertCurrent();
  await context.lighting.prepare(project.playbackSource === 'internal' ? undefined : item, context.profile, context.autoFollow);
  context.assertCurrent();
  return context.runtime.arm(performance.now(), null, 'awaiting-external-start');
}
