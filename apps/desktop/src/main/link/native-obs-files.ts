import { preciseSeekAssetIds, projectFromObsSnapshot } from '@tb/core/link';
import type { NativeObsPrepare } from '@tb/schema';
import type { LinkProjectService } from './link-project-service';
import type { MediaPreviewService } from './media-preview-service';
import { obsMediaDecodeTargets } from './obs-media-decode';

/** Disk-only preparation for the next immutable program. It cannot touch an
 * active decoder, select an OBS scene, or send a lighting/audio command. */
export async function prepareNextObsFiles(request: NativeObsPrepare, services: {
  projects: Pick<LinkProjectService, 'inspectMediaAssets'>;
  media: Pick<MediaPreviewService, 'ensureObsSeekVideo'>;
}, assertCurrent: () => void): Promise<void> {
  const next = request.nextFiles;
  if (!next) return;
  if (next.snapshot.projectId !== request.snapshot.projectId || next.snapshot.revision !== request.snapshot.revision) {
    throw new Error('下一节目文件预备与当前工程修订不一致');
  }
  const precise = preciseSeekAssetIds(next.snapshot, next.positionMs);
  const targets = obsMediaDecodeTargets(projectFromObsSnapshot(next.snapshot));
  for (let index = 0; index < next.snapshot.assets.length; index += 2) {
    assertCurrent();
    const results = await Promise.allSettled(next.snapshot.assets.slice(index, index + 2).map(async asset => {
      assertCurrent();
      const inspected = await services.projects.inspectMediaAssets(request.projectPath, [asset]);
      assertCurrent();
      if (!inspected[asset.id]?.fileAvailable) throw new Error(`下一节目素材文件不可读：${asset.name}`);
      if (request.preciseSeeking && asset.kind === 'video' && precise.has(asset.id)) {
        const modes = new Set(targets.filter(target => target.asset.id === asset.id)
          .map(target => target.hardwareDecode ? 'hardware' as const : 'software' as const));
        for (const mode of modes) {
          await services.media.ensureObsSeekVideo(request.projectPath, asset.relativePath, asset.sha256, mode);
          assertCurrent();
        }
      }
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
