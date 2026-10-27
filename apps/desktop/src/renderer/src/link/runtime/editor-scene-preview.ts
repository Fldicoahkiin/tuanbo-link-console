import { playbackFramesPerSecond, type LinkDesktopApi } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { internalSample, internalSeekState } from './internal-timeline';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { reportCoordinatorError } from './runtime-action-log';
import { executeObsCueAction } from './obs-ipc-executor';

type PreviewDesktop = Pick<LinkDesktopApi, 'prepareObsMediaScenes' | 'executeObsAction' | 'setObsProgramSourceEnabled' | 'seekManagedMedia'>;

export class EditorScenePreview {
  private failed = false;
  private generation = 0;
  reset(): void { this.failed = false; this.generation += 1; }
  enqueue(pending: Promise<void>, project: LinkProject, projectPath: string | null,
    itemId: string, positionMs: number, preciseSeeking: boolean, isCurrent: () => boolean) {
    const generation = this.generation;
    const current = () => generation === this.generation && !this.failed && isCurrent();
    const operation = pending.then(async () => {
      if (!current()) return;
      if (!projectPath) throw new Error('请先保存工程，再定位 OBS 画面');
      if (useIntegrationStore.getState().obs.status !== 'connected') throw new Error('OBS 没有连接，画面无法跟随时间线');
      await previewEditorScene(project, projectPath, itemId, positionMs, preciseSeeking, linkDesktopViewModel, current);
    }).catch((error: unknown) => {
      if (generation === this.generation) this.failed = true;
      throw new Error(`${error instanceof Error ? error.message : String(error)}。画面定位已暂停，处理好后先点“停止”，再重新定位。`, { cause: error });
    });
    const tail = operation.catch((error: unknown) => reportCoordinatorError(
      `编辑画面定位失败：${error instanceof Error ? error.message : String(error)}`, message => console.error(message)));
    return { operation, tail };
  }
}

/** Explicit stopped-cursor preview: OBS renders the frame; no audio clock or Cue session is armed. */
export async function previewEditorScene(project: LinkProject, projectPath: string, itemId: string,
  positionMs: number, preciseSeeking: boolean, desktop: PreviewDesktop, current: () => boolean): Promise<void> {
  if (project.obsOutputMode !== 'scenes') throw new Error('时间线画面定位需要 OBS 场景模式');
  if (!Number.isFinite(positionMs) || positionMs < 0) throw new Error('画面定位时间无效');
  const frame = internalSample(project, positionMs).totalFrames;
  const work = internalSeekState(project, itemId, positionMs);
  const media = work.media.map(event => ({ ...event, embeddedAudioEnabled: false,
    sourceOffsetMs: event.sourceOffsetMs + (event.assetKind === 'image' ? 0
      : Math.round(Math.max(0, frame - event.frameNumber) * 1000 / playbackFramesPerSecond(project.timebase.frameRate))) }));
  if (!current()) return;
  if (media.length) {
    const assetIds = new Set(media.map(event => event.assetId));
    await desktop.prepareObsMediaScenes(projectPath, { ...project,
      rundown: project.rundown.filter(item => item.id === itemId).map(item => ({ ...item,
        referenceMediaClips: item.referenceMediaClips.filter(clip => assetIds.has(clip.assetId)) })),
      mediaAssets: project.mediaAssets.filter(asset => assetIds.has(asset.id)) }, preciseSeeking);
  }
  for (const entry of work.cues) for (const action of entry.cue.actions) {
    if (!current()) return;
    await executeObsCueAction(desktop, project, action);
  }
  for (const event of media) {
    if (!current()) return;
    await desktop.seekManagedMedia({ projectPath, event });
  }
}
