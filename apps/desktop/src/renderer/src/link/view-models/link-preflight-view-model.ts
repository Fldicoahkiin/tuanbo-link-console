import { collectCueMidiOutputProfileIds, expectedMa2Shows, runLinkPreflight, type PreflightMode, type PreflightReport } from '@tb/core/link';
import { ma2NetworkStatusSchema } from '@tb/schema';
import { readMa2Method } from '../stores/ma2-mode-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from './link-desktop-view-model';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { requireOutputLicense } from '../../registry/license-output';

export async function runDesktopPreflight(
  coordinator: LinkRuntimeCoordinator,
  mode: PreflightMode,
  mtcRequirement: 'running' | 'start-on-go' | 'awaiting-external-start' | 'internal',
  p1ClockObserved = false,
  options: { internalMtcOutputEnabled?: boolean } = {},
  assertCurrent: () => void = () => undefined
): Promise<PreflightReport> {
  const document = useDocumentStore.getState();
  const integration = useIntegrationStore.getState();
  if (!document.project) throw new Error('尚未加载工程，请打开已有工程');
  if (!document.path) throw new Error('当前工程尚未保存，请先保存工程再播放');
  if (!integration.profile) throw new Error(integration.error ?? '连接配置尚未加载，请在设置中检查 OBS 与 MIDI 连接配置');
  await requireOutputLicense();
  assertCurrent();

  coordinator.beginPreflight(mode);
  const selectedId = useRuntimeStore.getState().currentItemId;
  const rundown = mtcRequirement === 'internal' ? document.project.rundown.filter((item) => item.id === selectedId) : document.project.rundown;
  const mediaIds = new Set(rundown.flatMap((item) => item.referenceMediaClips.map((clip) => clip.assetId)));
  const inspectedProject = mtcRequirement === 'internal' ? { ...document.project, rundown, mediaAssets: document.project.mediaAssets.filter((asset) => mediaIds.has(asset.id)) } : document.project;
  if (integration.obs.status === 'connected' && inspectedProject.obsOutputMode === 'scenes' && inspectedProject.mediaAssets.length) {
    await linkDesktopViewModel.prepareObsMediaScenes(document.path, inspectedProject, useDisplayPreferences.getState().preciseSeeking);
    assertCurrent();
  }
  const needsMidi = mtcRequirement !== 'internal'
    || (options.internalMtcOutputEnabled !== false && Boolean(integration.profile.internalPlayer?.mtcOutputPortProfileId))
    || collectCueMidiOutputProfileIds(inspectedProject).length > 0;
  if (needsMidi) await coordinator.initializeMidi(mtcRequirement !== 'internal');
  assertCurrent();
  const [assets, security, inventory, snapshots, appInfo] = await Promise.all([
    linkDesktopViewModel.inspectProjectAssets(document.path, inspectedProject),
    linkDesktopViewModel.getSecurityPreflight(),
    integration.obs.status === 'connected'
      ? linkDesktopViewModel.readObsInventory()
      : Promise.resolve(integration.inventory ?? emptyInventory()),
    // Auto-follow invokes this only after a real P1 sample. The established
    // connection supplies process identity/version; the sample proves liveness.
    p1ClockObserved || mtcRequirement === 'internal' ? Promise.resolve(Object.values(integration.processes)) : linkDesktopViewModel.getExternalSnapshots(),
    linkDesktopViewModel.getAppInfo()
  ]);
  assertCurrent();
  // Cue numbers are only meaningful in the show they were read from.
  const project = document.project;
  const ma2Show = readMa2Method() === 'network' && rundown.some(item => expectedMa2Shows(project, item.id).length > 0)
    && ma2NetworkStatusSchema.parse(await linkDesktopViewModel.getMa2NetworkStatus()).state === 'connected'
    ? await linkDesktopViewModel.getMa2CurrentShow() : undefined;
  assertCurrent();
  useIntegrationStore.getState().setAppInfo(appInfo);
  for (const snapshot of snapshots) useIntegrationStore.getState().setProcess(snapshot);
  useIntegrationStore.getState().setInventory(inventory);
  const p1 = snapshots.find((snapshot) => snapshot.id === 'p1');
  const currentRuntime = useRuntimeStore.getState();
  const currentMidiPorts = useIntegrationStore.getState().midiPorts;
  const report = runLinkPreflight({
    mode,
    mtcRequirement,
    ...options,
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
    logRedactionReady: security.logRedactionReady,
    ...(ma2Show !== undefined ? { ma2Show } : {})
  });
  for (const check of report.checks) {
    assertCurrent();
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
    assertCurrent();
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
    assertCurrent();
    useIntegrationStore.getState().setProfile(profile);
  }
  assertCurrent(); await coordinator.applyPreflight(report); assertCurrent();
  return report;
}

function emptyInventory() {
  return { scenes: [], inputs: [], inputKinds: {}, inputAudioStates: {}, sceneItems: {}, filters: {}, transitions: [], sourceSizes: {} };
}
