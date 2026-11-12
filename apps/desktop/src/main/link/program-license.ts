import type { LinkDesktopApi } from '@tb/core/link';
import type { Ma2NetworkStatus, Ma2PlaybackRequest } from '@tb/schema';
import { needsProductLicense, type LicenseAccess } from './license-access';

/** link-main's license check: its single LicenseAccess, and whether an activation or online check is changing the license. */
export type LicenseGate = { access: LicenseAccess; changing(): boolean };

/** One request through the check, from the window's IPC (link-main's authorizeProduct) or from the background program on
 * the same channel: what needs a license (needsProductLicense) is refused while the license is being changed, then checked
 * by LicenseAccess; stopping passes. */
export async function authorizeRequest(gate: LicenseGate, channel: string, value: unknown): Promise<void> {
  const protectedCall = needsProductLicense(channel, value);
  if (protectedCall && gate.changing()) throw new Error('授权操作还没完成，请稍后再试');
  await gate.access.authorize(channel, value);
  if (protectedCall && gate.changing()) throw new Error('正在更换授权，请完成后再试');
}

/** The console as link-main reaches it: its network service once it is ready, and the send that logs each request. */
export type ProgramMa2 = { ready: Promise<void>; status(): Ma2NetworkStatus; send(request: Ma2PlaybackRequest): Promise<void> };

/** What the background program takes from the license, wired here once so that link-main only calls it
 * (2026-11-09: stop, lights off, pause, mute and hide are never refused for license; a running show keeps its license by
 * the background program's state, not the window's; docs/LICENSE_IMPLEMENTATION.md, license-rules.test.ts):
 * - `network`: the console adapter of NativeProgramHost. Its stop switches the song's executors off through it, each
 *   request checked like the window's on link:ma2-play-cue, so an Off goes out with an expired license, an ended offline
 *   lease or a clock turned back, while a Go or Goto stays licensed.
 * - `runningChanged`: NativeProgramService reports whether the program prepares, plays or pauses the show; the show keeps
 *   the license the window checked while it does.
 * - `followRunningChanged`: the main process's P1 follow reports whether it runs the show (armed until stopped,
 *   p1-follow-wiring.ts followRuns, 0.5.9 P3f); either of the two running keeps the license as the program alone did. */
export function programLicense(gate: LicenseGate, ma2: ProgramMa2): {
  network: Pick<LinkDesktopApi, 'getMa2NetworkStatus' | 'playMa2Cue'>;
  runningChanged: (running: boolean) => void;
  followRunningChanged: (running: boolean) => void;
} {
  let program = false, follow = false;
  return {
    network: {
      getMa2NetworkStatus: async () => { await ma2.ready; return ma2.status(); },
      playMa2Cue: async request => { await authorizeRequest(gate, 'link:ma2-play-cue', request); await ma2.send(request); }
    },
    runningChanged: running => { program = running; gate.access.setProgramRunning(program || follow); },
    followRunningChanged: running => { follow = running; gate.access.setProgramRunning(program || follow); }
  };
}
