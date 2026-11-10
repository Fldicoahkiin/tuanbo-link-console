import { pictureCleanupReason, pictureErrorDetail, toUserErrorReason } from '@tb/core/link';
import type { ClosedProgramFaults } from './main-process-errors';

/** What closes after the program when none is left (the app quits, or the window's page is gone with nothing playing),
 * each already closing: the audio engine, the picture host, the preselected pictures and the editor's music monitor. */
export type EngineOutputs = { engine: Promise<void> | undefined; picture: Promise<void> | undefined;
  preload: Promise<void> | undefined; monitor: Promise<void> | undefined };

/** Waits for all of them. Only an audio engine that could not close fails it: that engine keeps the sound card, and no
 * new one may open it. A picture or preselected picture that was not cleaned up, or a monitor that did not stop, is
 * logged and shown once (ClosedProgramFaults.closeFailed) and holds up no later song and no quit (2026-11-10). */
export async function closeEngineOutputs(outputs: EngineOutputs, faults: Pick<ClosedProgramFaults, 'closeFailed'>): Promise<void> {
  const [engine, picture, preload, monitor] = await Promise.allSettled([outputs.engine, outputs.picture, outputs.preload, outputs.monitor]);
  if (picture.status === 'rejected') {
    faults.closeFailed(`画面没有清理干净，不影响之后播放。原因：${pictureCleanupReason(picture.reason)}。请检查 OBS 节目画面上是否还留着刚才的素材`,
      { level: 'error', category: 'device', device: '后台画面', message: `画面没有清理干净：${pictureErrorDetail(picture.reason)}`, result: 'failed' });
  }
  if (preload.status === 'rejected') {
    faults.closeFailed(`提前准备的画面没有清理干净，不影响播放。原因：${pictureCleanupReason(preload.reason)}`,
      { level: 'error', category: 'device', device: '后台画面', message: `提前准备的画面没有清理干净，不影响播放。原因：${pictureErrorDetail(preload.reason)}`, result: 'failed' });
  }
  // The monitor logged its failure itself (MusicMonitorService's report).
  if (monitor.status === 'rejected') faults.closeFailed(`独立监听没能完全关掉，不影响之后播放。原因：${toUserErrorReason(monitor.reason).replace(/[。.；;\s]+$/u, '') || '未知错误'}`, null);
  if (engine.status === 'rejected') throw engine.reason;
}
