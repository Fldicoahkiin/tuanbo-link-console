import { runLinkPreflight, type PreflightMode, type PreflightReport } from '@tb/core/link';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from './link-desktop-view-model';
import { useDisplayPreferences } from '../stores/display-preferences-store';

export async function runDesktopPreflight(
  coordinator: LinkRuntimeCoordinator,
  mode: PreflightMode,
  mtcRequirement: 'running' | 'start-on-go' | 'awaiting-external-start' | 'internal',
  p1ClockObserved = false
): Promise<PreflightReport> {
  const document = useDocumentStore.getState();
  const integration = useIntegrationStore.getState();
  if (!document.project || !document.path || !integration.profile) {
    throw new Error('工程必须先保存，且集成档案必须完整加载');
  }

  coordinator.beginPreflight(mode);
  if (integration.obs.status === 'connected' && document.project.obsOutputMode === 'scenes' && document.project.mediaAssets.length) {
    await linkDesktopViewModel.prepareObsMediaScenes(document.path, document.project, useDisplayPreferences.getState().preciseSeeking);
  }
  await coordinator.initializeMidi(mtcRequirement !== 'internal');
  const [assets, security, inventory, snapshots, appInfo] = await Promise.all([
    linkDesktopViewModel.inspectProjectAssets(document.path, document.project),
    linkDesktopViewModel.getSecurityPreflight(),
    integration.obs.status === 'connected'
      ? linkDesktopViewModel.readObsInventory()
      : Promise.resolve(integration.inventory ?? emptyInventory()),
    // Auto-follow invokes this only after a real P1 sample. The established
    // connection supplies process identity/version; the sample proves liveness.
    p1ClockObserved || mtcRequirement === 'internal' ? Promise.resolve(Object.values(integration.processes)) : linkDesktopViewModel.getExternalSnapshots(),
    linkDesktopViewModel.getAppInfo()
  ]);
  useIntegrationStore.getState().setAppInfo(appInfo);
  for (const snapshot of snapshots) useIntegrationStore.getState().setProcess(snapshot);
  useIntegrationStore.getState().setInventory(inventory);
  const p1 = snapshots.find((snapshot) => snapshot.id === 'p1');
  const currentRuntime = useRuntimeStore.getState();
  const currentMidiPorts = useIntegrationStore.getState().midiPorts;
  const report = runLinkPreflight({
    mode,
    mtcRequirement,
    project: document.project,
    profile: integration.profile,
    currentItemId: currentRuntime.currentItemId,
    referenceAssets: assets.referenceAudio,
    mediaAssets: assets.media,
    obs: {
      authenticated: integration.obs.status === 'connected',
      version: integration.obs.obsVersion,
      ...inventory
    },
    midi: {
      ports: currentMidiPorts.map((port) => ({
        name: port.name,
        direction: port.direction,
        connected: port.state === 'connected'
      })),
      mtcUpdating: currentRuntime.lastMtcAt !== null && performance.now() - currentRuntime.lastMtcAt <= 500,
      mtcStable: currentRuntime.mtcStable,
      detectedFrameRate: currentRuntime.detectedFrameRate
    },
    processes: {
      p1: { running: p1?.status === 'running', version: p1?.fileVersion ?? null }
    },
    availableDiskBytes: appInfo.availableDiskBytes,
    minimumDiskBytes: 1_073_741_824,
    credentialsDecryptable: security.credentialDecryptable,
    logRedactionReady: security.logRedactionReady
  });
  for (const check of report.checks) {
    await linkDesktopViewModel.recordLog({
      level: check.status === 'blocking' ? 'error' : check.status === 'warning' ? 'warning' : 'info',
      category: 'preflight',
      message: `${check.label}：${check.detail}`,
      projectId: document.project.projectId,
      ...(currentRuntime.currentItemId ? { itemId: currentRuntime.currentItemId } : {}),
      result: check.status === 'blocking' ? 'failed' : 'succeeded'
    });
  }
  if (report.passed) {
    const profile = {
      ...integration.profile,
      updatedAt: new Date().toISOString(),
      lastSuccessfulPreflight: {
        checkedAt: report.checkedAt,
        applicationVersion: appInfo.version,
        mode: report.mode,
        checks: report.checks.map((check) => {
          if (check.status === 'blocking') throw new Error('通过的预检不能包含阻断项');
          return { id: check.id, label: check.label, status: check.status, detail: check.detail };
        })
      }
    };
    await linkDesktopViewModel.saveIntegrationProfile({ profile });
    useIntegrationStore.getState().setProfile(profile);
  }
  await coordinator.applyPreflight(report);
  return report;
}

function emptyInventory() {
  return { scenes: [], inputs: [], inputKinds: {}, inputAudioStates: {}, sceneItems: {}, filters: {}, transitions: [], sourceSizes: {} };
}
