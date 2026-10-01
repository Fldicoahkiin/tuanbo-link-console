import { requestMidiAccess } from '../../registry/midi-access';
import { Button } from './Button';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Play, Pause, Square, SkipBack, SkipForward, RotateCcw, Music2 } from 'lucide-react';
import { playlistItems } from '@tb/core/link';
import type { InternalPlaybackController, InternalPlayerState } from '../runtime/internal-playback-controller';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

import { ImportPlayerMusic } from './ImportPlayerMusic';

export type ProjectPlayer = { controller: InternalPlaybackController | null; state: InternalPlayerState };
type SetupProps = { locked: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; playlistId: string };
export function ProjectPlayerSetup({ locked, notify, onBusy, playlistId }: SetupProps): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  if (!project) return <></>;
  return <div className="project-player-setup"><ImportPlayerMusic disabled={locked} notify={notify} onBusy={onBusy} playlistId={playlistId} /></div>;
}
export function ProjectMusicConnections({ disabled, notify, onBusy, children }: { disabled: boolean; notify: SetupProps['notify']; onBusy: (busy: boolean) => void; children?: ReactNode }): JSX.Element {
  return <PlayerConnections disabled={disabled} notify={notify} onBusy={onBusy}>{children}</PlayerConnections>;
}
export function ProjectPlayerTransport({ controller, state }: ProjectPlayer): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  const reason = useRuntimeStore((value) => value.reason);
  const items = project ? playlistItems(project, state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio) : [];
  const selected = items.find((item) => item.id === state.itemId);
  const next = state.endAction === 'loop' ? selected : state.endAction === 'next' ? items[items.findIndex((item) => item.id === state.itemId) + 1] : undefined;
  return (
      <section className={`player-transport panel status-${state.status}`} aria-label="节目播放控制">
        <div className="home-section-heading"><h2>播放主控</h2><span>音乐 · 画面 · 灯光</span></div>
        <div className="player-now"><div className="player-track-icon"><Music2 /></div><div><small title={state.error ?? reason ?? undefined}>{statusLabel(state.status)}</small><h2>{selected?.title ?? '未播放'}</h2></div><span className="player-next"><small>{state.itemId ? '接下来' : '就绪'}</small><strong title={next?.title}>{state.itemId ? next?.title ?? '播完停止' : `${items.length} 首歌曲`}</strong></span></div>
        {state.error ? <p className="player-error" role="alert">{state.errorTitle ? <strong>{state.errorTitle}：</strong> : null}{state.error}</p> : null}
        {state.notice ? <p className="player-notice" role="status">{state.notice}</p> : null}
        <div className="player-buttons">
          <button aria-label="上一首" title="上一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(-1)}><SkipBack /></button>
          <Button className="primary-button" loading={state.status === 'preparing'} disabled={!controller || state.status === 'preparing' || !items.some((item) => item.referenceAudio)} onClick={() => {
            if (state.status === 'playing') void controller?.pause();
            else if (state.status === 'paused') void controller?.resume();
            else { const item = selected ?? items.find((entry) => entry.referenceAudio); if (item) void controller?.play(item.id); }
          }}>{state.status === 'playing' ? <Pause /> : <Play />}{state.status === 'playing' ? '暂停' : state.status === 'paused' ? '继续' : '播放'}</Button>
          <button aria-label="停止播放" title="停止播放" className="player-stop" disabled={!controller} onClick={() => void controller?.stop()}><Square /><span>停止</span></button>
          <button aria-label="重播当前歌曲" title="重播当前歌曲" disabled={!controller || !state.itemId} onClick={() => { if (state.itemId) void controller?.play(state.itemId); }}><RotateCcw /></button>
          <button aria-label="下一首" title="下一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(1)}><SkipForward /></button>
        </div>
        <div className="player-options"><label className="player-end-action"><span>播放方式</span><select aria-label="歌曲结束动作" value={state.endAction} onChange={(event) => controller?.setEndAction(event.currentTarget.value === 'pause' ? 'pause' : event.currentTarget.value === 'loop' ? 'loop' : event.currentTarget.value === 'stop' ? 'stop' : 'next')}><option value="next">顺序连播</option><option value="stop">播完停止</option><option value="pause">播完暂停</option><option value="loop">单曲循环</option></select></label>
          <label className="player-volume" title="仅调整本次播放；每首歌曲的固定音量请点击音频卡片上的音量设置">临时音量 {Math.round(state.volume)}% <input aria-label="正式音频音量" type="range" min={0} max={100} disabled={!controller || !state.itemId} value={state.volume} onChange={(event) => controller?.setVolume(Number(event.currentTarget.value))} /></label>
          <div className="player-fades"><button disabled={!controller} onClick={() => controller?.fade(false)}>淡入</button><button disabled={!controller} onClick={() => controller?.fade(true)}>淡出</button><button disabled={!controller} aria-label="重置播放状态" title="停止并重置播放记录" onClick={() => void controller?.reset()}><RotateCcw /></button></div>
        </div>

      </section>
  );
}

function PlayerConnections({ disabled, notify, onBusy, children }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; children?: ReactNode }): JSX.Element {
  const profile = useIntegrationStore((state) => state.profile);
  const [outputs, setOutputs] = useState<string[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [savedField, setSavedField] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!savedField) return; const timer = setTimeout(() => setSavedField(''), 2000); return () => clearTimeout(timer); }, [savedField]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false; let access: MIDIAccess | null = null;
    const refresh = (): void => { if (!cancelled && access) { setInputs([...access.inputs.values()].filter((port) => port.state === 'connected').map((port) => port.name ?? '').filter(Boolean)); setOutputs([...access.outputs.values()].filter((port) => port.state === 'connected').map((port) => port.name ?? '').filter(Boolean)); } };
    void requestMidiAccess({ sysex: true }).then((result) => { access = result; refresh(); result.addEventListener('statechange', refresh); }).catch((error: unknown) => notify(String(error), 'error'));
    const refreshDevices = (): void => { void navigator.mediaDevices.enumerateDevices().then((result) => { if (!cancelled) setDevices(result.filter((device) => device.kind === 'audiooutput' && device.deviceId !== 'default')); }).catch((error: unknown) => notify(String(error), 'error')); };
    refreshDevices(); navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => { cancelled = true; access?.removeEventListener('statechange', refresh); navigator.mediaDevices.removeEventListener('devicechange', refreshDevices); };
  }, [notify]);
  const port = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.mtcOutputPortProfileId)?.portName ?? '';
  const inputName = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.controlInputPortProfileId)?.portName ?? '';
  const save = async (portName: string, deviceId: string, controlName = inputName, doubleClickPlayback = profile?.internalPlayer?.doubleClickPlayback ?? false, audioSampleRate = profile?.internalPlayer?.audioSampleRate ?? 48000): Promise<void> => {
    if (disabled || saving) return;
    const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    setSaving(true); onBusy(true); setError('');
    try {
      const id = 'internal-mtc-output';
      const next = { ...current, updatedAt: new Date().toISOString(), internalPlayer: { ...current.internalPlayer, audioSampleRate, doubleClickPlayback, controlInputPortProfileId: controlName ? 'internal-control-input' : null, audioOutputDeviceId: deviceId, mtcOutputPortProfileId: portName ? id : null },
        midiPortProfiles: [...current.midiPortProfiles.filter((entry) => entry.id !== id && entry.id !== 'internal-control-input'), ...(controlName ? [{ id: 'internal-control-input', direction: 'input' as const, portName: controlName }] : []), ...(portName ? [{ id, direction: 'output' as const, portName }] : [])] };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSavedField(audioSampleRate !== (current.internalPlayer?.audioSampleRate ?? 48000) ? 'rate' : deviceId !== current.internalPlayer?.audioOutputDeviceId ? 'audio' : controlName !== inputName ? 'remote' : 'mtc');
    } catch (error) { setError(String(error)); notify(String(error), 'error'); } finally { setSaving(false); onBusy(false); }
  };
  const chosenOutput = profile?.internalPlayer?.audioOutputDeviceId ?? 'default';
  return <div className="player-connections panel"><h3 className="device-form-title">音频输出</h3>
    <label><span>音频输出线路</span><select aria-label="音乐监听设备" disabled={disabled || saving} value={chosenOutput} onChange={(event) => void save(port, event.currentTarget.value)}><option value="default">Windows 默认播放设备</option>{chosenOutput !== 'default' && !devices.some(device => device.deviceId === chosenOutput) ? <option value={chosenOutput}>上次选择的输出设备（当前列表不可见）</option> : null}{devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}</select>{savedField === 'audio' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
    <label><span>采样率</span><select aria-label="音频采样率" disabled={disabled || saving} value={profile?.internalPlayer?.audioSampleRate ?? 48000} onChange={(event) => void save(port, profile?.internalPlayer?.audioOutputDeviceId ?? 'default', inputName, profile?.internalPlayer?.doubleClickPlayback ?? false, event.currentTarget.value === '44100' ? 44100 : 48000)}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select>{savedField === 'rate' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
<h3 className="device-form-title">MIDI 时间码</h3>
<label><span>时间码输出</span><select aria-label="灯光 MIDI 输出" disabled={disabled || saving} value={port} onChange={(event) => void save(event.currentTarget.value, profile?.internalPlayer?.audioOutputDeviceId ?? 'default')}><option value="">自动检测控台接口</option>{[...new Set([...outputs, ...(port ? [port] : [])])].map((name) => <option key={name} value={name} disabled={!outputs.includes(name)}>{name}{outputs.includes(name) ? '' : '（未连接）'}</option>)}</select>{savedField === 'mtc' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
    <p className="settings-note">自动识别 loopMIDI 端口与实体 MIDI 设备，用于输出 MTC 时间码。{outputs.length === 0 ? '当前未检测到可用输出设备。' : `已识别 ${new Set(outputs).size} 个输出端口。`}</p>
    <details className="settings-disclosure"><summary>远程控制与灯光动作端口</summary><div className="player-connections">
    <label><span>远程播放输入</span><select aria-label="播放控制 MIDI 输入" disabled={disabled || saving} value={inputName} onChange={(event) => void save(port, profile?.internalPlayer?.audioOutputDeviceId ?? 'default', event.currentTarget.value)}><option value="">关闭远程播放控制</option>{[...new Set([...inputs, ...(inputName ? [inputName] : [])])].map((name) => <option key={name}>{name}</option>)}</select>{savedField === 'remote' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
    {children}</div></details>
    {error ? <p className="device-error" role="alert">{error}</p> : null}</div>;
}
function statusLabel(status: InternalPlayerState['status']): string { return ({ stopped: '已停止', preparing: '准备中', playing: '播放中', paused: '已暂停', error: '需要处理' })[status]; }

