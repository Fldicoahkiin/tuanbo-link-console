import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { FolderOpen, Link2, Power, Square } from 'lucide-react';
import type { IntegrationProfile } from '@tb/schema';
import type { LinkProcessSnapshot } from '@tb/core/link';
import type { LinkMidiAdapter } from '../../registry/link-midi-adapter';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { Button, Card, Disclosure, Field, Select, StatusBadge, TextArea, TextInput } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { portName, updatePortProfile } from '../view-models/local-integration-midi';
import { ObsPreviewSetup } from './ObsPreviewSetup';

type Notify = (message: string, tone?: 'info' | 'error') => void;
type ProgramSettingsValue = Pick<IntegrationProfile['obs'], 'arguments' | 'executablePath' | 'workingDirectory' | 'startupTimeoutMs' | 'shutdownTimeoutMs'>;

/**
 * 程序维护 (2026-10-30 rework): how OBS and, when following P1, P1 are started. Edits stay a draft
 * until 保存启动设置, which is why the page keeps them while settings are open.
 */
export function ProgramSettingsCards({ draft, setDraft, busy, runtimeActive, securityAvailable, processes, midiPorts, inventory, persistDraft, pickExecutable, startProgram, notify }: {
  draft: IntegrationProfile;
  setDraft: Dispatch<SetStateAction<IntegrationProfile>>;
  busy: boolean;
  runtimeActive: boolean;
  securityAvailable: boolean;
  processes: ReturnType<typeof useIntegrationStore.getState>['processes'];
  midiPorts: ReturnType<LinkMidiAdapter['listPorts']>;
  inventory: ReturnType<typeof useIntegrationStore.getState>['inventory'];
  persistDraft: () => Promise<IntegrationProfile>;
  pickExecutable: (id: 'obs' | 'p1') => Promise<void>;
  startProgram: (id: 'obs' | 'p1') => Promise<void>;
  notify: Notify;
}): JSX.Element {
  const internal = useDocumentStore((state) => state.project?.playbackSource === 'internal');
  const locked = busy || runtimeActive;
  const reconnectObs = (): void => void runAction(async () => {
    await persistDraft();
    useIntegrationStore.getState().setObs(await linkDesktopViewModel.connectObs());
    useIntegrationStore.getState().setInventory(await linkDesktopViewModel.readObsInventory());
  }, notify);
  return <>
    <ProgramProfileCard kind="obs" title="OBS Studio" process={processes.obs} busy={locked} settings={draft.obs} acceptedVersion={draft.acceptedVersions.obs}
      onAcceptedVersionChange={(value) => setDraft({ ...draft, acceptedVersions: { ...draft.acceptedVersions, obs: value } })}
      onSettingsChange={(settings) => setDraft({ ...draft, obs: { ...draft.obs, ...settings } })}
      onPick={() => void pickExecutable('obs')} onStart={() => void startProgram('obs')} onStop={() => void runAction(() => linkDesktopViewModel.stopExternalApplication('obs'), notify)}
      maintenanceActions={<Button variant="secondary" icon={Link2} disabled={busy || !securityAvailable} onClick={reconnectObs}>重新连接 OBS</Button>}
      task="联动台预览没有画面">
      <ObsPreviewSetup disabled={locked || !securityAvailable} notify={notify} beforeRepair={async () => { await persistDraft(); }} />
    </ProgramProfileCard>
    {!internal ? <ProgramProfileCard kind="p1" title="P1" process={processes.p1} busy={locked} settings={draft.p1} acceptedVersion={draft.acceptedVersions.p1}
      onAcceptedVersionChange={(value) => setDraft({ ...draft, acceptedVersions: { ...draft.acceptedVersions, p1: value } })}
      onSettingsChange={(settings) => setDraft({ ...draft, p1: { ...draft.p1, ...settings } })}
      onPick={() => void pickExecutable('p1')} onStart={() => void startProgram('p1')} onStop={() => void runAction(() => linkDesktopViewModel.stopExternalApplication('p1'), notify)}
      task="P1 声音与时间码">
      <MidiPortField label="旧节目 MIDI 输出" direction="output" value={portName(draft, 'lighting-output')} ports={midiPorts} disabled={locked} onChange={(value) => setDraft(updatePortProfile(draft, 'lighting-output', 'output', value))} />
      <Field label="P1 声音所在的 OBS 音频输入">{props => <Select {...props} disabled={locked} value={draft.p1.obsAudioInputName ?? ''} onChange={(event) => setDraft({ ...draft, p1: { ...draft.p1, obsAudioInputName: event.currentTarget.value } })}>
        <option value="">请选择 OBS 音频输入</option>
        {inventory?.inputs.map((inputName) => <option key={inputName} value={inputName}>{inputName}</option>)}
      </Select>}</Field>
      <Field label="预期 MTC 帧率">{props => <Select {...props} width="auto" disabled={locked} value={draft.p1.expectedFrameRate} onChange={(event) => setDraft({ ...draft, p1: { ...draft.p1, expectedFrameRate: event.currentTarget.value as IntegrationProfile['p1']['expectedFrameRate'] } })}>
        {['24', '25', '29.97df', '30'].map((rate) => <option key={rate}>{rate}</option>)}
      </Select>}</Field>
    </ProgramProfileCard> : null}
  </>;
}

function processStatus(process: LinkProcessSnapshot, title: string): ConnectionStatus {
  switch (process.status) {
    case 'running': return { state: 'ready', value: '运行中', detail: process.owned ? `${title} 由联动台启动` : `${title} 已在运行` };
    case 'starting': return { state: 'checking', value: '启动中', detail: `正在启动 ${title}` };
    case 'stopping': return { state: 'checking', value: '停止中', detail: `正在关闭 ${title}` };
    case 'error': return { state: 'error', value: '异常', detail: process.error ?? `${title} 出错了` };
    default: return { state: 'idle', value: '未运行', detail: `还没检测到 ${title}` };
  }
}

function ProgramProfileCard({ kind, title, process, busy, settings, acceptedVersion, task, onAcceptedVersionChange, onSettingsChange, onPick, onStart, onStop, maintenanceActions, children }: {
  kind: 'obs' | 'p1';
  title: string;
  process: LinkProcessSnapshot;
  busy: boolean;
  settings: ProgramSettingsValue;
  acceptedVersion: string;
  /** The problem the card's own controls solve. */
  task: string;
  onAcceptedVersionChange: (value: string) => void;
  onSettingsChange: (value: ProgramSettingsValue) => void;
  onPick: () => void;
  onStart: () => void;
  onStop: () => void;
  maintenanceActions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const description = process.owned ? '由联动台启动，可以在这里关闭' : process.status === 'running' ? '已在别处打开，请在原程序里关闭' : `还没检测到 ${title}，可以先打开它`;
  // The main process accepts only the program's own folder or one picked in its dialog.
  const pickFolder = async (): Promise<void> => {
    const folder = await linkDesktopViewModel.pickWorkingDirectory();
    if (folder) onSettingsChange({ ...settings, workingDirectory: folder });
  };
  return <Card className={`device-program-card ${kind}`} title={title} description={description} actions={<StatusBadge name={title} status={processStatus(process, title)} />}>
    <section className="settings-subsection" aria-label={task}>
      <header className="settings-subsection-header"><h3>{task}</h3></header>
      {children}
    </section>
    <Disclosure className="device-process-settings" title={`无法自动启动 ${title}？设置程序位置`}>
      <Field label="程序位置">{props => <div className="settings-path-control">
        <TextInput {...props} aria-label={`${title} 可执行文件`} value={settings.executablePath} readOnly />
        <Button variant="secondary" icon={FolderOpen} disabled={busy} onClick={onPick} aria-label={`选择 ${title} 可执行文件`}>浏览</Button>
      </div>}</Field>
      <p>选择已安装的 {title} 程序（.exe），然后保存启动设置。一般不用改下面的技术参数。</p>
      <div className="settings-actions-row">
        {maintenanceActions}
        <Button variant="secondary" icon={Power} disabled={busy} onClick={onStart}>启动或连接 {title}</Button>
        <Button variant="secondary" icon={Square} disabled={busy || !process.owned} onClick={onStop}>关闭 {title}</Button>
      </div>
      <Disclosure className="device-advanced" title="技术参数（排查启动问题时使用）">
        <Field label="启动文件夹">{props => <div className="settings-path-control">
          <TextInput {...props} aria-label="启动文件夹" value={settings.workingDirectory} readOnly />
          <Button variant="secondary" icon={FolderOpen} disabled={busy} onClick={() => void pickFolder()} aria-label={`选择 ${title} 启动文件夹`}>浏览</Button>
        </div>}</Field>
        <Field label="已测试的程序版本" help="手动记录，方便以后对照">{props => <TextInput {...props} disabled={busy} value={acceptedVersion} onChange={(event) => onAcceptedVersionChange(event.currentTarget.value)} />}</Field>
        <Field label="启动参数" help="每行一个参数，不需要时留空">{props => <TextArea {...props} aria-label={`${title} 启动参数`} rows={3} disabled={busy} value={settings.arguments.join('\n')} onChange={(event) => onSettingsChange({ ...settings, arguments: event.currentTarget.value.split(/\r?\n/).filter((argument) => argument !== '') })} />}</Field>
        <Field label="最多等待启动（秒）">{props => <TextInput {...props} disabled={busy} type="number" min="1" max="120" step="0.001" value={settings.startupTimeoutMs / 1000} onChange={(event) => onSettingsChange({ ...settings, startupTimeoutMs: Math.round(Number(event.currentTarget.value) * 1000) })} />}</Field>
        <Field label="最多等待关闭（秒）">{props => <TextInput {...props} disabled={busy} type="number" min="1" max="120" step="0.001" value={settings.shutdownTimeoutMs / 1000} onChange={(event) => onSettingsChange({ ...settings, shutdownTimeoutMs: Math.round(Number(event.currentTarget.value) * 1000) })} />}</Field>
      </Disclosure>
    </Disclosure>
  </Card>;
}

function MidiPortField({ label, direction, value, ports, disabled, onChange }: {
  label: string;
  direction: 'input' | 'output';
  value: string;
  ports: ReturnType<LinkMidiAdapter['listPorts']>;
  disabled: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  const options = ports.filter((port) => port.direction === direction && port.state === 'connected');
  return <Field label={label}>{props => <Select {...props} disabled={disabled} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
    <option value="">{options.length === 0 ? '没检测到 Windows MIDI 接口' : '请选择接口'}</option>
    {options.map((port) => <option key={port.id} value={port.name}>{port.name}{port.manufacturer ? ` · ${port.manufacturer}` : ''}</option>)}
  </Select>}</Field>;
}

async function runAction(action: () => Promise<unknown>, notify: Notify): Promise<void> {
  try { await action(); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
}
