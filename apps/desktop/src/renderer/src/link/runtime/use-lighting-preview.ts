import { useEffect, useRef, useState, type RefObject } from 'react';
import { LightingOutputRelease, lightingTimeOrigin, mtcOutputSettings } from '@tb/core/link';
import type { LightingDocument, MtcFrameRate } from '@tb/schema';
import { MediaMtcOutput } from '../../registry/media-mtc-output';
import { useIntegrationStore } from '../stores/integration-store';
import { reportCoordinatorError } from './runtime-action-log';

/**
 * The lighting of an editor preview: MIDI timecode from the song's MTC start, so the console's Timecode show
 * runs the lighting the way the show will. Since 2026-11-01 that is the only way a song drives lighting; the
 * timeline itself is never sent. Stopping switches the song's executors off, as formal playback does.
 * `mtcOrigin` is the song's MTC start, the one the program sends (2026-10-26: P1-follow previews used to
 * start from the console binding, 0 for a song made in the software). Without it the binding's start is used.
 */
export function useLightingPreview(input: { enabled: boolean; document: LightingDocument | undefined; mtcOrigin?: (() => number) | undefined; audioRef: RefObject<HTMLAudioElement>; playing: boolean; frameRate: MtcFrameRate; onError: (message: string) => void }): { ready: boolean; stop: () => Promise<void> } {
  /** The Off of the last preview that played lighting, sent when the operator stops. */
  const ownedRelease = useRef<LightingOutputRelease | null>(null);
  const [ready, setReady] = useState(false);
  const latest = useRef(input); latest.current = input;
  const stop = async (): Promise<void> => {
    const release = ownedRelease.current; ownedRelease.current = null;
    if (release) await release.release();
  };
  useEffect(() => () => {
    const release = ownedRelease.current; ownedRelease.current = null;
    void release?.release().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      latest.current.onError(message);
      reportCoordinatorError(message, failure => latest.current.onError(failure));
    });
  }, []);
  useEffect(() => {
    const document = latest.current.document;
    if (!input.playing || !document?.tracks.length) { setReady(false); return; }
    const hasLightingContent = Boolean(document.ma2Bindings?.length) || document.tracks.some(track => track.clips.some(clip => clip.events.some(event => event.kind !== 'empty-cue')));
    const mtc = new MediaMtcOutput();
    // A replaced preview is never released any more: only the latest one switches its executors off.
    const release = input.enabled ? new LightingOutputRelease({ getMa2NetworkStatus: () => window.tbLink.getMa2NetworkStatus(), playMa2Cue: request => window.tbLink.playMa2Cue(request) }) : null;
    if (release) ownedRelease.current = release;
    let seekAudio: HTMLAudioElement | null = null;
    let cancelled = false; let timer: ReturnType<typeof setInterval> | null = null;
    const fail = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      latest.current.onError(message);
      reportCoordinatorError(message, failure => latest.current.onError(failure));
    };
    // A jump restarts the timecode with a full frame at the new position.
    const located = (): void => { try { mtc.stop(); } catch (error) { cleanup(); fail(error); } };
    const cleanup = (): void => {
      setReady(false); if (timer) clearInterval(timer); timer = null;
      seekAudio?.removeEventListener('seeking', located); seekAudio?.removeEventListener('seeked', located); seekAudio = null;
      mtc.close();
    };
    const current = (): boolean => !cancelled && (!release || ownedRelease.current === release);
    const start = async (): Promise<void> => {
      const sendsMtc = input.enabled && hasLightingContent;
      const originMs = sendsMtc ? (latest.current.mtcOrigin ?? (() => lightingTimeOrigin(document)))() : 0;
      const audio = input.audioRef.current;
      if (!audio || !audio.getAttribute('src')) { if (input.enabled) throw new Error('请先给节目添加音乐，再开启灯光试听'); return; }
      if (release) await release.prepare(document);
      if (!current()) { cleanup(); return; }
      if (sendsMtc) {
        // The same port and send mode as formal playback: the preview fires the lights the way the show will.
        const settings = mtcOutputSettings(useIntegrationStore.getState().profile);
        if (!settings.portName) throw new Error('请先在设备设置里选择 MIDI 时间码输出');
        await mtc.connect(settings.portName, false, settings.sendMode);
      }
      if (!current()) { cleanup(); return; }
      seekAudio = audio; audio.addEventListener('seeking', located); audio.addEventListener('seeked', located);
      setReady(true);
      timer = setInterval(() => {
        try {
          if (audio.paused || audio.ended || audio.seeking) return;
          if (document.loop.enabled && audio.currentTime * 1000 >= document.loop.endMs) { audio.currentTime = document.loop.startMs / 1000; mtc.stop(); return; }
          if (sendsMtc) mtc.tick(audio.currentTime * 1000 + originMs, latest.current.frameRate);
        } catch (error) { cleanup(); fail(error); }
      }, 5);
    };
    void start().catch((error: unknown) => { cleanup(); if (!cancelled) fail(error); });
    return () => { cancelled = true; release?.cancelPreparation(); cleanup(); };
  }, [input.playing, input.audioRef, input.enabled]);
  return { ready: !input.enabled || !input.document?.tracks.length || ready, stop };
}
