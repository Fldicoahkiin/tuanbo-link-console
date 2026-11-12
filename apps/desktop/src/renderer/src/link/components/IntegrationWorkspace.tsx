import { useSettingsDirty } from '../useSettingsDirty';
import { useSettingsSessionStore } from '../stores/settings-session-store';
import { Button, Notice } from '../ui';
import { ProgramSettingsCards } from './ProgramMaintenanceSettings';
import { ObsDeviceSettings } from './ObsDeviceSettings';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { createDefaultIntegrationProfile, mergeIntegrationDraft, programDraftValues, mergeProgramSettings } from '../view-models/local-integration-profile';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ScanSearch } from 'lucide-react';
import type { IntegrationProfile } from '@tb/schema';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { LinkMidiAdapter, hasConnectedProfilePort } from '../../registry/link-midi-adapter';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { readAndStoreMidiPorts } from '../view-models/midi-device-inventory';
import { runDesktopPreflight } from '../view-models/link-preflight-view-model';
import { checkingP1Follow, followP1, p1FollowClient } from '../stores/p1-follow-store';
import { toUserErrorMessage } from '@tb/core/link';
import { DetectionReport, useLocalIntegrationConnection } from './LocalIntegrationConnection';
import { isMtcSignalReady } from '../view-models/local-integration-midi';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { IntegrationHero } from './IntegrationOverview';
import { type SettingsCategory } from './settings-navigation';
import { IntegrationSettingsDialog } from './IntegrationSettings';
import { prepareLoopMidi } from '../view-models/loop-midi';

type Props = {
  quickConnectHost: HTMLDivElement | null;
  midiMonitor: LinkMidiAdapter;
  category: SettingsCategory;
  onCategoryChange: (category: SettingsCategory) => void;
  coordinator: LinkRuntimeCoordinator | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  settingsOpen: boolean;
  onSettingsOpen: () => void;
  onCreate: () => void;
  onOpen: () => void;
};

export function IntegrationWorkspace({ quickConnectHost, midiMonitor, category, coordinator, notify, settingsOpen, onCategoryChange, onCreate, onOpen }: Props): JSX.Element {
  const revision = useSettingsSessionStore(state => state.revision);
  const storedProfile = useIntegrationStore((state) => state.profile);
  const securityAvailable = useIntegrationStore((state) => state.securityAvailable);
  const obs = useIntegrationStore((state) => state.obs);
  const inventory = useIntegrationStore((state) => state.inventory);
  const processes = useIntegrationStore((state) => state.processes);
  const midiPorts = useIntegrationStore((state) => state.midiPorts);
  const runtimeState = useRuntimeStore((state) => state.state); const currentItemId = useRuntimeStore((state) => state.currentItemId);
  const currentItemTitle = useDocumentStore((state) => state.project?.rundown.find((item) => item.id === currentItemId)?.title ?? null);
  const autoFollowEnabled = useDocumentStore((state) => state.project?.p1AutoFollow?.enabled === true);
  const internal = useDocumentStore((state) => state.project?.playbackSource === 'internal');
  const [draft, setDraft] = useState<IntegrationProfile>(() => storedProfile ?? createDefaultIntegrationProfile());
  const draftBaseline = useRef(draft);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useSettingsDirty('programs', settingsOpen && JSON.stringify(programDraftValues(draft)) !== JSON.stringify(programDraftValues(storedProfile ?? createDefaultIntegrationProfile())));
  useEffect(() => { if (!settingsOpen) { const profile = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile(); setDraft(profile); draftBaseline.current = profile; setPassword(''); } }, [settingsOpen]);
  const connectionProgress = useConnectionCheckStore();
  const localIntegration = useLocalIntegrationConnection({ draft, password, readMidiPorts: () => readAndStoreMidiPorts(midiMonitor), openMidiPorts: (ids, direction) => direction === 'input' ? midiMonitor.openInputs(ids) : midiMonitor.openOutputs(ids), listenToP1: async () => { await followP1(); }, notify, onDraft: setDraft, onPasswordCleared: () => setPassword(''), onObsPassword: setPassword, onBusyChange: setBusy });
  const lastMtcAt = useRuntimeStore((state) => state.lastMtcAt);
  const mtcStable = useRuntimeStore((state) => state.mtcStable);
  const detectedFrameRate = useRuntimeStore((state) => state.detectedFrameRate);
  const now = useSettingsMtcClock(!internal && settingsOpen);
  const mtcPortAvailable = hasConnectedProfilePort(draft, draft.p1.mtcInputPortProfileId, midiPorts);
  const mtcReady = isMtcSignalReady({ portConnected: mtcPortAvailable, stable: mtcStable, lastMtcAt, now, detectedFrameRate, expectedFrameRate: draft.p1.expectedFrameRate });
  const runtimeActive = runtimeState !== 'idle';
  useEffect(() => {
    if (!storedProfile) return;
    const previous = draftBaseline.current;
    draftBaseline.current = storedProfile;
    setDraft((current) => mergeIntegrationDraft(previous, current, storedProfile));
  }, [storedProfile]);
  const persistDraft = async (): Promise<IntegrationProfile> => {
    const latest = useIntegrationStore.getState().profile;
    const next = { ...(latest ? mergeIntegrationDraft(draftBaseline.current, draft, latest) : draft), updatedAt: new Date().toISOString() };
    await linkDesktopViewModel.saveIntegrationProfile({
      profile: next,
      ...(!storedProfile || password !== '' ? { obsPassword: password } : {})
    });
    useIntegrationStore.getState().setProfile(next);
    setPassword('');
    return next;
  };
  const persistPrograms = (): Promise<IntegrationProfile> => saveProgramSettings(draft);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await persistPrograms();
      notify('启动设置已保存到本机。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const pickExecutable = async (id: 'obs' | 'p1'): Promise<void> => {
    const path = await linkDesktopViewModel.pickExecutable();
    if (!path) return;
    const workingDirectory = path.slice(0, Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')));
    if (id === 'obs') setDraft((value) => ({ ...value, obs: { ...value.obs, executablePath: path, workingDirectory } }));
    else setDraft((value) => ({ ...value, p1: { ...value.p1, executablePath: path, workingDirectory } }));
  };
  const refresh = async (): Promise<void> => {
    try {
      const snapshots = await Promise.all((['obs', 'p1'] as const).map((id) => linkDesktopViewModel.refreshExternalApplication(id)));
      for (const snapshot of snapshots) useIntegrationStore.getState().setProcess(snapshot);
      await readAndStoreMidiPorts(midiMonitor);
      if (obs.status === 'connected') useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
      notify('已刷新外部程序、OBS 内容和 MIDI 端口状态。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  const startProgram = async (id: 'obs' | 'p1'): Promise<void> => {
    setBusy(true);
    try {
      await persistPrograms();
      const snapshot = await linkDesktopViewModel.startExternalApplication(id);
      useIntegrationStore.getState().setProcess(snapshot);
      notify(`${id} 已启动或已连接。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  const launchSequence = async (): Promise<void> => {
    setBusy(true);
    try {
      const profile = await persistDraft();
      await prepareLoopMidi(profile);
      useIntegrationStore.getState().setProcess(await linkDesktopViewModel.startExternalApplication('obs'));
      useIntegrationStore.getState().setObs(await linkDesktopViewModel.connectObs());
      useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
      if (internal) { notify('OBS 已连接，请到“工程与节目单”点击歌曲。'); return; }
      useIntegrationStore.getState().setProcess(await linkDesktopViewModel.startExternalApplication('p1'));
      await midiMonitor.waitForConnectedInput(profile.p1.mtcInputPortProfileId, profile.p1.startupTimeoutMs, ports => useIntegrationStore.getState().setMidiPorts(ports));
      // The main process takes P1's timecode from here (0.5.9 P4); auto-follow listens for P1's song right away.
      await followP1();
      if (useDocumentStore.getState().project?.p1AutoFollow?.enabled) {
        notify('P1 自动监听已恢复，请直接点击 P1 歌曲。');
        return;
      }
      const report = await checkingP1Follow(() => runDesktopPreflight(midiMonitor, 'live', 'awaiting-external-start'));
      if (!report.passed) {
        notify('设备已启动，但开播前检查还有问题要处理，联动没有进入待命。', 'error');
        return;
      }
      const itemId = useRuntimeStore.getState().currentItemId;
      if (!itemId) throw new Error('还没设置当前节目，请先到节目单里选一首');
      await p1FollowClient().arm(itemId);
      notify('已待命，正在等 P1 发来 MTC 时间码，收到后才会跟随时间线。如果 P1 播放后仍显示“未发送”，请检查 P1 设置里的 MIDI 输出设备。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (<div className="settings-content">
      {quickConnectHost ? createPortal(<Button variant="primary" icon={ScanSearch} aria-label="顶部一键连接" title={runtimeActive ? '请先停止播放，再连接全部设备' : '按顺序连接已启用的设备，某一步没通过就会停下，后面的步骤不再执行'} disabled={busy || runtimeActive} onClick={localIntegration.connect}>{connectionProgress.running ? `连接中 ${connectionProgress.completed}/${connectionProgress.total}` : busy ? '处理中…' : '一键连接'}</Button>, quickConnectHost) : null}
      {settingsOpen ? <IntegrationSettingsDialog
        key={revision} category={category} onNavigate={onCategoryChange} onCreate={onCreate} onOpen={onOpen} onBusy={setBusy} busy={busy} runtimeActive={runtimeActive} securityAvailable={securityAvailable}
        notify={notify}
        onRefresh={() => void refresh()} onSave={() => void save()} onRefreshMidi={async () => { await readAndStoreMidiPorts(midiMonitor); }}
        songTools={<div className="settings-stack">
      {internal ? null : <IntegrationHero
        busy={busy} securityAvailable={securityAvailable} coordinatorAvailable={coordinator !== null}
        currentItemTitle={currentItemTitle} runtimeState={runtimeState}
        obsReady={obs.status === 'connected'} p1Ready={processes.p1.status === 'running'}
        mtcReady={mtcReady}
        onLaunch={() => void launchSequence()} onStop={() => stopRuntime(runtimeState, notify)}
      />}
      <P1ProjectSyncPanel heading={false} disabled={runtimeActive} notify={notify} />
      {/* P1's timecode matters only while following P1; under the internal player it is not expected (2026-10-28, picture 4). */}
      {internal ? null : autoFollowEnabled && runtimeState !== 'error' && mtcPortAvailable && !mtcReady
        ? <Notice title="等待 P1 播放或继续">P1 暂停或停止时不会发送时间码，时间线和视频停在当前位置。直接在 P1 里继续、重播或切歌就行，不用重新选择节目。</Notice>
        : <P1MtcSetupNotice ready={mtcReady} portAvailable={mtcPortAvailable} />}
      {localIntegration.detection ? <DetectionReport detection={localIntegration.detection} issues={localIntegration.issues} /> : null}
      </div>}
        maintenance={<>
        <ProgramSettingsCards
          draft={draft} setDraft={setDraft} busy={busy} runtimeActive={runtimeActive}
          securityAvailable={securityAvailable} processes={processes} midiPorts={midiPorts} inventory={inventory}
          persistDraft={persistPrograms} pickExecutable={pickExecutable} startProgram={startProgram} notify={notify}
        />
        </>}
      >
        <ObsDeviceSettings notify={notify} onBusy={setBusy} url={draft.obs.webSocketUrl} password={password} onUrl={(webSocketUrl) => setDraft((value) => ({ ...value, obs: { ...value.obs, webSocketUrl } }))} onPassword={setPassword} disabled={busy || runtimeActive || !securityAvailable} />

      </IntegrationSettingsDialog> : null}
    </div>
  );
}

/** Stops following P1 (the main process switches this song's lights off); P1 itself plays on. */
function stopRuntime(runtimeState: string, notify: Props['notify']): void {
  if (runtimeState === 'idle' || runtimeState === 'stopping') return;
  notify('正在停止跟随 P1，并关掉这首歌用到的灯光。OBS 的画面停在这一帧，下一首歌的画面接上时再换。P1 自己不会停。');
  void p1FollowClient().stop().catch((error: unknown) => notify(`没能停止跟随 P1：${toUserErrorMessage(error)}`, 'error'));
}

function P1MtcSetupNotice({ ready, portAvailable }: { ready: boolean; portAvailable: boolean }): JSX.Element {
  return <Notice tone={ready ? 'success' : 'warning'} title={ready ? 'MTC 已连接' : portAvailable ? 'MIDI 接口可用，但没有收到连续的 MTC' : '还没收到 P1 的 MTC'}>
    {ready ? '时间码正常，帧率一致。' : '没收到时间码，OBS 不会跟随时间线。请确认 P1 显示“已发送”，并且 P1 设置里选了 MIDI 输出设备；只建好虚拟接口还不够。'}
  </Notice>;
}

function useSettingsMtcClock(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(performance.now()), 500);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

async function saveProgramSettings(draft: IntegrationProfile): Promise<IntegrationProfile> {
  const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
  const next = mergeProgramSettings(current, draft);
  await linkDesktopViewModel.saveIntegrationProfile({ profile: next });
  useIntegrationStore.getState().setProfile(next);
  return next;
}
