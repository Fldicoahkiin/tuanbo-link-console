import { useEffect, useState } from 'react';
import { useIntegrationStore } from '../stores/integration-store';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';

export function LightingMidiSettings({ disabled, notify, onBusy, maintenance = false, follow = false }: { follow?: boolean; maintenance?: boolean; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void }): JSX.Element {
  const profile = useIntegrationStore((state) => state.profile);
  const ports = useIntegrationStore((state) => state.midiPorts);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(''), 2000); return () => clearTimeout(timer); }, [saved]);
  const [saving, setSaving] = useState(false);
  const saveDevice = async (input: HTMLInputElement): Promise<void> => {
    if (saving || disabled) return;
    const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    const previous = current.lighting?.mscDeviceId ?? 127; const value = input.valueAsNumber;
    if (value === previous) return;
    if (!Number.isInteger(value) || value < 0 || value > 127) { input.value = String(previous); notify('MSC 设备号应为 0–127', 'error'); return; }
    setSaving(true); onBusy(true);
    try {
      const next = { ...current, updatedAt: new Date().toISOString(), lighting: { ...current.lighting, mscDeviceId: value } };
      await window.tbLink.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSaved('device');
    } catch (error) { input.value = String(previous); notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setSaving(false); onBusy(false); }
  };
  const save = async (id: string, direction: 'input' | 'output', portName: string): Promise<void> => {
    if (saving || disabled) return; setSaving(true); onBusy(true); setError('');
    const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    try {
      const next = { ...current, updatedAt: new Date().toISOString(), ...(id === 'p1-mtc' ? { p1: { ...current.p1, mtcInputPortProfileId: id } } : {}), midiPortProfiles: [...current.midiPortProfiles.filter((port) => port.id !== id), ...(portName ? [{ id, direction, portName }] : [])] };
      await window.tbLink.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSaved(id);
    } catch (failure) { const message = failure instanceof Error ? failure.message : String(failure); setError(message); notify(message, 'error'); }
    finally { setSaving(false); onBusy(false); }
  };
  return <div className="lighting-midi-settings">
    {!maintenance && (follow ? ['p1-mtc', 'lighting-events-output', 'lighting-record-input'] : ['lighting-events-output', 'lighting-record-input']).map((id) => {
      const direction = id === 'lighting-events-output' ? 'output' : 'input';
      const current = profile?.midiPortProfiles.find((port) => port.id === id)?.portName ?? '';
      const names = [...new Set([...ports.filter((port) => port.direction === direction && port.state === 'connected').map((port) => port.name), ...(current ? [current] : [])])];
      return <label className="settings-row" key={id}><span>{id === 'p1-mtc' ? 'P1 时间码输入' : direction === 'output' ? '灯光动作输出' : '操作录制输入'}</span><select aria-label={id === 'p1-mtc' ? 'P1 时间码输入' : direction === 'output' ? '灯光事件输出端口' : '灯光录制反馈端口'} disabled={disabled || saving} value={current} onChange={(event) => void save(id, direction, event.target.value)}><option value="">未配置</option>{names.map((name) => <option key={name}>{name}</option>)}</select>{saved === id ? <small className="field-save-status" role="status">已保存</small> : null}</label>;
    })}
    {maintenance ? <section className="settings-section ma2-settings-group"><h3>控台 MIDI 地址</h3><label className="settings-row"><span>MSC 设备号</span><input aria-label="MA2 MSC 设备号" key={profile?.lighting?.mscDeviceId ?? 127} type="number" min={0} max={127} defaultValue={profile?.lighting?.mscDeviceId ?? 127} disabled={disabled || saving} onBlur={(event) => void saveDevice(event.currentTarget)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label><details className="ma2-operation-help"><summary>控台配置说明</summary><p className="settings-note">用于直接触发控台已有 Cue，不依赖网线或插件。控台 Setup → Console → Midi Show Control：MSC In Mode 选 MIDI，Command 选 General Light 或 All，Exec 选 Exec.Page。设备号与接收端一致；127 为全部设备。联动台填写“页.执行器”，会自动转为控台格式。</p></details></section> : null}{error ? <p role="alert" className="device-error">{error}</p> : null}
  </div>;
}
