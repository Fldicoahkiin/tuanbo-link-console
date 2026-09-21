import { useEffect, useRef } from 'react';
import type { LinkRuntimeState } from '@tb/core/link';
import type { InternalPlayerState } from '../runtime/internal-playback-controller';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import type { ProjectPlayer } from './ProjectPlayerControls';

export function needsStoppedRuntimeRecovery(internal: boolean, status: InternalPlayerState['status'], runtime: LinkRuntimeState, audioPaused: boolean): boolean {
  return internal && audioPaused && (status === 'stopped' || status === 'error') && ['armed', 'running', 'paused', 'timecodeLost', 'error'].includes(runtime);
}
/** Release an orphan formal session only when the formal player and audio are stopped. */
export function useStoppedRuntimeRecovery(internal: boolean, player: ProjectPlayer, runtime: LinkRuntimeState, coordinator: LinkRuntimeCoordinator | null, notify: (message: string, tone?: 'info' | 'error') => void): void {
  const attempted = useRef(false);
  useEffect(() => {
    if (runtime === 'idle') { attempted.current = false; return; }
    if (!coordinator || !player.controller || attempted.current || !needsStoppedRuntimeRecovery(internal, player.state.status, runtime, player.controller.mediaElement.paused)) return;
    attempted.current = true;
    void coordinator.stopAndWait(false).catch((error: unknown) => notify(`释放已停止的联动会话失败：${error instanceof Error ? error.message : String(error)}`, 'error'));
  }, [internal, player.controller, player.state.status, runtime, coordinator, notify]);
}
