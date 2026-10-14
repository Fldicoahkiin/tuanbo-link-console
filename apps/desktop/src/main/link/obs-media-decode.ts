import { materialSceneTargets } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';

/** Preparation and playback must request the same cache for each decoder.
 * Budget actual inputs, including separate tracks that reuse one asset. */
export function obsMediaDecodeTargets(project: LinkProject): Array<ReturnType<typeof materialSceneTargets>[number] & { hardwareDecode: boolean }> {
  let hardwareCount = 0;
  return materialSceneTargets(project).map(target => ({ ...target,
        hardwareDecode: target.asset.kind === 'video' && hardwareCount++ < 2
  }));
}
