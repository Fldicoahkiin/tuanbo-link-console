import type { PlayerControlState, PlayerViewStore } from '../stores/player-view-store';
import type { RemoteNativeProgramPlayer } from './remote-native-program-player';

/** The window's handle on 联动台播放, as the pages and the runtime hooks get it. `engine` names the audio engine this
 * player uses, for the operator. `outdated`: the background program plays a version of the project this page did not
 * send, taken over after a window reload; null until the program answered the open (program-attachment). */
export type ProjectPlayer = { controller: RemoteNativeProgramPlayer | null; state: PlayerControlState; view: PlayerViewStore; engine: string; outdated: boolean | null };
