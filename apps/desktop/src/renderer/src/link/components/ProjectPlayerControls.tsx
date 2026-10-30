import { Button } from '../ui/Button';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Play, Pause, Square, SkipBack, SkipForward, RotateCcw, Music2 } from 'lucide-react';
import { mtcOutputSettings, playlistItems, type InternalPlayerState } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import type { RemoteNativeProgramPlayer } from '../runtime/remote-native-program-player';
import type { PlayerControlState, PlayerViewStore } from '../stores/player-view-store';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { midiOutputInventory, readNativeDevices } from '../view-models/midi-device-inventory';
import { legacyAudioDeviceNotice, playerEngineLabel } from '../view-models/internal-audio-engine';

import { ImportPlayerMusic } from './ImportPlayerMusic';
import { PlayerStatusDetails } from './PlayerStatusDetails';

/** `engine` names the audio engine this player uses, for the operator. */
export type ProjectPlayer = { controller: RemoteNativeProgramPlayer | null; state: PlayerControlState; view: PlayerViewStore; engine: string };
type SetupProps = { locked: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; playlistId: string };
export function ProjectPlayerSetup({ locked, notify, onBusy, playlistId }: SetupProps): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  if (!project) return <></>;
  return <div className="project-player-setup"><ImportPlayerMusic disabled={locked} notify={notify} onBusy={onBusy} playlistId={playlistId} /></div>;
}
export function ProjectMusicConnections({ disabled, notify, onBusy, children }: { disabled: boolean; notify: SetupProps['notify']; onBusy: (busy: boolean) => void; children?: ReactNode }): JSX.Element {
  return <PlayerConnections disabled={disabled} notify={notify} onBusy={onBusy}>{children}</PlayerConnections>;
}
export function ProjectPlayerTransport({ controller, state, engine, selectedItem }: ProjectPlayer & { selectedItem?: RundownItem | null | undefined }): JSX.Element {
  const project = useDocumentStore((value) => value.project);
  const reason = useRuntimeStore((value) => value.reason);
  const items = project ? playlistItems(project, state.playlistId ?? 'all').filter((item) => item.enabled && item.referenceAudio) : [];
  const active = state.status === 'playing' || state.status === 'paused';
  const selected = active ? project?.rundown.find(item => item.id === state.itemId) : selectedItem ?? items.find(item => item.id === state.itemId);
  const target = selected?.enabled && selected.referenceAudio ? selected : items[0];
  const unavailable = !controller ? '播放器还没准备好' : state.status === 'preparing' ? '正在准备音频，点“停止”可以取消'
    : !active && !target ? '当前节目和播放列表里没有可以播放的音频' : null;
  const next = state.endAction === 'loop' ? selected : state.endAction === 'next' ? items[items.findIndex((item) => item.id === state.itemId) + 1] : undefined;
  return (
      <section className={`player-transport panel status-${state.status}`} aria-label="节目播放控制">
        <div className="home-section-heading"><h2>播放主控</h2><span>音乐 · 画面 · 灯光</span></div>
        <div className="player-now"><div className="player-track-icon"><Music2 /></div><div>{state.fault ? <small className="player-fault" role="alert" title={state.fault}>{statusLabel(state.status)} · 输出出错</small> : <small title={state.error ?? reason ?? undefined}>{state.status === 'preparing' && state.preparation ? `准备中 · ${state.preparation}` : statusLabel(state.status)}</small>}<h2>{selected?.title ?? '未播放'}</h2></div><span className="player-next"><small>{state.itemId ? '接下来' : '就绪'}</small><strong title={next?.title}>{state.itemId ? next?.title ?? '播完停止' : `${items.length} 首歌曲`}</strong></span><PlayerStatusDetails error={state.error} errorTitle={state.errorTitle} notice={state.notice} fault={state.fault ?? null} engine={engine} /></div>
        <div className="player-buttons">
          <button aria-label="上一首" title="上一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(-1)}><SkipBack /></button>
          <Button className="primary-button" title={unavailable ?? (state.status === 'playing' ? '暂停播放' : state.status === 'paused' ? '继续播放' : `播放 ${target?.title ?? ''}`)} loading={state.status === 'preparing'} disabled={unavailable !== null} onClick={() => {
            if (state.status === 'playing') void controller?.pause();
            else if (state.status === 'paused') void controller?.resume();
            else if (target) void controller?.play(target.id);
          }}>{state.status === 'playing' ? <Pause /> : <Play />}{state.status === 'playing' ? '暂停' : state.status === 'paused' ? '继续' : '播放'}</Button>
          <button aria-label="停止播放" title="停止播放" className="player-stop" disabled={!controller} onClick={() => void controller?.stop()}><Square /><span>停止</span></button>
          <button aria-label="重播当前歌曲" title="重播当前歌曲" disabled={!controller || !state.itemId} onClick={() => { if (state.itemId) void controller?.play(state.itemId); }}><RotateCcw /></button>
          <button aria-label="下一首" title="下一首" disabled={!controller || !items.length} onClick={() => void controller?.skip(1)}><SkipForward /></button>
        </div>
        <div className="player-options"><label className="player-end-action"><span>播放方式</span><select aria-label="歌曲结束动作" value={state.endAction} onChange={(event) => controller?.setEndAction(event.currentTarget.value === 'pause' ? 'pause' : event.currentTarget.value === 'loop' ? 'loop' : event.currentTarget.value === 'stop' ? 'stop' : 'next')}><option value="next">顺序连播</option><option value="stop">播完停止</option><option value="pause">播完暂停</option><option value="loop">单曲循环</option></select></label>
          <label className="player-volume" title="只影响这次播放。要固定每首歌的音量，请在音频卡片上设置">临时音量 {Math.round(state.volume)}% <input aria-label="播放音量" type="range" min={0} max={100} disabled={!controller || !state.itemId} value={state.volume} onChange={(event) => controller?.setVolume(Number(event.currentTarget.value))} /></label>
          <div className="player-fades"><button disabled={!controller} onClick={() => controller?.fade(false)}>淡入</button><button disabled={!controller} onClick={() => controller?.fade(true)}>淡出</button><button disabled={!controller} aria-label="重置播放状态" title="停止并重置播放记录" onClick={() => void controller?.reset()}><RotateCcw /></button></div>
        </div>

      </section>
  );
}

function PlayerConnections({ disabled, notify, onBusy, children }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; children?: ReactNode }): JSX.Element {
  const profile = useIntegrationStore((state) => state.profile);
  const ports = useIntegrationStore(state => state.midiPorts);
  const nativeDevices = useIntegrationStore(state => state.nativeDevices);
  const nativeError = useIntegrationStore(state => state.nativeDeviceError);
  const inputs = ports.filter(port => port.direction === 'input' && port.state === 'connected').map(port => port.name);
  const project = useDocumentStore((state) => state.project);
  const [savedField, setSavedField] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (!savedField) return; const timer = setTimeout(() => setSavedField(''), 2000); return () => clearTimeout(timer); }, [savedField]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const refreshDevices = (): void => {
      void readNativeDevices().catch((error: unknown) => { if (!cancelled) notify(String(error), 'error'); });
    };
    refreshDevices(); navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => { cancelled = true; navigator.mediaDevices.removeEventListener('devicechange', refreshDevices); };
  }, [notify]);
  const port = mtcOutputSettings(profile).portName ?? '';
  const inventory = midiOutputInventory(nativeDevices, port);
  const outputs = inventory.available;
  const audioDevices = nativeDevices?.audio.map(device => ({ deviceId: device.id, label: device.name })) ?? [];
  const inputName = profile?.midiPortProfiles.find((entry) => entry.id === profile.internalPlayer?.controlInputPortProfileId)?.portName ?? '';
  const save = async (portName: string, deviceId: string, controlName = inputName, doubleClickPlayback = profile?.internalPlayer?.doubleClickPlayback ?? false, audioSampleRate = profile?.internalPlayer?.audioSampleRate ?? 48000): Promise<void> => {
    if (disabled || saving) return;
    const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
    setSaving(true); onBusy(true); setError('');
    try {
      const id = 'internal-mtc-output';
      const next = { ...current, updatedAt: new Date().toISOString(), internalPlayer: { audioOutputDeviceId: 'default', ...current.internalPlayer, audioEngine: 'native' as const, audioSampleRate, doubleClickPlayback, controlInputPortProfileId: controlName ? 'internal-control-input' : null, nativeAudioOutputDeviceId: deviceId, mtcOutputPortProfileId: portName ? id : null },
        midiPortProfiles: [...current.midiPortProfiles.filter((entry) => entry.id !== id && entry.id !== 'internal-control-input'), ...(controlName ? [{ id: 'internal-control-input', direction: 'input' as const, portName: controlName }] : []), ...(portName ? [{ id, direction: 'output' as const, portName }] : [])] };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSavedField(audioSampleRate !== (current.internalPlayer?.audioSampleRate ?? 48000) ? 'rate' : deviceId !== (current.internalPlayer?.nativeAudioOutputDeviceId ?? 'default') ? 'audio' : controlName !== inputName ? 'remote' : 'mtc');
    } catch (error) { setError(String(error)); notify(String(error), 'error'); } finally { setSaving(false); onBusy(false); }
  };
  const chosenOutput = profile?.internalPlayer?.nativeAudioOutputDeviceId ?? 'default';
  const legacyDevice = legacyAudioDeviceNotice(profile?.internalPlayer);
  const sendMode = profile?.internalPlayer?.mtcSendMode ?? 'standard';
  const chooseSendMode = async (mtcSendMode: 'standard' | 'quarter-frames'): Promise<void> => {
    if (disabled || saving) return;
    setSaving(true); onBusy(true); setError('');
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...current, updatedAt: new Date().toISOString(), internalPlayer: { audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, ...current.internalPlayer, mtcSendMode } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSavedField('mode');
    } catch (error) { setError(String(error)); notify(String(error), 'error'); } finally { setSaving(false); onBusy(false); }
  };
  return <div className="player-connections panel"><h3 className="device-form-title">音频输出</h3>
    <p className="settings-note">当前播放引擎：{playerEngineLabel(profile, project)}</p>
    {legacyDevice ? <p className="device-error" role="status">{legacyDevice}</p> : null}

    <label><span>音频输出设备</span><select aria-label="音乐监听设备" disabled={disabled || saving} value={chosenOutput} onChange={(event) => void save(port, event.currentTarget.value)}><option value="default">Windows 默认播放设备</option>{chosenOutput !== 'default' && !audioDevices.some(device => device.deviceId === chosenOutput) ? <option value={chosenOutput}>上次选择的设备（现在找不到）</option> : null}{audioDevices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || device.deviceId}</option>)}</select>{savedField === 'audio' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
    <label><span>采样率</span><select aria-label="音频采样率" disabled={disabled || saving} value={profile?.internalPlayer?.audioSampleRate ?? 48000} onChange={(event) => void save(port, chosenOutput, inputName, profile?.internalPlayer?.doubleClickPlayback ?? false, event.currentTarget.value === '44100' ? 44100 : 48000)}><option value="44100">44.1 kHz</option><option value="48000">48 kHz</option></select>{savedField === 'rate' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
<h3 className="device-form-title">MIDI 时间码</h3>
<label><span>时间码输出</span><select aria-label="灯光 MIDI 输出" disabled={disabled || saving} value={port} onChange={(event) => void save(event.currentTarget.value, chosenOutput)}><option value="">自动检测控台接口</option>{inventory.options.map(option => <option key={option.name} value={option.name} disabled={!option.available}>{option.name}{option.reason ? `（${option.reason}）` : ''}</option>)}</select>{savedField === 'mtc' ? <small className="field-save-status" role="status">已保存，播放时再打开端口</small> : null}</label>
<label><span>发送方式</span><select aria-label="时间码发送方式" disabled={disabled || saving} value={sendMode} onChange={(event) => void chooseSendMode(event.currentTarget.value === 'quarter-frames' ? 'quarter-frames' : 'standard')}><option value="standard">标准（先发整帧定位）</option><option value="quarter-frames">只发四分之一帧</option></select>{savedField === 'mode' ? <small className="field-save-status" role="status">已保存，下一首起生效</small> : null}</label>
    <p className="settings-note">控台收不到时间码时，可以改成“只发四分之一帧”再播一首试试：有的 USB MIDI 接口传不了整帧消息。控台上 Timecode 窗口的时间在走，就说明收到了。</p>
    <p className="settings-note">用来给灯光控台发送 MTC 时间码，支持 loopMIDI 虚拟端口和 USB MIDI 设备。{outputs.length === 0 ? '现在没有找到可用的输出设备。' : `已找到 ${new Set(outputs).size} 个输出端口。`}</p>
    <p className="settings-note">由联动台代替 P1 播放时，请先完全退出 P1（否则会占用同一个 MIDI 接口），再刷新端口。</p>
    {nativeError ? <p className="device-error" role="status">Windows 设备检测失败：{nativeError}</p> : null}
    <details className="settings-disclosure"><summary>远程控制与灯光动作端口</summary><div className="player-connections">
    <label><span>远程播放输入</span><select aria-label="播放控制 MIDI 输入" disabled={disabled || saving} value={inputName} onChange={(event) => void save(port, chosenOutput, event.currentTarget.value)}><option value="">关闭远程播放控制</option>{[...new Set([...inputs, ...(inputName ? [inputName] : [])])].map((name) => <option key={name} value={name}>{name}{!inputs.includes(name) ? '（当前不可用）' : ''}</option>)}</select>{savedField === 'remote' ? <small className="field-save-status" role="status">已保存</small> : null}</label>
    {children}</div></details>
    {error ? <p className="device-error" role="alert">{error}</p> : null}</div>;
}
function statusLabel(status: InternalPlayerState['status']): string { return ({ stopped: '已停止', preparing: '准备中', playing: '播放中', paused: '已暂停', error: '需要处理' })[status]; }

