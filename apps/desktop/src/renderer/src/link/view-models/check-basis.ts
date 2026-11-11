import type { LinkObsSnapshot, LinkProcessSnapshot, ShowGate } from '@tb/core/link';
import type { Ma2NetworkStatus } from '@tb/schema';
import type { ConnectionCheck } from '../stores/connection-check-store';

/** The live sources a one-click result depends on (2026-11-11, S11). */
export type CheckBasisInput = {
  processes: Readonly<Record<'p1' | 'ma2' | 'ma3d', Pick<LinkProcessSnapshot, 'status' | 'pid' | 'startTime'>>>;
  obs: Pick<LinkObsSnapshot, 'status' | 'connection'>;
  network: Pick<Ma2NetworkStatus, 'state' | 'connection'> | null;
};
/** What may run now for the one-click connection's checks (showGate 'connections.check'). */
export type LiveCheckInput = CheckBasisInput & { connectionsCheck: ShowGate };

/** The basis of a result that only waits for the show to stop moving: shown while the show still holds it back. */
export const SHOW_WAIT_BASIS = 'show';

/**
 * What a one-click result stood on, read from the live sources when it was made: the program's process (it may have
 * exited or been started again since), the OBS connection, the console connection (main numbers each one). `undefined`:
 * the result stands on no connection of its own (the audio output, MIDI and loopMIDI rows are read live anyway).
 * `null`: the source it stood on was not there, as after a step that could not start or reach it.
 */
export function checkBasis(id: string, live: CheckBasisInput): string | null | undefined {
  switch (id) {
    case 'ma2-app': return processBasis(live.processes.ma2);
    case 'ma3d': return processBasis(live.processes.ma3d);
    case 'p1': return processBasis(live.processes.p1);
    case 'preview': return live.obs.status === 'connected' ? `obs:${live.obs.connection ?? 0}` : null;
    case 'ma2': return `ma2:${live.network?.connection ?? 'none'}`;
    // The console on the network, or the onPC this computer runs when it is used directly (本机 onPC).
    case 'bridge': return `${live.network?.state === 'connected' ? `ma2:${live.network.connection ?? 0}` : 'ma2:-'}|${processBasis(live.processes.ma2) ?? 'onpc:-'}`;
    default: return undefined;
  }
}

function processBasis(process: Pick<LinkProcessSnapshot, 'status' | 'pid' | 'startTime'>): string | null {
  return process.status === 'running' && process.pid !== null ? `process:${process.pid}:${process.startTime ?? ''}` : null;
}

/**
 * The one-click results that still hold, computed again on every change of the live sources and nothing kept
 * (AGENTS §4: computed state is recomputed; 已连接 needs read-back evidence). A settled result stands only while what it
 * stood on is the same: after a disconnect, a reconnect or a restart the live row shows instead. A step still waiting
 * or running in this one-click run is shown as it is. A step that waits for the show is shown while the show still holds
 * it back, with the show's own words; once it may run, the live row shows and the next 一键连接 checks it.
 */
export function liveChecks(checks: Readonly<Record<string, ConnectionCheck>>, live: LiveCheckInput): Record<string, ConnectionCheck> {
  const result: Record<string, ConnectionCheck> = {};
  for (const [id, check] of Object.entries(checks)) {
    if (check.basis === SHOW_WAIT_BASIS) {
      if (live.connectionsCheck.kind === 'wait') result[id] = { ...check, detail: live.connectionsCheck.message };
      continue;
    }
    if (check.state === 'waiting' || check.state === 'checking' || check.basis === undefined || check.basis === checkBasis(id, live)) result[id] = check;
  }
  return result;
}
