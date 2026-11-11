import { pictureCleanupReason, pictureErrorDetail, toUserErrorReason, type InternalPlayerState } from '@tb/core/link';
import type { ClosedProgramFaults } from './main-process-errors';
import type { NativeProgramService } from './native-program-service';

/** What closes after the program when none is left (the app quits, or the window's page is gone with nothing playing),
 * each already closing: the audio engine, the picture host and the preselected pictures. */
export type EngineOutputs = { engine: Promise<void> | undefined; picture: Promise<void> | undefined; preload: Promise<void> | undefined };

/** Waits for all of them. Only an audio engine that could not close fails it: that engine keeps the sound card, and no
 * new one may open it. A picture or preselected picture that was not cleaned up is logged and shown once
 * (ClosedProgramFaults.closeFailed) and holds up no later song and no quit (2026-11-10). */
export async function closeEngineOutputs(outputs: EngineOutputs, faults: Pick<ClosedProgramFaults, 'closeFailed'>): Promise<void> {
  const [engine, picture, preload] = await Promise.allSettled([outputs.engine, outputs.picture, outputs.preload]);
  if (picture.status === 'rejected') {
    faults.closeFailed(`画面没有清理干净，不影响之后播放。原因：${pictureCleanupReason(picture.reason)}。请检查 OBS 节目画面上是否还留着刚才的素材`,
      { level: 'error', category: 'device', device: '后台画面', message: `画面没有清理干净：${pictureErrorDetail(picture.reason)}`, result: 'failed' });
  }
  if (preload.status === 'rejected') {
    faults.closeFailed(`提前准备的画面没有清理干净，不影响播放。原因：${pictureCleanupReason(preload.reason)}`,
      { level: 'error', category: 'device', device: '后台画面', message: `提前准备的画面没有清理干净，不影响播放。原因：${pictureErrorDetail(preload.reason)}`, result: 'failed' });
  }
  if (engine.status === 'rejected') throw engine.reason;
}

/** Stops the editor's music monitor (MusicMonitorService.stop), when its page is gone or the app quits. One that did
 * not stop is shown once (it logged its failure itself) and holds up nothing; this never fails. */
export async function monitorStopped(stop: () => Promise<void> | undefined, faults: Pick<ClosedProgramFaults, 'closeFailed'>): Promise<void> {
  try { await stop(); }
  catch (error) { faults.closeFailed(`独立监听没能完全关掉，不影响之后播放。原因：${toUserErrorReason(error).replace(/[。.；;\s]+$/u, '') || '未知错误'}`, null); }
}

/** What the gone page held, as link-main releases it once the page in the main window is gone (its renderer exited, or
 * a new page replaced it: window-page.ts). */
export type GonePage = {
  /** The editor's music monitor: it is the page's alone, so it stops whatever happens to the program (2026-11-11). */
  stopMonitor(): Promise<void> | undefined;
  /** The audio engine, the picture and the runtime the page held, after its program closed. */
  teardown(): Promise<void>;
};

/** The page's monitor stops now. Its program, if preparing, playing or paused, keeps its outputs for the next page and
 * is returned; otherwise it closes, and `teardown` runs on the program's close chain, unless the next page opened a
 * program meanwhile: that one keeps them (NativeProgramService.release, 2026-11-10). Before the program service exists,
 * `teardown` runs at once. */
export function releaseGonePage(program: Pick<NativeProgramService, 'release'> | null, page: GonePage,
  faults: Pick<ClosedProgramFaults, 'closeFailed'>): Promise<InternalPlayerState | null> {
  // release() first: what fails from now on waits for the next window (ClosedProgramFaults.windowExited).
  const released = program ? program.release(() => page.teardown()) : page.teardown().then(() => null);
  void monitorStopped(() => page.stopMonitor(), faults);
  return released;
}
