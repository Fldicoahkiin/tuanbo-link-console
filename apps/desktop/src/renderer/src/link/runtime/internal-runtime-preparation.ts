import { firstTimeWarning, materialSceneTargets, type CueRuntime, type CueActionRunner, type MtcSample, type RuntimeUpdate, type ManagedMediaEvent, type PreflightReport } from '@tb/core/link';
import type { LinkProject, RundownItem, IntegrationProfile } from '@tb/schema';
import type { P1LightingOutput } from './p1-lighting-output';
import { PreflightBlockedError } from './preflight-blocked-error';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import { internalSample, internalSeekState } from './internal-timeline';
import { seekInternalRuntime } from './internal-runtime-seek';
import type { ManagedOutputRuntime } from '@tb/core/link';

/** OBS music capture failures already logged as warnings in this window. */
const notedCaptureFailures = new Set<string>();

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
    sample: (value: MtcSample) => void; apply: (update: RuntimeUpdate) => void; notice: (message: string) => void;
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
    scenes.push(...materialSceneTargets(project, itemId).filter(target => mediaIds.has(target.asset.id)).map(target => target.sceneName));
  }
  try { await desktop.setInternalAudioCapture(true, scenes); }
  catch (error) {
    context.assertCurrent();
    const message = `OBS 还没准备好接收音乐：${error instanceof Error ? error.message : String(error)}。本机音频和画面动作照常进行，请在 OBS 混音器里确认是否收到音乐。`;
    // Repeats song after song until fixed: a warning the first time, then info.
    await desktop.recordLog({ level: firstTimeWarning(notedCaptureFailures, message), category: 'device', device: 'OBS 音乐采集',
      projectId: project.projectId, itemId, message, result: 'failed' });
    context.assertCurrent(); context.notice(message);
  }
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
