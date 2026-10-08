import { toUserErrorMessage } from '@tb/core/link';
import { localObsConnectionResultSchema, type IntegrationProfile } from '@tb/schema';
import { useIntegrationStore } from './stores/integration-store';
import { linkDesktopViewModel } from './view-models/link-desktop-view-model';
import { prepareLoopMidi } from './view-models/loop-midi';
import { readNativeDevices } from './view-models/midi-device-inventory';

type ObsSnapshot = Awaited<ReturnType<typeof linkDesktopViewModel.getObsSnapshot>>;
type ProcessSnapshots = Awaited<ReturnType<typeof linkDesktopViewModel.getExternalSnapshots>>;

export function initializeStartupDevices(
  profile: IntegrationProfile | null,
  securityAvailable: boolean,
  obsSnapshot: ObsSnapshot,
  isCancelled: () => boolean
): void {
  if (!profile) return;
  const warn = (device: 'midi' | 'p1' | 'obs', label: string, error: unknown): void => {
    const message = `${label}：${toUserErrorMessage(error)}`;
    void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device, message }).catch(console.error);
  };
  void prepareLoopMidi(profile).catch(error => warn('midi', '启动时虚拟 MIDI 未就绪', error));
  if (profile.internalPlayer?.audioEngine === 'native') {
    void readNativeDevices().catch(error => warn('midi', '启动时 Windows MIDI 设备读取失败', error));
  }
  void linkDesktopViewModel.refreshExternalApplication('p1')
    .then(snapshot => { if (!isCancelled()) useIntegrationStore.getState().setProcess(snapshot); })
    .catch(error => warn('p1', 'P1 进程检测未完成', error));
  if (securityAvailable && profile.obs.autoConnectOnLaunch !== false) {
    void connectStartupObs(profile, securityAvailable, obsSnapshot, [], isCancelled);
  } else {
    void linkDesktopViewModel.refreshExternalApplication('obs')
      .then(snapshot => { if (!isCancelled()) useIntegrationStore.getState().setProcess(snapshot); })
      .catch(error => warn('obs', 'OBS 进程检测未完成', error));
  }
}

export async function connectStartupObs(
  profile: IntegrationProfile | null,
  securityAvailable: boolean,
  obsSnapshot: ObsSnapshot,
  snapshots: ProcessSnapshots,
  isCancelled: () => boolean
): Promise<void> {
  if (!profile || !securityAvailable || profile.obs.autoConnectOnLaunch === false || obsSnapshot.status === 'connected') return;
  try {
    if (profile.obs.connectionMethod !== 'manual') {
      const result = localObsConnectionResultSchema.parse(await linkDesktopViewModel.connectLocalObs());
      if (isCancelled()) return;
      useIntegrationStore.getState().setObs(result.snapshot);
      try {
        const saved = await linkDesktopViewModel.loadIntegrationProfile();
        if (saved && !isCancelled()) useIntegrationStore.getState().setProfile(saved);
      } catch (error) {
        const message = `OBS 已连接，但连接配置刷新失败：${toUserErrorMessage(error)}`;
        if (!isCancelled()) useIntegrationStore.getState().setError(message);
        void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'obs', message }).catch(console.error);
      }
      if (result.snapshot.status === 'connected' && !isCancelled()) await refreshConnectedObsInventory(isCancelled);
      return;
    }
    const security = await linkDesktopViewModel.getSecurityPreflight();
    if (!security.credentialDecryptable || isCancelled()) return;
    if (snapshots.find(snapshot => snapshot.id === 'obs')?.status !== 'running') {
      const started = await linkDesktopViewModel.startExternalApplication('obs');
      if (isCancelled()) return;
      useIntegrationStore.getState().setProcess(started);
    }
    const connected = await linkDesktopViewModel.connectObs();
    if (isCancelled()) return;
    useIntegrationStore.getState().setObs(connected);
    if (connected.status !== 'connected') return;
    await refreshConnectedObsInventory(isCancelled);
  } catch (error) {
    if (isCancelled()) return;
    const message = `OBS 启动连接未完成：${toUserErrorMessage(error)}`;
    useIntegrationStore.getState().setObs({ status: 'disconnected', obsVersion: null, webSocketVersion: null, error: message });
    void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'obs', message }).catch(console.error);
  }
}

async function refreshConnectedObsInventory(isCancelled: () => boolean): Promise<void> {
  try {
    const inventory = await linkDesktopViewModel.readObsInventory();
    if (!isCancelled()) useIntegrationStore.getState().setInventory(inventory);
  } catch (error) {
    const message = `OBS 已连接，但场景清单读取失败：${toUserErrorMessage(error)}`;
    if (!isCancelled()) useIntegrationStore.getState().setError(message);
    void linkDesktopViewModel.recordLog({ level: 'warning', category: 'device', device: 'obs', message }).catch(console.error);
  }
}
