import type { NativeProgramClosed } from '@tb/schema';
import type { ExternalApplicationId } from './external-process-manager';
import type { ClosedProgramFaults } from './main-process-errors';
import type { NativeProgramService } from './native-program-service';

/** What a quit does, step by step, as link-main's runQuitFlow supplies it; quitInOrder decides the order. */
export type QuitSteps = {
  /** The lighting audition stops. False: it could not, and the operator went back to the app (返回软件). */
  stopAudition(): Promise<boolean>;
  /** Each program this app started is asked about (取消退出 / 保留它，继续 / 正常关闭它): the ones to close, or null when
   * the operator chose 取消退出. */
  askExternalPrograms(): Promise<readonly ExternalApplicationId[] | null>;
  /** True when a song started while a question was open (the playback MIDI input still works under a dialog): the quit
   * stops, as it does when asked while playing, and says so. */
  songStarted(): boolean;
  /** The window's program; null before it exists. */
  program: Pick<NativeProgramService, 'owner' | 'close'> | null;
  /** Collects what the program's close owed and did not do (the lights-off of its stop). */
  faults: Pick<ClosedProgramFaults, 'collect'>;
  /** Asked when the program's lights did not go off (programLightsQuitPrompt): true for 仍然退出. */
  quitWithLightsOn(messages: readonly string[]): Promise<boolean>;
  /** The program the window opened is closed and the app stays open: the window is told, and opens a new program. */
  programClosed(closed: NativeProgramClosed): void;
  /** The audio engine, the picture, the preselected pictures and the editor's music monitor. */
  closeOutputs(): Promise<void>;
  /** Closes the programs chosen and the rest of the app; the app ends. */
  finish(close: readonly ExternalApplicationId[]): Promise<void>;
  record(step: string): void;
};

/** Resolves true once the app ended, false when the operator went back to the app.
 * Every question that can be asked with the window's program open is asked before it closes, so going back from one
 * (取消退出) leaves the window a program it plays with (2026-11-11). What is known only once the program closed (its
 * lights did not go off, 2026-11-10) is asked after; going back from it, or a later step that fails, tells the window
 * its program is closed, and the window opens a new one, as after a project change. The audio engine closes last: the
 * window's new program plays with it. */
export async function quitInOrder(steps: QuitSteps): Promise<boolean> {
  if (!await steps.stopAudition()) return false;
  const close = await steps.askExternalPrograms();
  if (close === null || steps.songStarted()) return false;
  steps.record('退出前关闭节目');
  const owner = steps.program?.owner() ?? null;
  let ended = false;
  try {
    // The Off the program's stop owed goes out as it closes; one that did not is asked about before anything else closes.
    const lightsLeftOn = await steps.faults.collect(() => steps.program?.close() ?? Promise.resolve());
    if (lightsLeftOn.length > 0 && !await steps.quitWithLightsOn(lightsLeftOn)) return false;
    steps.record('退出前关闭音频和画面');
    await steps.closeOutputs();
    await steps.finish(close);
    ended = true;
    return true;
  } finally {
    if (!ended && owner) steps.programClosed({ version: 1, ownerId: owner });
  }
}
