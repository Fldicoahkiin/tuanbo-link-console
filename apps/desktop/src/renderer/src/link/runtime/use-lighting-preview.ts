import { useEffect, useRef, useState, type RefObject } from 'react';
import { lightingTimeOrigin } from '@tb/core/link';
import type { LightingDocument, MtcFrameRate } from '@tb/schema';
import { LightingMidiOutput } from '../../registry/lighting-midi-output';
import { MediaMtcOutput } from '../../registry/media-mtc-output';
import { useIntegrationStore } from '../stores/integration-store';

export function useLightingPreview(input: { enabled: boolean; document: LightingDocument | undefined; audioRef: RefObject<HTMLAudioElement>; playing: boolean; frameRate: MtcFrameRate; onError: (message: string) => void }): boolean {
  const [ready, setReady] = useState(false);
  const latest = useRef(input); latest.current = input;
  useEffect(() => {
    const document = latest.current.document;
    if (!input.playing || !document?.tracks.length) { setReady(false); return; }
    const output = new LightingMidiOutput(); const mtc = new MediaMtcOutput();
    let seekAudio: HTMLAudioElement | null = null;
    let canFinish = false;
    let cancelled = false; let timer: ReturnType<typeof setInterval> | null = null;
    const fail = (error: unknown): void => latest.current.onError(error instanceof Error ? error.message : String(error));
    const began = (): void => { canFinish = Boolean(seekAudio && !seekAudio.ended && !seekAudio.seeking); };
    const located = (): void => { canFinish = false; try { if (seekAudio) output.locate(seekAudio.currentTime * 1000); mtc.stop(); } catch (error) { cleanup(); fail(error); } };
    const cleanup = (): void => {
      setReady(false); if (timer) clearInterval(timer); timer = null;
      // The toolbar can pause at duration before Chromium dispatches `ended`.
      // Seeking clears canFinish, so a manual jump must never flush past cues.
      const reachedEnd = seekAudio && (seekAudio.ended || (Number.isFinite(seekAudio.duration) && seekAudio.duration > 0 && seekAudio.currentTime >= seekAudio.duration));
      if (canFinish && reachedEnd && seekAudio && !seekAudio.seeking) {
        canFinish = false;
        try { output.finish(seekAudio.currentTime * 1000); } catch (error) { fail(error); }
      }
      seekAudio?.removeEventListener('playing', began); seekAudio?.removeEventListener('seeking', located); seekAudio?.removeEventListener('seeked', located); seekAudio = null;
      mtc.stop(); try { output.stop(); } catch (error) { fail(error); }
    };
    const start = async (): Promise<void> => {
      const originMs = lightingTimeOrigin(document);
      const profile = useIntegrationStore.getState().profile;
      const audio = input.audioRef.current;
      if (!audio || !audio.getAttribute('src')) { if (input.enabled) throw new Error('请先给节目添加音乐，再开启灯光试听'); return; }
      if (input.enabled) await output.prepare(document, profile, audio.currentTime * 1000);
      if (cancelled) { cleanup(); return; }
      if (input.enabled && document.outputMode === 'timecode') {
        const id = profile?.internalPlayer?.mtcOutputPortProfileId;
        const name = profile?.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output')?.portName;
        if (!name) throw new Error('请在设备设置选择 MIDI 时间码输出');
        await mtc.connect(name);
      }
      if (cancelled) { cleanup(); return; }
      seekAudio = audio; audio.addEventListener('playing', began); audio.addEventListener('seeking', located); audio.addEventListener('seeked', located);
      setReady(true);
      timer = setInterval(() => {
        try {
          if (audio.paused || audio.ended || audio.seeking) return;
          canFinish = true;
          if (document.loop.enabled && audio.currentTime * 1000 >= document.loop.endMs) { output.loop(document.loop.startMs, document.loop.endMs); audio.currentTime = document.loop.startMs / 1000; mtc.stop(); return; }
          if (input.enabled) output.tick(audio.currentTime * 1000); if (input.enabled && document.outputMode === 'timecode') mtc.tick(audio.currentTime * 1000 + originMs, latest.current.frameRate);
        } catch (error) { cleanup(); fail(error); }
      }, 5);
    };
    void start().catch((error: unknown) => { cleanup(); if (!cancelled) fail(error); });
    return () => { cancelled = true; cleanup(); };
  }, [input.playing, input.audioRef, input.enabled]);
  return !input.enabled || !input.document?.tracks.length || ready;
}
