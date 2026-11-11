import { useMemo } from 'react';
import type { ProjectPlayer } from './components/ProjectPlayerControls';
import { useDocumentStore } from './stores/document-store';
import { useIntegrationStore } from './stores/integration-store';
import { useMa2ModeStore } from './stores/ma2-mode-store';
import { useLocalMa2Store } from './stores/ma2-connection-store';
import { useConnectionCheckStore } from './stores/connection-check-store';
import { useMa2NetworkStatusStore } from './stores/ma2-network-status-store';
import { useConsoleFollowStore } from './stores/console-follow-store';
import { showGate } from '@tb/core/link';
import { useShowStateStore } from './stores/show-state-store';
import { statusCenter, type StatusCenter } from './view-models/status-center';
import { liveChecks } from './view-models/check-basis';
import type { ConnectionCheck } from './stores/connection-check-store';

/** The one-click results that still stand on the live connections and the show (check-basis.ts), computed again on
 * every change. Every view that shows a result reads it here, not from useConnectionCheckStore. */
export function useLiveConnectionChecks(): Record<string, ConnectionCheck> {
  const checks = useConnectionCheckStore(state => state.checks);
  const obs = useIntegrationStore(state => state.obs);
  const p1 = useIntegrationStore(state => state.processes.p1);
  const ma2 = useIntegrationStore(state => state.processes.ma2);
  const ma3d = useIntegrationStore(state => state.processes.ma3d);
  const network = useMa2NetworkStatusStore(state => state.status);
  const show = useShowStateStore(state => state.show);
  return useMemo(() => liveChecks(checks, { obs, network, processes: { p1, ma2, ma3d }, connectionsCheck: showGate('connections.check', show) }),
    [checks, obs, network, p1, ma2, ma3d, show]);
}

/** The status center for the open project and the playing song. */
export function useStatusCenter(player: ProjectPlayer): StatusCenter {
  const project = useDocumentStore(state => state.project);
  const method = useMa2ModeStore(state => state.method);
  const localStatus = useLocalMa2Store(state => state.status);
  const localError = useLocalMa2Store(state => state.error);
  const obs = useIntegrationStore(state => state.obs);
  const p1 = useIntegrationStore(state => state.processes.p1);
  const ma2 = useIntegrationStore(state => state.processes.ma2);
  const ma3d = useIntegrationStore(state => state.processes.ma3d);
  const profile = useIntegrationStore(state => state.profile);
  const midiPorts = useIntegrationStore(state => state.midiPorts);
  const nativeDevices = useIntegrationStore(state => state.nativeDevices);
  const nativeDeviceError = useIntegrationStore(state => state.nativeDeviceError);
  const checks = useLiveConnectionChecks();
  const network = useMa2NetworkStatusStore(state => state.status);
  const networkError = useMa2NetworkStatusStore(state => state.error);
  const follow = useConsoleFollowStore(state => state.follow);
  const lightingOff = useShowStateStore(state => state.lightingOff);
  const { status, mtcSending, mtcConnectionFailed, pictureItems } = player.state;
  return useMemo(() => statusCenter({ project, profile, method, local: { status: localStatus, error: localError }, obs, processes: { p1, ma2, ma3d },
    midiPorts, nativeDevices, nativeDeviceError, checks, network, networkError, player: { status, mtcSending, mtcConnectionFailed, pictureItems: pictureItems ?? [] }, follow, lightingOff }),
  [project, profile, method, localStatus, localError, obs, p1, ma2, ma3d, midiPorts, nativeDevices, nativeDeviceError, checks, network, networkError, status, mtcSending, mtcConnectionFailed, pictureItems, follow, lightingOff]);
}
