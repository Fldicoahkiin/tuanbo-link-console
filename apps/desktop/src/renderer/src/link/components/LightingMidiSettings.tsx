import { useEffect, useState } from 'react';
import { useIntegrationStore } from '../stores/integration-store';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { Disclosure, Field, Select, TextInput } from '../ui';

type Notify = (message: string, tone?: 'info' | 'error') => void;
export type LightingPortId = 'p1-mtc' | 'lighting-events-output' | 'lighting-record-input';

const ports: Record<LightingPortId, { label: string; name: string; direction: 'input' | 'output'; help: string }> = {
  'p1-mtc': { label: 'P1 时间码输入', name: 'P1 时间码输入', direction: 'input', help: '跟随 P1 时，从这个接口接收 P1 发来的时间码' },
  'lighting-events-output': { label: '灯光动作输出', name: '灯光事件输出端口', direction: 'output', help: '时间线上的 MIDI 灯光动作从这里发给控台' },
  'lighting-record-input': { label: '操作录制输入', name: '灯光录制反馈端口', direction: 'input', help: '录制控台推杆和按键时，从这里接收' }
};

/** One of the lighting MIDI ports, saved on this computer when chosen. */
export function LightingPortField({ id, disabled, notify, onBusy }: { id: LightingPortId; disabled: boolean; notify: Notify; onBusy: (busy: boolean) => void }): JSX.Element {
  const profile = useIntegrationStore(state => state.profile);
  const available = useIntegrationStore(state => state.midiPorts);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 2000); return () => clearTimeout(timer); }, [saved]);
  const { label, name, direction, help } = ports[id];
  const current = profile?.midiPortProfiles.find(port => port.id === id)?.portName ?? '';
  const connected = available.filter(port => port.direction === direction && port.state === 'connected').map(port => port.name);
  const save = async (portName: string): Promise<void> => {
    if (saving || disabled) return;
    setSaving(true); onBusy(true); setError('');
    const latest = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    try {
      const next = { ...latest, updatedAt: new Date().toISOString(), ...(id === 'p1-mtc' ? { p1: { ...latest.p1, mtcInputPortProfileId: id } } : {}),
        midiPortProfiles: [...latest.midiPortProfiles.filter(port => port.id !== id), ...(portName ? [{ id, direction, portName }] : [])] };
      await window.tbLink.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSaved(true);
    } catch (failure) { const message = failure instanceof Error ? failure.message : String(failure); setError(message); notify(message, 'error'); }
    finally { setSaving(false); onBusy(false); }
  };
  return <Field label={label} error={error || null} help={saved ? '已保存' : help}>{props => <Select {...props} aria-label={name} disabled={disabled || saving} value={current} onChange={event => void save(event.currentTarget.value)}>
    <option value="">未配置</option>
    {[...new Set([...connected, ...(current ? [current] : [])])].map(port => <option key={port} value={port}>{port}{connected.includes(port) ? '' : '（当前不可用）'}</option>)}
  </Select>}</Field>;
}

/** The console's MIDI Show Control device number, for triggering its Cues over MIDI. */
export function MscDeviceField({ disabled, notify, onBusy }: { disabled: boolean; notify: Notify; onBusy: (busy: boolean) => void }): JSX.Element {
  const profile = useIntegrationStore(state => state.profile);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(false), 2000); return () => clearTimeout(timer); }, [saved]);
  const saveDevice = async (input: HTMLInputElement): Promise<void> => {
    if (saving || disabled) return;
    const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    const previous = current.lighting?.mscDeviceId ?? 127; const value = input.valueAsNumber;
    if (value === previous) return;
    if (!Number.isInteger(value) || value < 0 || value > 127) { input.value = String(previous); notify('MSC 设备号应为 0–127', 'error'); return; }
    setSaving(true); onBusy(true);
    try {
      const next = { ...current, updatedAt: new Date().toISOString(), lighting: { ...current.lighting, mscDeviceId: value } };
      await window.tbLink.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSaved(true);
    } catch (failure) { input.value = String(previous); notify(failure instanceof Error ? failure.message : String(failure), 'error'); }
    finally { setSaving(false); onBusy(false); }
  };
  return <>
    <Field label="MSC 设备号" help={saved ? '已保存' : '要和控台一致，127 表示所有设备'}>{props => <TextInput {...props} aria-label="MA2 MSC 设备号" key={profile?.lighting?.mscDeviceId ?? 127} type="number" min={0} max={127}
      defaultValue={profile?.lighting?.mscDeviceId ?? 127} disabled={disabled || saving} onBlur={event => void saveDevice(event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} />}</Field>
    <Disclosure title="控台配置说明">
      <p>用 MIDI 直接触发控台上已有的 Cue，不需要网线或插件。控台设置路径：Setup → Console → Midi Show Control，MSC In Mode 选 MIDI，Command 选 General Light 或 All，Exec 选 Exec.Page。设备号要和控台一致，127 表示所有设备。联动台里填“页.执行器”，会自动转换成控台格式。</p>
    </Disclosure>
  </>;
}
