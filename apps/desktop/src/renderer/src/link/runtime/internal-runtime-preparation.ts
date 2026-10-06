import { materialSceneNames, type CueRuntime, type CueActionRunner, type MtcSample, type RuntimeUpdate, type ManagedMediaEvent, type PreflightReport } from '@tb/core/link';
import type { LinkProject, RundownItem, IntegrationProfile } from '@tb/schema';
import type { P1LightingOutput } from './p1-lighting-output';
import { PreflightBlockedError } from './preflight-blocked-error';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { internalSample, internalSeekState } from './internal-timeline';
import { seekInternalRuntime } from './internal-runtime-seek';
import type { ManagedOutputRuntime } from '@tb/core/link';

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

export async function prepareInternalRuntime(project: LinkProject, itemId: string, positionMs: number,
  preflight: () => Promise<PreflightReport>, context: {
    assertCurrent: () => void; select: () => void; capture: () => void; armFromStart: () => Promise<void>;
    runtime: CueRuntime; managed: ManagedOutputRuntime; runner: CueActionRunner; projectPath: string | null;
    sample: (value: MtcSample) => void; apply: (update: RuntimeUpdate) => void;
    execute: (cues: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]) => Promise<void>;
  }): Promise<void> {
  context.assertCurrent(); context.select();
  const report = await preflight();
  context.assertCurrent();
  if (!report.passed) throw new PreflightBlockedError(report);
  context.capture();
  const scenes = project.obsOutputMode === 'scenes' ? project.rundown.find((item) => item.id === itemId)?.cues.filter((cue) => cue.enabled)
    .flatMap((cue) => cue.actions.flatMap((action) => action.kind === 'obs.setProgramScene' ? [action.sceneName] : [])) ?? [] : undefined;
  if (scenes) {
    const mediaIds = new Set(project.rundown.find((item) => item.id === itemId)?.referenceMediaClips.map((clip) => clip.assetId));
    scenes.push(...project.mediaAssets.filter((asset) => mediaIds.has(asset.id)).map((asset) => materialSceneNames(project.projectId, asset).sceneName));
  }
  await desktop.setInternalAudioCapture(true, scenes);
  context.assertCurrent();
  if (positionMs === 0) { await context.armFromStart(); return; }
  const sample = internalSample(project, positionMs); context.sample(sample);
  if (project.obsOutputMode === 'scenes') {
    await seekInternalRuntime(project, context.projectPath, itemId, sample, context.runtime, context.managed, context.runner, context.apply, context.assertCurrent);
  } else {
    await desktop.activateManagedObsOutput();
    context.assertCurrent();
    context.apply(context.runtime.arm(performance.now(), sample)); context.managed.collectThrough(sample.totalFrames);
    const work = internalSeekState(project, itemId, positionMs);
    await context.execute(work.cues, work.media);
  }
}
