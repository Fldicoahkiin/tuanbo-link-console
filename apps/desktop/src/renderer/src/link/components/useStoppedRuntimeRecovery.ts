import { useEffect, useRef } from 'react';
import type { LinkRuntimeState } from '@tb/core/link';
import type { InternalPlayerState } from '../runtime/internal-playback-controller';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { RemoteNativeProgramPlayer } from '../runtime/remote-native-program-player';
import type { ProjectPlayer } from './ProjectPlayerControls';

export function needsStoppedRuntimeRecovery(internal: boolean, status: InternalPlayerState['status'], runtime: LinkRuntimeState, audioPaused: boolean): boolean {
  return internal && audioPaused && (status === 'stopped' || status === 'error') && ['armed', 'running', 'paused', 'timecodeLost', 'error'].includes(runtime);
}

/**
 * One release per stopped or failed player outcome; the player becoming active again allows the
 * next one. The native player mirrors its own state into the runtime view, so the view's error is
 * the player's error and there is no renderer session to release: releasing it only set the view
 * idle until the next native event mirrored the error back, which restarted the release in a loop.
 */
export function stoppedRuntimeRelease(attempted: boolean, input: { native: boolean; internal: boolean; status: InternalPlayerState['status'];
  runtime: LinkRuntimeState; audioPaused: boolean }): { attempted: boolean; release: boolean } {
  if (input.status !== 'stopped' && input.status !== 'error') return { attempted: false, release: false };
  if (input.native || attempted || !needsStoppedRuntimeRecovery(input.internal, input.status, input.runtime, input.audioPaused)) return { attempted, release: false };
  return { attempted: true, release: true };
}

/** Release an orphan formal session only when the formal player and audio are stopped. */
export function useStoppedRuntimeRecovery(internal: boolean, player: ProjectPlayer, runtime: LinkRuntimeState, coordinator: LinkRuntimeCoordinator | null, notify: (message: string, tone?: 'info' | 'error') => void): void {
  const attempted = useRef(false);
  useEffect(() => {
    if (!coordinator || !player.controller) return;
    const next = stoppedRuntimeRelease(attempted.current, { native: player.controller instanceof RemoteNativeProgramPlayer, internal,
      status: player.state.status, runtime, audioPaused: !player.controller.clock.read().playing });
    attempted.current = next.attempted;
    if (!next.release) return;
    void coordinator.stopAndWait(false, '播放器已停止，结束联动').catch((error: unknown) => notify(`结束已停止的联动失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [internal, player.controller, player.state.status, runtime, coordinator, notify]);
}
