import { useEffect, useRef, useState, type RefObject } from 'react';
import { lightingTimeOrigin } from '@tb/core/link';
import type { LightingDocument, MtcFrameRate } from '@tb/schema';
import { LightingMidiOutput } from '../../registry/lighting-midi-output';
import { MediaMtcOutput } from '../../registry/media-mtc-output';
import { useIntegrationStore } from '../stores/integration-store';
import { reportCoordinatorError } from './runtime-action-log';

export function useLightingPreview(input: { enabled: boolean; document: LightingDocument | undefined; audioRef: RefObject<HTMLAudioElement>; playing: boolean; frameRate: MtcFrameRate; onError: (message: string) => void }): { ready: boolean; stop: () => Promise<void> } {
  const endingOutput = useRef<LightingMidiOutput | null>(null);
  const ownedOutput = useRef<LightingMidiOutput | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef(input); latest.current = input;
  const stop = async (): Promise<void> => {
    const output = ownedOutput.current; ownedOutput.current = null;
    if (!output) return;
    output.stop();
    try { await output.release(); } finally { output.close(); }
  };
  useEffect(() => () => {
    const output = ownedOutput.current; ownedOutput.current = null;
    if (!output) return;
    output.stop();
    void output.release().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      latest.current.onError(message);
      reportCoordinatorError(message, failure => latest.current.onError(failure));
    }).finally(() => output.close());
  }, []);
  useEffect(() => {
    endingOutput.current?.stop(); endingOutput.current = null;
    const document = latest.current.document;
    if (!input.playing || !document?.tracks.length) { setReady(false); return; }
    const hasLightingContent = Boolean(document.ma2Bindings?.length) || document.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind !== 'empty-cue')));
    const output = new LightingMidiOutput(); const mtc = new MediaMtcOutput();
    // A replaced preview is never released any more: its outputs are let go now.
    if (input.enabled) { ownedOutput.current?.close(); ownedOutput.current = output; }
    let seekAudio: HTMLAudioElement | null = null;
    let canFinish = false;
    let looping = false;
    let cancelled = false; let timer: ReturnType<typeof setInterval> | null = null;
    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      latest.current.onError(message);
      reportCoordinatorError(message, failure => latest.current.onError(failure));
    };
    const began = (): void => { canFinish = Boolean(seekAudio && !seekAudio.ended && !seekAudio.seeking); };
    const located = (): void => { canFinish = false; try { if (seekAudio) output.locate(seekAudio.currentTime * 1000); mtc.stop(); } catch (error) { cleanup(); fail(error); } };
    const cleanup = (): void => {
      setReady(false); if (timer) clearInterval(timer); timer = null;
      // The toolbar can pause at duration before Chromium dispatches `ended`.
      // Seeking clears canFinish, so a manual jump must never flush past cues.
      const reachedEnd = seekAudio && (seekAudio.ended || (Number.isFinite(seekAudio.duration) && seekAudio.duration > 0 && seekAudio.currentTime >= seekAudio.duration));
      let finishing: Promise<void> | void = undefined;
      if (canFinish && reachedEnd && seekAudio && !seekAudio.seeking) {
        canFinish = false;
        try { finishing = output.finish(seekAudio.currentTime * 1000); } catch (error) { fail(error); }
      }
      seekAudio?.removeEventListener('playing', began); seekAudio?.removeEventListener('seeking', located); seekAudio?.removeEventListener('seeked', located); seekAudio = null;
      mtc.close();
      if (finishing) {
        endingOutput.current = output;
        void finishing.catch(fail).finally(() => {
          try { output.stop(); } catch (error) { fail(error); }
          if (endingOutput.current === output) endingOutput.current = null;
          if (ownedOutput.current !== output) output.close();
        });
      } else {
        try { output.stop(); } catch (error) { fail(error); }
        // The owned preview keeps its outputs for the release when it is stopped.
        if (ownedOutput.current !== output) output.close();
      }
    };
    const start = async (): Promise<void> => {
      const originMs = lightingTimeOrigin(document);
      const profile = useIntegrationStore.getState().profile;
      const audio = input.audioRef.current;
      if (!audio || !audio.getAttribute('src')) { if (input.enabled) throw new Error('请先给节目添加音乐，再开启灯光试听'); return; }
      if (input.enabled) await output.prepare(document, profile, audio.currentTime * 1000);
      if (cancelled || (input.enabled && ownedOutput.current !== output)) { cleanup(); return; }
      if (input.enabled && hasLightingContent && document.outputMode === 'timecode') {
        const id = profile?.internalPlayer?.mtcOutputPortProfileId;
        const name = profile?.midiPortProfiles.find((entry) => entry.id === id && entry.direction === 'output')?.portName;
        if (!name) throw new Error('请先在设备设置里选择 MIDI 时间码输出');
        await mtc.connect(name);
      }
      if (cancelled || (input.enabled && ownedOutput.current !== output)) { cleanup(); return; }
      seekAudio = audio; audio.addEventListener('playing', began); audio.addEventListener('seeking', located); audio.addEventListener('seeked', located);
      setReady(true);
      timer = setInterval(() => {
        try {
          if (audio.paused || audio.ended || audio.seeking || looping) return;
          canFinish = true;
          if (document.loop.enabled && audio.currentTime * 1000 >= document.loop.endMs) {
            const resume = (): void => { if (cancelled) return; output.locate(document.loop.startMs); audio.currentTime = document.loop.startMs / 1000; mtc.stop(); looping = false; };
            const pending = output.finish(document.loop.endMs);
            if (pending) { looping = true; void pending.then(resume).catch((error: unknown) => { cleanup(); if (!cancelled) fail(error); }); }
            else resume();
            return;
          }
          if (input.enabled) output.tick(audio.currentTime * 1000); if (input.enabled && hasLightingContent && document.outputMode === 'timecode') mtc.tick(audio.currentTime * 1000 + originMs, latest.current.frameRate);
        } catch (error) { cleanup(); fail(error); }
      }, 5);
    };
    void start().catch((error: unknown) => { cleanup(); if (!cancelled) fail(error); });
    return () => { cancelled = true; cleanup(); };
  }, [input.playing, input.audioRef, input.enabled]);
  return { ready: !input.enabled || !input.document?.tracks.length || ready, stop };
}
