import { materialSceneNames, type CueRuntime, type ManagedMediaEvent, type MtcSample, type PreflightReport, type RuntimeUpdate } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { internalSample, internalSeekState } from './internal-timeline';
import { PreflightBlockedError } from './preflight-blocked-error';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export async function prepareInternalRuntime(project: LinkProject, itemId: string, positionMs: number,
  preflight: () => Promise<PreflightReport>, context: {
    stop: () => Promise<void>; select: () => void; capture: () => void; armFromStart: () => Promise<void>;
    runtime: CueRuntime; sample: (value: MtcSample) => void; apply: (value: RuntimeUpdate) => void;
    collectThrough: (frame: number) => void;
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
  if (project.obsOutputMode !== 'scenes') await desktop.activateManagedObsOutput();
  const sample = internalSample(project, positionMs); context.sample(sample);
  context.apply(context.runtime.arm(performance.now(), sample)); context.collectThrough(sample.totalFrames);
  const restored = internalSeekState(project, itemId, positionMs);
  await context.execute(restored.cues, restored.media);
}
