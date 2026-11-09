import type { ProgramPlayerState } from '@tb/schema';
import { holdsSong } from './view-models/picture-on-air';

/**
 * What a window knows of the background program its player opened (useInternalPlayer). After a window reload the
 * program may have kept playing; the window takes it over, and the program sends its state before it answers the
 * open with whether it plays the document this window opened or another version (RemoteNativeProgramPlayer.outdated,
 * told through `attached`). Until that answer, the window cannot tell which version is on air.
 */

/** The answer to an open, as the controller that opened it heard it: whether the program plays another version. */
export type OpenAnswer<Controller> = { controller: Controller; outdated: boolean };

/** The answer `controller` heard, read when it heard it. */
export function openAnswer<Controller extends { readonly outdated: boolean }>(controller: Controller): OpenAnswer<Controller> {
  return { controller, outdated: controller.outdated };
}

/**
 * Whether the program `controller` opened plays another version of the project than this window opened it with;
 * null until the program answers that open, and when there is no controller. An answer an earlier controller heard
 * does not count.
 */
export function playsOutdated<Controller>(controller: Controller | null, answer: OpenAnswer<Controller> | null): boolean | null {
  return controller !== null && answer !== null && answer.controller === controller ? answer.outdated : null;
}

/** Whether the window opens the document it shows again: the program it took over plays another version and holds
 * no song any more, so the next song plays what the editor shows. Never while it does not know yet. */
export function reopensShown(outdated: boolean | null, status: ProgramPlayerState['status']): boolean {
  return outdated === true && !holdsSong(status);
}

/** The audio output a program is opened with. */
export type AudioConfiguration = { deviceId: string; sampleRate: number };

/**
 * The output the window's program uses: the device settings, except while it holds a song (a change waits for
 * 停止). The window applies it while rendering, before its first open: the settings arrive together with `ready`
 * after a reload, and opening once with the old output and again with the new one closes the background program
 * the first open had just taken over, which stops the show. `current` is returned as is when nothing changes.
 */
export function followAudioConfiguration<Configuration extends AudioConfiguration>(current: Configuration, requested: Configuration, holding: boolean): Configuration {
  return holding || (current.deviceId === requested.deviceId && current.sampleRate === requested.sampleRate) ? current : requested;
}
