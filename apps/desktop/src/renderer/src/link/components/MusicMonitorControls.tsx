import { useEffect, useRef, useState } from 'react';
import { Headphones, Square } from 'lucide-react';
import type { LightingDocument, NativePlaybackDevices } from '@tb/schema';
import type { AudioEditor } from './useAudioEditor';
import { useDocumentStore } from '../stores/document-store';

export function MusicMonitorControls({ editor, document, positionMs }: { editor: AudioEditor | undefined; document: LightingDocument; positionMs: number }): JSX.Element {
  const [devices, setDevices] = useState<NativePlaybackDevices['audio']>([]);
  const [deviceId, setDeviceId] = useState(''); const [volume, setVolume] = useState(.25);
  const [active, setActive] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const session = useRef<string | null>(null); const audio = editor?.audio;
  useEffect(() => {
    const unsubscribe = window.tbLink.onMusicMonitorStatus(status => { if (status.sessionId !== session.current) return; setActive(status.state === 'playing'); setBusy(status.state === 'preparing'); if (status.state === 'error') setError(status.message); });
    return () => { unsubscribe(); if (session.current) void window.tbLink.stopMusicMonitor().catch(cause => console.error('停止编排监听失败', cause)); session.current = null; };
  }, [audio]);
  const start = async (mode: 'segment' | 'metronome'): Promise<void> => {
    const path = useDocumentStore.getState().path;
    if (!audio || !path || !deviceId) { setError('请先保存工程并选择独立监听设备'); return; }
    const sessionId = crypto.randomUUID(); session.current = sessionId; setBusy(true); setError('');
    try {
      const startMs = mode === 'segment' ? Math.max(0, positionMs - 2000) : positionMs;
      // Monitor in bounded phrases; it never drives the formal playback clock.
      const endMs = Math.min(audio.durationMs, mode === 'segment' ? positionMs + 2000 : positionMs + 60000);
      const result = await window.tbLink.startMusicMonitor({ version: 1, sessionId, projectPath: path, deviceId, volume, mode, source: audio, startMs, endMs, firstBeatMs: document.music?.firstBeatMs ?? 0, tempos: document.tempos });
      if (session.current === sessionId) setActive(result.state === 'playing');
    } catch (cause) { if (session.current === sessionId) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (session.current === sessionId) setBusy(false); }
  };
  return <div className="music-monitor-controls"><div className="music-inline-actions"><Headphones size={16} /><button onClick={() => { void window.tbLink.getNativePlaybackDevices().then(value => { setDevices(value.audio); setError(''); }).catch(cause => setError(String(cause))); }}>选择监听线路</button><select aria-label="独立监听设备" value={deviceId} onChange={event => setDeviceId(event.target.value)} disabled={active || busy}><option value="">请选择独立输出设备</option>{devices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}</select><label>监听音量<input aria-label="监听音量" type="range" min="0" max="1" step="0.01" value={volume} disabled={active || busy} onChange={event => setVolume(event.target.valueAsNumber)} /></label><button disabled={!audio || busy || active} onClick={() => { void start('metronome'); }}>试听节拍</button><button disabled={!audio || busy || active} onClick={() => { void start('segment'); }}>试听当前位置前后</button><button disabled={!active && !busy} onClick={() => { void window.tbLink.stopMusicMonitor().then(() => { setActive(false); setBusy(false); }).catch(cause => setError(String(cause))); }}><Square size={14} />停止监听</button>{busy ? <span>核对监听线路</span> : active ? <span>独立监听中</span> : null}</div>{error ? <div role="alert" className="music-tool-error">{error}</div> : null}</div>;
}
