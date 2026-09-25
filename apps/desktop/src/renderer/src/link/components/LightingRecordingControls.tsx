import { requestMidiAccess } from '../../registry/midi-access';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { LightingRecorder, LightingTempoMap } from '@tb/core/link';
import type { LightingClip, LightingDocument, LightingTempo, LightingTrack } from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';

export function LightingRecordingControls(props: { audioAvailable?: boolean; clip: LightingClip; track: LightingTrack; tempos: LightingTempo[]; playheadMs: number; audioRef: RefObject<HTMLAudioElement>; onRecorded: (take: LightingClip) => void; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const ports = useIntegrationStore((state) => state.profile?.midiPortProfiles);
  const initialized = useIntegrationStore((state) => state.initialized);
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const latest = useRef(props); latest.current = props;
  const session = useRef<{ recorder: LightingRecorder; cleanup: () => void; position: () => number; clip: LightingClip; map: LightingTempoMap } | null>(null);
  const generation = useRef(0);
  const saveTake = (current: NonNullable<typeof session.current>, end: number): void => {
    const events = current.recorder.finish(end); if (!events.length) return;
    const toMs = (at: number): number => current.clip.timeLock === 'time' ? current.clip.start + at : current.map.beatToMs(current.clip.start + at);
    const start = toMs(0);
    latest.current.onRecorded({ ...current.clip, id: crypto.randomUUID(), name: `${current.clip.name} · 录制`, timeLock: 'time', start, duration: toMs(current.clip.duration) - start, events: events.map((event) => event.kind === 'note' ? { ...event, at: toMs(event.at) - start, duration: toMs(event.at + event.duration) - toMs(event.at) } : { ...event, at: toMs(event.at) - start }) });
    const rawCount = events.filter((event) => event.kind === 'raw' && event.bytes[0] === 0xf0).length;
    if (latest.current.track.kind === 'ma2' && rawCount) latest.current.notify(`${rawCount} 条反馈未匹配到已绑定执行器或尚不支持解码，已保留完整 MIDI 消息`, 'info');
  };
  const position = (): number => session.current?.position() ?? 0;
  const stop = (): void => {
    generation.current += 1;
    const current = session.current; if (!current) return;
    const end = position(); current.cleanup(); session.current = null; setRecording(false);
    saveTake(current, end);
  };
  useEffect(() => () => {
    generation.current += 1;
    const current = session.current;
    if (current) {
      const end = position(); current.cleanup(); session.current = null; saveTake(current, end);
    }
  }, [props.audioRef]);
  const start = async (): Promise<void> => {
    const mapping = ports?.find((port) => port.id === 'lighting-record-input' && port.direction === 'input');
    if (!mapping) { props.notify('请在设置 → 设备连接中配置灯光录制反馈端口', 'error'); return; }
    if (!props.audioRef.current || !props.audioAvailable && !props.audioRef.current.getAttribute('src')) { props.notify('请先添加歌曲音频，再录制灯光', 'error'); return; }
    const token = ++generation.current; setConnecting(true);
    try {
      const access = await requestMidiAccess({ sysex: true });
      const matching = [...access.inputs.values()].filter((port) => port.name === mapping.portName && port.state === 'connected');
      const input = matching[0]; if (matching.length !== 1 || !input) throw new Error('录制输入未连接或名称不唯一');
      await input.open(); if (token !== generation.current) return;
      const map = new LightingTempoMap(props.tempos);
      const audioEndMs = props.audioRef.current?.duration;
      const end = audioEndMs && Number.isFinite(audioEndMs) ? (props.clip.timeLock === 'time' ? audioEndMs * 1000 : map.msToBeat(audioEndMs * 1000)) - props.clip.start : props.clip.duration;
      const recordingClip = { ...structuredClone(props.clip), duration: Math.max(props.clip.duration, end) };
      const bindings = props.track.clips.flatMap((clip) => clip.events.flatMap((event) => event.kind === 'ma2' && event.sequence !== undefined ? [{ executor: event.executor, sequence: event.sequence }] : []));
      const recorder = new LightingRecorder(props.track.channel, recordingClip.duration, bindings);
      const audio = props.audioRef.current;
      if (!audio) throw new Error('录制音频已关闭');
      const readPosition = (): number => (recordingClip.timeLock === 'time' ? audio.currentTime * 1000 : map.msToBeat(audio.currentTime * 1000)) - recordingClip.start;
      let lastPosition = readPosition();
      const pause = (): void => { if (!audio.seeking) { lastPosition = readPosition(); recorder.interrupt(lastPosition); } };
      const seeking = (): void => recorder.interrupt(lastPosition);
      const disconnected = (): void => { if (input.state !== 'connected') { stop(); latest.current.notify('灯光录制输入已断开，已保存收到的内容', 'error'); } };
      const timer = window.setInterval(() => {
        if (audio.paused || audio.seeking) return;
        lastPosition = readPosition(); recorder.advance(lastPosition);
      }, 16);
      const listener = (event: MIDIMessageEvent): void => {
        try { if (event.data && !audio.paused && !audio.seeking) { lastPosition = readPosition(); recorder.receive([...event.data], lastPosition); } }
        catch (error) { stop(); latest.current.notify(error instanceof Error ? error.message : String(error), 'error'); }
      };
      const cleanup = (): void => { window.clearInterval(timer); input.removeEventListener('midimessage', listener); access.removeEventListener('statechange', disconnected); audio.removeEventListener('pause', pause); audio.removeEventListener('ended', pause); audio.removeEventListener('seeking', seeking); };
      session.current = { cleanup, position: () => audio.readyState ? readPosition() : lastPosition, recorder, clip: recordingClip, map };
      access.addEventListener('statechange', disconnected);
      audio.addEventListener('pause', pause); audio.addEventListener('ended', pause); audio.addEventListener('seeking', seeking);
      input.addEventListener('midimessage', listener); setRecording(true);
    } catch (error) { if (token === generation.current) props.notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { if (token === generation.current) setConnecting(false); }
  };
  return <button className="timeline-record-button" disabled={!initialized || connecting || (!recording && props.track.locked)} aria-pressed={recording} title="记录播放期间收到的 MIDI 操作，输入端口在设置中配置" onClick={() => { if (recording) stop(); else void start(); }}>{connecting ? '连接中…' : recording ? '结束录制' : '录制灯光'}</button>;
}

export function TimelineLightingRecording(props: { audioAvailable?: boolean; document: LightingDocument; clipId: string | null; audioRef: RefObject<HTMLAudioElement>; playheadMs: number; onChange: (document: LightingDocument, label: string) => void; onError: (message: string) => void }): JSX.Element | null {
  const track = props.document.tracks.find((entry) => entry.clips.some((clip) => clip.id === props.clipId)) ?? props.document.tracks[0];
  const clip = track?.clips.find((entry) => entry.id === props.clipId) ?? track?.clips[0];
  if (!track || !clip) return null;
  return <LightingRecordingControls audioAvailable={props.audioAvailable === true} key={track.id + clip.id} clip={clip} track={track} tempos={props.document.tempos} audioRef={props.audioRef} playheadMs={props.playheadMs} notify={props.onError} onRecorded={(take) => props.onChange({ ...props.document, tracks: props.document.tracks.map((entry) => entry.id === track.id ? { ...entry, clips: [...entry.clips, take] } : entry) }, '录制灯光片段')} />;
}

