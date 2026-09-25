import { materialSceneNames, type CueRuntime, type CueActionRunner, type MtcSample, type RuntimeUpdate, type ManagedMediaEvent, type PreflightReport } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { PreflightBlockedError } from './preflight-blocked-error';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { internalSample, internalSeekState } from './internal-timeline';
import { seekInternalRuntime } from './internal-runtime-seek';
import type { ManagedOutputRuntime } from './managed-output-runtime';

export async function prepareInternalRuntime(project: LinkProject, itemId: string, positionMs: number,
  preflight: () => Promise<PreflightReport>, context: {
    stop: () => Promise<void>; select: () => void; capture: () => void; armFromStart: () => Promise<void>;
    runtime: CueRuntime; managed: ManagedOutputRuntime; runner: CueActionRunner; projectPath: string | null;
    sample: (value: MtcSample) => void; apply: (update: RuntimeUpdate) => void;
    execute: (cues: RuntimeUpdate['dueCues'], media: ManagedMediaEvent[]) => Promise<void>;
  }): Promise<void> {
  await context.stop(); context.select();
  const report = await preflight();
  if (!report.passed) throw new PreflightBlockedError(report);
  context.capture();
  const scenes = project.obsOutputMode === 'scenes' ? project.rundown.find((item) => item.id === itemId)?.cues.filter((cue) => cue.enabled)
    .flatMap((cue) => cue.actions.flatMap((action) => action.kind === 'obs.setProgramScene' ? [action.sceneName] : [])) ?? [] : undefined;
  if (scenes) {
    const mediaIds = new Set(project.rundown.find((item) => item.id === itemId)?.referenceMediaClips.map((clip) => clip.assetId));
    scenes.push(...project.mediaAssets.filter((asset) => mediaIds.has(asset.id)).map((asset) => materialSceneNames(project.projectId, asset).sceneName));
  }
  await desktop.setInternalAudioCapture(true, scenes);
  if (positionMs === 0) { await context.armFromStart(); return; }
  const sample = internalSample(project, positionMs); context.sample(sample);
  if (project.obsOutputMode === 'scenes') {
    await seekInternalRuntime(project, context.projectPath, itemId, sample, context.runtime, context.managed, context.runner, context.apply);
  } else {
    await desktop.activateManagedObsOutput();
    context.apply(context.runtime.arm(performance.now(), sample)); context.managed.collectThrough(sample.totalFrames);
    const work = internalSeekState(project, itemId, positionMs);
    await context.execute(work.cues, work.media);
  }
}
