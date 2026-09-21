import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useSelectedProgram } from '../useSelectedProgram';
import { useDocumentStore } from '../stores/document-store';
import { LatestPosition } from '../runtime/latest-position';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';

export function useEditorProgram(player: ProjectPlayer, external: boolean, notify: (message: string, tone?: 'info' | 'error') => void): string | null {
  const [selected, select] = useSelectedProgram(notify);
  useEffect(() => { if (external && player.state.itemId) select(player.state.itemId); }, [external, player.state.itemId, select]);
  return external && ['playing', 'paused', 'preparing'].includes(player.state.status) ? player.state.itemId ?? selected : selected;
}

/** The editor owns only its stopped cursor; the formal player owns audio and output. */
export function useEditorTransport(player: ProjectPlayer, itemId: string | null, external: boolean,
  notify: (message: string, tone?: 'info' | 'error') => void) {
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [localPlaying, setLocalPlaying] = useState(false);
  useEffect(() => { useMa2AutoSyncStore.setState({ previewPlaying: localPlaying }); return () => { useMa2AutoSyncStore.setState({ previewPlaying: false }); }; }, [localPlaying]);
  const [seeking, setSeeking] = useState(false);
  const seekQueue = useRef<LatestPosition | null>(null);
  const resumeAfterSeek = useRef(false);
  useEffect(() => () => { seekQueue.current?.cancel(); seekQueue.current = null; }, [itemId, player.controller]);
  const active = external && player.state.itemId === itemId && ['playing', 'paused', 'preparing'].includes(player.state.status);
  const playheadMs = active && !seeking ? player.state.positionMs : cursor;
  const playing = external ? active && player.state.status === 'playing' : localPlaying;
  const audioRef = useMemo(() => ({ current: player.controller?.mediaElement ?? null }), [player.controller]);
  useEffect(() => { if (external && player.state.error) notify(player.state.error, 'error'); }, [external, player.state.error, notify]);
  const report = (error: unknown): void => notify(error instanceof Error ? error.message : String(error), 'error');
  const reset = useCallback(() => { seekQueue.current?.cancel(); seekQueue.current = null; setSeeking(false); cursorRef.current = 0; setCursor(0); setLocalPlaying(false); }, []);
  const setPlayheadMs = (position: number): void => {
    cursorRef.current = position; setCursor(position);
    // A stopped editor seek is only a cursor move. Scrub prepares a formal
    // paused session, which acquires the runtime edit lock even without Play.
    if (!external || !active || !itemId || !player.controller) return;
    const controller = player.controller;
    const item = useDocumentStore.getState().project?.rundown.find((entry) => entry.id === itemId);
    const endMs = item?.playback?.endMs || item?.referenceAudio?.durationMs;
    if (!endMs) return;
    const target = Math.max(item?.playback?.startMs ?? 0, Math.min(position, endMs - 1));
    setSeeking(true);
    if (!seekQueue.current) {
      resumeAfterSeek.current = playing;
      seekQueue.current = new LatestPosition(
        (position) => controller.scrub(itemId, position),
        () => { seekQueue.current = null; setSeeking(false); if (resumeAfterSeek.current) void controller.resume().catch(report); },
        (error) => { resumeAfterSeek.current = false; report(error); });
    }
    seekQueue.current.push(target);
  };
  const setPlaying = (next: boolean): void => {
    if (next && useMa2AutoSyncStore.getState().status === 'writing') { notify('MA2 正在同步并回读，请完成后播放', 'error'); return; }
    if (seekQueue.current) { resumeAfterSeek.current = next; return; }
    if (!external) { useMa2AutoSyncStore.setState({ previewPlaying: next }); setLocalPlaying(next); return; }
    const controller = player.controller;
    if (!controller || !itemId) { if (next) notify('播放器尚未就绪，请稍后再试', 'error'); return; }
    if (!next) { if (active && player.state.status === 'playing') void controller.pause().catch(report); return; }
    if (player.state.status === 'preparing') return;
    if (active && player.state.status === 'paused') void controller.resume().catch(report);
    else {
      const item = useDocumentStore.getState().project?.rundown.find((entry) => entry.id === itemId);
      const startMs = item?.playback?.startMs ?? 0;
      void controller.play(itemId, Math.max(startMs, cursorRef.current)).catch(report);
    }
  };
  const stop = (): void => { reset(); if (external) void player.controller?.stop().catch(report); };
  return { playheadMs, playing, setPlayheadMs, setPlaying, reset, audioRef, stop };
}
