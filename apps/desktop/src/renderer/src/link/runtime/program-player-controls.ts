import type { InternalPlaybackController } from './internal-playback-controller';

/** Public operations shared by the explicit browser comparison engine and the
 * native engine. A media element or capture stream is not part of this API. */
export type ProgramPlayerControls = Omit<InternalPlaybackController, 'captureMonitoringStream' | 'reportPreparation'>;
