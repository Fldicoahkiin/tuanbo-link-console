import { toUserErrorMessage } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';
import type { LinkRuntimeCoordinator } from './link-runtime-coordinator';
import type { ProgramPlayerControls } from './program-player-controls';

/** Recovery rule B when OBS reconnects during internal playback. OBS's picture
 * state is unknown and the owned material scenes are forgotten. Playing: prepare
 * this song's material scenes again and rebuild the picture at the current
 * position while audio continues. Paused: prepare the song again at the paused
 * position. Either way the result is shown in red and logged. */
export async function recoverInternalObs(input: {
  project: LinkProject; path: string; status: string; itemId: string | null; positionMs: number;
  coordinator: Pick<LinkRuntimeCoordinator, 'rebuildPicture'>; player: Pick<ProgramPlayerControls, 'seek' | 'reportFault'>;
  notice: (message: string, itemId: string | null) => void;
}): Promise<void> {
  const item = input.project.rundown.find(entry => entry.id === input.itemId);
  if (!item || (input.status !== 'playing' && input.status !== 'paused')) return;
  const report = (message: string): void => { input.notice(message, item.id); input.player.reportFault(message); };
  try {
    if (input.status === 'paused') { await input.player.seek(input.positionMs); report('OBS 已重新连接，画面已按暂停位置恢复'); return; }
    const assets = new Set(item.referenceMediaClips.map(clip => clip.assetId));
    const scoped = { ...input.project, rundown: [item], mediaAssets: input.project.mediaAssets.filter(asset => assets.has(asset.id)) };
    if (scoped.obsOutputMode === 'scenes' && scoped.mediaAssets.length) await desktop.prepareObsMediaScenes(input.path, scoped, useDisplayPreferences.getState().preciseSeeking);
    report(`OBS 已重新连接，画面已按当前位置恢复（${await input.coordinator.rebuildPicture()} 项）`);
  } catch (error) { report(`OBS 已重新连接，但画面恢复失败：${toUserErrorMessage(error)}`); }
}
