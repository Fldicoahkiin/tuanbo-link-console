import { useState, type ReactNode } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import type { LinkObsInventory } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { legacyAudioDeviceNotice, playerEngineLabel } from '../view-models/internal-audio-engine';
import { Button, Card, Disclosure, Field, Notice, Select } from '../ui';
import { IntegrationFooter } from './IntegrationOverview';
import { LightingPortField, MscDeviceField } from './LightingMidiSettings';
import { Ma2ConnectionSettings } from './Ma2ConnectionSettings';
import { MtcPortField } from './TimecodeSettings';
import { usePlayerConnections } from './usePlayerConnections';
import type { SettingsCategory } from './settings-navigation';

type Notify = (message: string, tone?: 'info' | 'error') => void;
type Common = { disabled: boolean; notify: Notify; onBusy: (busy: boolean) => void };

/**
 * 音频与 MIDI, laid out like P1's MIDI devices (2026-10-29 review): where the sound goes, where the
 * timecode goes and which MIDI input the player listens to; everything else under 高级.
 */
export function AudioMidiSettings({ internal, disabled, notify, onBusy, onRefreshMidi, onNavigate }: Common & {
  internal: boolean;
  onRefreshMidi: () => Promise<void>;
  onNavigate: (category: SettingsCategory) => void;
}): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const connections = usePlayerConnections({ disabled, notify, onBusy, watchDevices: internal });
  const [refreshing, setRefreshing] = useState(false);
  const { profile, audioDevices, deviceId, saving, saved, error } = connections;
  const legacy = legacyAudioDeviceNotice(profile?.internalPlayer);
  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true); onBusy(true);
    try { await onRefreshMidi(); }
    catch (failure) { notify(failure instanceof Error ? failure.message : String(failure), 'error'); }
    finally { setRefreshing(false); onBusy(false); }
  };
  return <>
    {internal ? <Card title="声音输出" description={`播放引擎：${playerEngineLabel(profile, project)}`}>
      {legacy ? <Notice tone="warning">{legacy}</Notice> : null}
      <Field label="输出设备" help={saved === 'audio' ? '已保存' : '联动台播放的音乐从这里放出来'}>{props => <Select {...props} aria-label="音乐监听设备" disabled={disabled || saving} value={deviceId} onChange={event => void connections.setAudioDevice(event.currentTarget.value)}>
        <option value="default">Windows 默认播放设备</option>
        {deviceId !== 'default' && !audioDevices.some(device => device.id === deviceId) ? <option value={deviceId}>上次选择的设备（现在找不到）</option> : null}
        {audioDevices.map(device => <option key={device.id} value={device.id}>{device.name || device.id}</option>)}
      </Select>}</Field>
    </Card> : null}
    <Card title="MIDI 接口" description={internal ? '时间码发给灯光控台；遥控输入用来从外部按键控制播放。' : '当前跟随 P1 播放：从 P1 接收时间码。'}
      actions={<Button variant="secondary" size="sm" icon={RefreshCw} loading={refreshing} disabled={disabled || refreshing} onClick={() => void refresh()}>刷新接口</Button>}>
      {internal ? <MtcPortField connections={connections} disabled={disabled} /> : <LightingPortField id="p1-mtc" disabled={disabled} notify={notify} onBusy={onBusy} />}
      {internal ? <Field label="遥控输入" help={saved === 'remote' ? '已保存' : '外接 MIDI 键盘或按键盒控制播放；不用就关闭'}>{props => <Select {...props} aria-label="播放控制 MIDI 输入" disabled={disabled || saving} value={connections.controlName} onChange={event => void connections.setControlInput(event.currentTarget.value)}>
        <option value="">关闭遥控</option>
        {connections.controlInputs.map(input => <option key={input.name} value={input.name}>{input.name}{input.available ? '' : '（当前不可用）'}</option>)}
      </Select>}</Field> : null}
      {connections.nativeError ? <Notice tone="error">Windows 设备检测失败：{connections.nativeError}</Notice> : null}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {internal ? <p>由联动台代替 P1 播放时，请先完全退出 P1（否则会占用同一个 MIDI 接口），再刷新接口。</p> : null}
      <div className="settings-actions-row"><Button variant="ghost" icon={ArrowRight} onClick={() => onNavigate('timecode')}>帧率、发送方式和每首歌的起始时间码</Button></div>
    </Card>
    <Disclosure title="高级" description={internal ? '采样率、灯光动作和操作录制用的接口' : '灯光动作和操作录制用的接口'}>
      {internal ? <Field label="采样率" help={saved === 'rate' ? '已保存' : '和声卡设置一致即可，一般用 48 kHz'}>{props => <Select {...props} aria-label="音频采样率" width="auto" disabled={disabled || saving} value={connections.audioSampleRate} onChange={event => void connections.setSampleRate(event.currentTarget.value === '44100' ? 44100 : 48000)}>
        <option value="44100">44.1 kHz</option><option value="48000">48 kHz</option>
      </Select>}</Field> : null}
      <LightingPortField id="lighting-events-output" disabled={disabled} notify={notify} onBusy={onBusy} />
      <LightingPortField id="lighting-record-input" disabled={disabled} notify={notify} onBusy={onBusy} />
    </Disclosure>
  </>;
}

/** MA2 控台: how this computer reaches the console. Reading songs from it is saved in the project. */
export function Ma2Settings({ disabled, notify, onBusy, onNavigate }: Common & { onNavigate: (category: SettingsCategory) => void }): JSX.Element {
  const method = useMa2ModeStore(state => state.method);
  const [maintenanceHost, setMaintenanceHost] = useState<HTMLDivElement | null>(null);
  const openMaintenance = (): void => {
    const details = maintenanceHost?.closest('details');
    if (details) details.open = true;
    maintenanceHost?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  return <>
    <Ma2ConnectionSettings disabled={disabled} notify={notify} maintenanceHost={maintenanceHost} onMaintenance={openMaintenance} onAudioSettings={() => onNavigate('audio')} />
    <Disclosure title="控台 MIDI 地址" description="用 MIDI 触发控台 Cue 时的 MSC 设置"><MscDeviceField disabled={disabled} notify={notify} onBusy={onBusy} /></Disclosure>
    {method !== 'midi' ? <Disclosure title="高级连接与插件维护"><div ref={setMaintenanceHost} /></Disclosure> : null}
  </>;
}

/** 程序维护: start-up settings of OBS and P1, and what the computer detected. */
export function MaintenanceSettings({ disabled, securityAvailable, children, onSave, onRefresh }: {
  disabled: boolean;
  securityAvailable: boolean;
  children: ReactNode;
  onSave: () => void;
  onRefresh: () => void;
}): JSX.Element {
  const midiPorts = useIntegrationStore(state => state.midiPorts);
  const inventory: LinkObsInventory | null = useIntegrationStore(state => state.inventory);
  return <>
    <p>预览没有画面，或联动台启动不了 OBS / P1 时，在这里处理。查看错误、导出诊断包或提交问题反馈，请到「帮助与反馈」。</p>
    {children}
    <div className="settings-actions-row">
      <Button variant="primary" disabled={disabled || !securityAvailable} onClick={onSave}>保存启动设置</Button>
      <Button variant="secondary" icon={RefreshCw} disabled={disabled} onClick={onRefresh}>重新检测程序与设备</Button>
    </div>
    <IntegrationFooter midiPorts={midiPorts} inventory={inventory} />
  </>;
}
