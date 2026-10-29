import { useSettingsDirty } from '../useSettingsDirty';
import { useSettingsSessionStore } from '../stores/settings-session-store';
import { ObsPreviewSetup } from './ObsPreviewSetup';
import { Button } from './Button';
import { ObsDeviceSettings } from './ObsDeviceSettings';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { createDefaultIntegrationProfile, mergeIntegrationDraft, programDraftValues, mergeProgramSettings } from '../view-models/local-integration-profile';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AudioWaveform,
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  Link2,
  ScanSearch,
  MonitorUp,
  Power,
  ShieldCheck,
  Square,
  Wrench,
  type LucideIcon
} from 'lucide-react';
import type { IntegrationProfile } from '@tb/schema';
import { type LinkProcessSnapshot } from '@tb/core/link';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { LinkMidiAdapter, hasConnectedProfilePort } from '../../registry/link-midi-adapter';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { readAndStoreMidiPorts } from '../view-models/midi-device-inventory';
import { runDesktopPreflight } from '../view-models/link-preflight-view-model';
import { DetectionReport, useLocalIntegrationConnection } from './LocalIntegrationConnection';
import { isMtcSignalReady, portName, updatePortProfile } from '../view-models/local-integration-midi';
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
  onSettingsClose: () => void;
  onSettingsOpen: () => void;
  onCreate: () => void;
  onOpen: () => void;
};

export function IntegrationWorkspace({ quickConnectHost, midiMonitor, category, coordinator, notify, settingsOpen, onSettingsClose, onCategoryChange, onCreate, onOpen }: Props): JSX.Element {
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
  const localIntegration = useLocalIntegrationConnection({ draft, password, readMidiPorts: () => readAndStoreMidiPorts(midiMonitor), openMidiPorts: (ids, direction) => direction === 'input' ? midiMonitor.openInputs(ids) : midiMonitor.openOutputs(ids), listenToP1: async () => { if (!coordinator) throw new Error('请先打开 P1 跟随工程'); await coordinator.initializeMidi(); }, notify, onDraft: setDraft, onPasswordCleared: () => setPassword(''), onObsPassword: setPassword, onBusyChange: setBusy });
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
    if (!coordinator) return;
    setBusy(true);
    try {
      const profile = await persistDraft();
      await prepareLoopMidi(profile);
      useIntegrationStore.getState().setProcess(await linkDesktopViewModel.startExternalApplication('obs'));
      useIntegrationStore.getState().setObs(await linkDesktopViewModel.connectObs());
      useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
      if (internal) { notify('OBS 已连接，请到“工程与节目单”点击歌曲。'); return; }
      useIntegrationStore.getState().setProcess(await linkDesktopViewModel.startExternalApplication('p1'));
      await coordinator.waitForMtcInputPort(profile.p1.startupTimeoutMs);
      await coordinator.initializeMidi();
      if (useDocumentStore.getState().project?.p1AutoFollow?.enabled) {
        await coordinator.enableP1AutoFollow(() => runDesktopPreflight(coordinator, 'live', 'awaiting-external-start', true));
        notify('P1 自动监听已恢复，请直接点击 P1 歌曲。');
        return;
      }
      const report = await runDesktopPreflight(coordinator, 'live', 'awaiting-external-start');
      if (!report.passed) {
        coordinator.stop(true, '开播前检查未通过');
        notify('设备已启动，但开播前检查还有问题要处理，联动没有进入待命。', 'error');
        return;
      }
      await coordinator.armFromStart();
      notify('已待命，正在等 P1 发来 MTC 时间码，收到后才会跟随时间线。如果 P1 播放后仍显示“未发送”，请检查 P1 设置里的 MIDI 输出设备。');
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (<div className="page-stack integration-workspace">
      {quickConnectHost ? createPortal(<button aria-label="顶部一键连接" title={runtimeActive ? '请先停止播放，再连接全部设备' : '按顺序连接已启用的设备，某一步没通过就会停下，后面的步骤不再执行'} disabled={busy || runtimeActive} onClick={localIntegration.connect}><ScanSearch />{connectionProgress.running ? `连接中 ${connectionProgress.completed}/${connectionProgress.total}` : busy ? '处理中…' : '一键连接'}</button>, quickConnectHost) : null}
      {settingsOpen ? <IntegrationSettingsDialog
        key={revision} category={category} onNavigate={onCategoryChange} onCreate={onCreate} onOpen={onOpen} onBusy={setBusy} busy={busy} runtimeActive={runtimeActive} securityAvailable={securityAvailable} nestedDialogOpen={false}
        midiPorts={midiPorts} inventory={inventory} notify={notify}
        onRefresh={() => void refresh()} onSave={() => void save()} onRefreshMidi={async () => { await readAndStoreMidiPorts(midiMonitor); }}
        onClose={onSettingsClose}
        songTools={<div className="p1-follow-settings">
      {internal ? null : <IntegrationHero
        busy={busy} securityAvailable={securityAvailable} coordinatorAvailable={coordinator !== null}
        currentItemTitle={currentItemTitle} runtimeState={runtimeState}
        obsReady={obs.status === 'connected'} p1Ready={processes.p1.status === 'running'}
        mtcReady={mtcReady}
        onLaunch={() => void launchSequence()} onStop={() => stopRuntime(coordinator, runtimeState, notify)}
      />}
      <P1ProjectSyncPanel heading={false} disabled={runtimeActive} notify={notify} />
      {/* P1's timecode matters only while following P1; under the internal player it is not expected (2026-10-28, picture 4). */}
      {internal ? null : autoFollowEnabled && runtimeState !== 'error' && mtcPortAvailable && !mtcReady
        ? <section className="security-banner attention"><div><strong>等待 P1 播放或继续</strong><p>P1 暂停或停止时不会发送时间码，时间线和视频停在当前位置。直接在 P1 里继续、重播或切歌即可，不用重新选择节目。</p></div></section>
        : <P1MtcSetupNotice ready={mtcReady} portAvailable={mtcPortAvailable} />}
      {!securityAvailable ? <section className="security-banner blocked"><span className="banner-symbol"><ShieldCheck /></span><div><strong>Windows 安全存储不可用</strong><p>暂时无法保存 OBS 密码，也无法连接 OBS。</p></div></section> : null}
      {localIntegration.detection ? <DetectionReport detection={localIntegration.detection} issues={localIntegration.issues} /> : null}
      </div>}
        maintenance={<>
        <ProgramSettingsCards
          draft={draft} setDraft={setDraft} password={password} setPassword={setPassword} busy={busy} runtimeActive={runtimeActive}
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

function ProgramSettingsCards({ draft, setDraft, busy, runtimeActive, securityAvailable, processes, midiPorts, inventory, persistDraft, pickExecutable, startProgram, notify }: {
  draft: IntegrationProfile;
  setDraft: React.Dispatch<React.SetStateAction<IntegrationProfile>>;
  password: string;
  setPassword: (value: string) => void;
  busy: boolean;
  runtimeActive: boolean;
  securityAvailable: boolean;
  processes: ReturnType<typeof useIntegrationStore.getState>['processes'];
  midiPorts: ReturnType<LinkMidiAdapter['listPorts']>;
  inventory: ReturnType<typeof useIntegrationStore.getState>['inventory'];
  persistDraft: () => Promise<IntegrationProfile>;
  pickExecutable: (id: 'obs' | 'p1') => Promise<void>;
  startProgram: (id: 'obs' | 'p1') => Promise<void>;
  notify: Props['notify'];
}): JSX.Element {
  const internal = useDocumentStore((state) => state.project?.playbackSource === 'internal');
  return <fieldset className="device-program-list" disabled={runtimeActive}>
    <ProgramProfileCard kind="obs" icon={MonitorUp} title="OBS Studio" process={processes.obs} busy={busy || runtimeActive} settings={draft.obs} acceptedVersion={draft.acceptedVersions.obs} onAcceptedVersionChange={(value) => setDraft({ ...draft, acceptedVersions: { ...draft.acceptedVersions, obs: value } })} onSettingsChange={(settings) => setDraft({ ...draft, obs: { ...draft.obs, ...settings } })} onPick={() => void pickExecutable('obs')} onStart={() => void startProgram('obs')} onStop={() => void runAction(() => linkDesktopViewModel.stopExternalApplication('obs'), notify)} maintenanceActions={<Button className="secondary-button" disabled={busy || !securityAvailable} onClick={() => void runAction(async () => { await persistDraft(); useIntegrationStore.getState().setObs(await linkDesktopViewModel.connectObs()); useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory()); }, notify)}><Link2 />重新连接 OBS</Button>}>
      <ObsPreviewSetup disabled={busy || runtimeActive || !securityAvailable} notify={notify} beforeRepair={async () => { await persistDraft(); }} />
    </ProgramProfileCard>
    {!internal ? <ProgramProfileCard kind="p1" icon={AudioWaveform} title="P1" process={processes.p1} busy={busy || runtimeActive} settings={draft.p1} acceptedVersion={draft.acceptedVersions.p1} onAcceptedVersionChange={(value) => setDraft({ ...draft, acceptedVersions: { ...draft.acceptedVersions, p1: value } })} onSettingsChange={(settings) => setDraft({ ...draft, p1: { ...draft.p1, ...settings } })} onPick={() => void pickExecutable('p1')} onStart={() => void startProgram('p1')} onStop={() => void runAction(() => linkDesktopViewModel.stopExternalApplication('p1'), notify)}>
      <MidiPortField label="旧节目 MIDI 输出" direction="output" value={portName(draft, 'lighting-output')} ports={midiPorts} onChange={(value) => setDraft(updatePortProfile(draft, 'lighting-output', 'output', value))} />
      <Field label="P1 声音所在的 OBS 音频输入"><select value={draft.p1.obsAudioInputName ?? ''} onChange={(event) => setDraft({ ...draft, p1: { ...draft.p1, obsAudioInputName: event.currentTarget.value } })}><option value="">请选择 OBS 音频输入</option>{inventory?.inputs.map((inputName) => <option key={inputName} value={inputName}>{inputName}</option>)}</select></Field>
      <Field label="预期 MTC 帧率"><select value={draft.p1.expectedFrameRate} onChange={(event) => setDraft({ ...draft, p1: { ...draft.p1, expectedFrameRate: event.currentTarget.value as IntegrationProfile['p1']['expectedFrameRate'] } })}>{['24', '25', '29.97df', '30'].map((rate) => <option key={rate}>{rate}</option>)}</select></Field>
    </ProgramProfileCard> : null}
  </fieldset>;
}

function stopRuntime(coordinator: LinkRuntimeCoordinator | null, runtimeState: string, notify: Props['notify']): void {
  if (!coordinator || runtimeState === 'idle' || runtimeState === 'stopping') return;
  coordinator.stop();
  notify('正在停止联动，并清理联动台在 OBS 里创建的输出。');
}

function P1MtcSetupNotice({ ready, portAvailable }: { ready: boolean; portAvailable: boolean }): JSX.Element {
  return <section className={`security-banner ${ready ? 'ok' : 'attention'}`}><span className="banner-symbol">{ready ? <CheckCircle2 /> : <CircleAlert />}</span><div><strong>{ready ? 'MTC 已连接' : portAvailable ? 'MIDI 端口可用，但没有收到连续的 MTC' : '还没收到 P1 的 MTC'}</strong><p>{ready ? '时间码正常，帧率一致。' : '没有收到时间码，OBS 不会跟随时间线。请确认 P1 显示“已发送”，并且 P1 设置里选了 MIDI 输出设备；只建好虚拟端口还不够。'}</p></div></section>;
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

type ProgramSettingsValue = Pick<
  IntegrationProfile['obs'],
  'arguments' | 'executablePath' | 'workingDirectory' | 'startupTimeoutMs' | 'shutdownTimeoutMs'
>;

function ProgramProfileCard({ kind, icon: Icon, title, process, busy, settings, acceptedVersion, onAcceptedVersionChange, onSettingsChange, onPick, onStart, onStop, maintenanceActions, children }: {
  kind: 'obs' | 'p1';
  icon: LucideIcon;
  title: string;
  process: LinkProcessSnapshot;
  busy: boolean;
  settings: ProgramSettingsValue;
  acceptedVersion: string;
  onAcceptedVersionChange: (value: string) => void;
  onSettingsChange: (value: ProgramSettingsValue) => void;
  onPick: () => void;
  onStart: () => void;
  onStop: () => void;
  maintenanceActions?: React.ReactNode;
  children?: React.ReactNode;
}): JSX.Element {
  return <section className={`device-program-card ${kind}`}>
    <div className="device-program-heading">
      <div className={`device-program-icon ${kind}`}><Icon /></div>
      <div className="device-program-identity"><span><h3>{title}</h3><StatusPill state={process.status} /></span><p>{process.owned ? '由联动台启动，可在这里关闭' : process.status === 'running' ? <><CheckCircle2 />已在其他位置打开，请在原程序中关闭</> : `还没检测到 ${title}，可以先打开它`}</p></div>
    </div>
    {children ? <div className="program-maintenance-task"><h4>{kind === 'obs' ? '联动台预览没有画面' : 'P1 声音与时间码'}</h4><div className="form-grid">{children}</div></div> : null}
    <details className="device-process-settings"><summary><Wrench />无法自动启动 {title}？设置程序位置</summary><DeviceProcessSettings title={title} process={process} busy={busy} settings={settings} acceptedVersion={acceptedVersion} onAcceptedVersionChange={onAcceptedVersionChange} onSettingsChange={onSettingsChange} onPick={onPick} onStart={onStart} onStop={onStop} maintenanceActions={maintenanceActions} /></details>
  </section>;
}

function DeviceProcessSettings({ title, process, busy, settings, acceptedVersion, onAcceptedVersionChange, onSettingsChange, onPick, onStart, onStop, maintenanceActions }: {
  title: string;
  process: LinkProcessSnapshot;
  busy: boolean;
  settings: ProgramSettingsValue;
  acceptedVersion: string;
  onAcceptedVersionChange: (value: string) => void;
  onSettingsChange: (value: ProgramSettingsValue) => void;
  onPick: () => void;
  onStart: () => void;
  onStop: () => void;
  maintenanceActions?: React.ReactNode;
}) {
  // The main process accepts only the program's own folder or one picked in its dialog.
  const pickFolder = async (): Promise<void> => {
    const folder = await linkDesktopViewModel.pickWorkingDirectory();
    if (folder) onSettingsChange({ ...settings, workingDirectory: folder });
  };
  return <div className="device-process-fields">
    <label className="settings-row"><span>程序位置</span><div className="device-path-control"><input aria-label={`${title} 可执行文件`} value={settings.executablePath} readOnly /><button disabled={busy} onClick={onPick} aria-label={`选择 ${title} 可执行文件`}><FolderOpen />浏览</button></div></label>
    <p className="settings-note">选择已安装的 {title} 程序（.exe），然后保存启动设置。一般不需要修改下面的技术参数。</p>
    <div className="device-panel-actions">{maintenanceActions}<Button className="secondary-button" disabled={busy} onClick={onStart}><Power />启动或连接 {title}</Button><Button className="secondary-button" disabled={busy || !process.owned} onClick={onStop}><Square />关闭 {title}</Button></div>
    <details className="device-advanced"><summary>技术参数（排查启动问题时使用）</summary><div className="device-process-fields">
    <Field label="启动文件夹"><div className="device-path-control"><input aria-label="启动文件夹" value={settings.workingDirectory} readOnly /><button disabled={busy} onClick={() => void pickFolder()} aria-label={`选择 ${title} 启动文件夹`}><FolderOpen />浏览</button></div></Field>
    <Field label="已测试的程序版本（手动记录）"><input disabled={busy} value={acceptedVersion} onChange={(event) => onAcceptedVersionChange(event.currentTarget.value)} /></Field>
    <Field label="启动参数"><textarea aria-label={`${title} 启动参数`} placeholder="每行一个参数，无需参数时留空" disabled={busy} value={settings.arguments.join('\n')} onChange={(event) => onSettingsChange({ ...settings, arguments: event.currentTarget.value.split(/\r?\n/).filter((argument) => argument !== '') })} /></Field>
    <Field label="最多等待启动（秒）"><input disabled={busy} type="number" min="1" max="120" step="0.001" value={settings.startupTimeoutMs / 1000} onChange={(event) => onSettingsChange({ ...settings, startupTimeoutMs: Math.round(Number(event.currentTarget.value) * 1000) })} /></Field>
    <Field label="最多等待关闭（秒）"><input disabled={busy} type="number" min="1" max="120" step="0.001" value={settings.shutdownTimeoutMs / 1000} onChange={(event) => onSettingsChange({ ...settings, shutdownTimeoutMs: Math.round(Number(event.currentTarget.value) * 1000) })} /></Field>
    </div></details>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function StatusPill({ state }: { state: string }): JSX.Element {
  const ok = state === 'running' || state === 'connected';
  const bad = state === 'error' || state === 'disconnected';
  return <span className={`status-pill ${ok ? 'ok' : bad ? 'error' : 'pending'}`}>{statusLabel(state)}</span>;
}

function statusLabel(state: string): string {
  if (state === 'running') return '运行中';
  if (state === 'connected') return '已连接';
  if (state === 'starting') return '启动中';
  if (state === 'connecting') return '连接中';
  if (state === 'reconnecting') return '重连中';
  if (state === 'stopping') return '停止中';
  if (state === 'disconnected') return '未连接';
  if (state === 'notRunning') return '未运行';
  if (state === 'error') return '异常';
  return state;
}

function MidiPortField({ label, direction, value, ports, onChange }: {
  label: string;
  direction: 'input' | 'output';
  value: string;
  ports: ReturnType<LinkMidiAdapter['listPorts']>;
  onChange: (value: string) => void;
}): JSX.Element {
  const options = ports.filter((port) => port.direction === direction && port.state === 'connected');
  return <Field label={label}>
    <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">{options.length === 0 ? '未检测到 Windows MIDI 端口' : '请选择端口'}</option>
      {options.map((port) => <option key={port.id} value={port.name}>{port.name}{port.manufacturer ? ` · ${port.manufacturer}` : ''}</option>)}
    </select>
  </Field>;
}

async function runAction(action: () => Promise<unknown>, notify: Props['notify']): Promise<void> {
  try {
    await action();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function saveProgramSettings(draft: IntegrationProfile): Promise<IntegrationProfile> {
  const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
  const next = mergeProgramSettings(current, draft);
  await linkDesktopViewModel.saveIntegrationProfile({ profile: next });
  useIntegrationStore.getState().setProfile(next);
  return next;
}
