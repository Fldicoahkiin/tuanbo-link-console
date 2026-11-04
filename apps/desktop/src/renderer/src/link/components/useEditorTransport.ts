import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { useSelectedProgram } from '../useSelectedProgram';
import { useDocumentStore } from '../stores/document-store';
import { LatestPosition } from '../runtime/latest-position';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import type { LinkRuntimeCoordinator } from '../runtime/link-runtime-coordinator';
import { useDisplayPreferences } from '../stores/display-preferences-store';
import { usePlayerClock } from '../usePlayerClock';

export function useEditorProgram(player: ProjectPlayer, external: boolean, notify: (message: string, tone?: 'info' | 'error') => void): string | null {
  const [selected, select] = useSelectedProgram(notify);
  useEffect(() => { if (external && player.state.itemId) select(player.state.itemId); }, [external, player.state.itemId, select]);
  return external && ['playing', 'paused', 'preparing'].includes(player.state.status) ? player.state.itemId ?? selected : selected;
}

/** The editor owns only its stopped cursor; the formal player owns audio and output. */
export function useEditorTransport(player: ProjectPlayer, itemId: string | null, external: boolean,
  notify: (message: string, tone?: 'info' | 'error', key?: string) => void, previewCoordinator: LinkRuntimeCoordinator | null = null, localAudioReady = true) {
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const [localPlaying, setLocalPlaying] = useState(false);
  useEffect(() => { useMa2SyncStore.setState({ previewPlaying: localPlaying }); return () => { useMa2SyncStore.setState({ previewPlaying: false }); }; }, [localPlaying]);
  const [seeking, setSeeking] = useState(false);
  const seekQueue = useRef<LatestPosition | null>(null);
  const resumeAfterSeek = useRef(false);
  useEffect(() => { setSeeking(false); return () => { seekQueue.current?.cancel(); seekQueue.current = null; }; }, [itemId, player.controller, previewCoordinator]);
  const active = external && player.state.itemId === itemId && ['playing', 'paused', 'preparing'].includes(player.state.status);
  const playerClock = usePlayerClock(player.view, active);
  const playheadMs = active && !seeking ? playerClock.positionMs : cursor;
  const playing = external ? active && player.state.status === 'playing' : localPlaying;
  const clock = player.controller?.clock;
  useEffect(() => { if (external && player.state.error) notify(player.state.error, 'error'); }, [external, player.state.error, notify]);
  useEffect(() => { if (external) notify(player.state.status === 'preparing' ? '' : player.state.notice ?? '', 'info', 'player-notice'); }, [external, player.state.notice, player.state.status, notify]);
  const report = (error: unknown): void => notify(error instanceof Error ? error.message : String(error), 'error');
  const reset = useCallback(() => { seekQueue.current?.cancel(); seekQueue.current = null; setSeeking(false); cursorRef.current = 0; setCursor(0); setLocalPlaying(false); }, []);
  const setPlayheadMs = (position: number): void => {
    cursorRef.current = position; setCursor(position);
    if (!external || !itemId) return;
    if (!active) {
      if (!previewCoordinator) return;
      setSeeking(true);
      if (!seekQueue.current) {
        resumeAfterSeek.current = false;
        seekQueue.current = new LatestPosition(
          target => previewCoordinator.previewEditor(itemId, target, useDisplayPreferences.getState().preciseSeeking),
          () => { seekQueue.current = null; setSeeking(false); if (resumeAfterSeek.current) void player.controller?.play(itemId, cursorRef.current).catch(report); },
          error => { resumeAfterSeek.current = false; report(error); });
      }
      seekQueue.current.push(position);
      return;
    }
    if (!player.controller) return;
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
    if (next && !external && !localAudioReady) { notify('音频还没准备好，请确认文件还在，并等它加载完成', 'error'); return; }
    // A console write in progress finishes on its own; playing never waits for it (2026-10-26) and later syncs wait for stop.
    if (seekQueue.current) { resumeAfterSeek.current = next; return; }
    if (!external) { useMa2SyncStore.setState({ previewPlaying: next }); setLocalPlaying(next); return; }
    const controller = player.controller;
    if (!controller || !itemId) { if (next) notify('播放器还没准备好，请稍后再试', 'error'); return; }
    if (!next) { if (active && player.state.status === 'playing') void controller.pause().catch(report); return; }
    if (player.state.status === 'preparing') return;
    if (active && player.state.status === 'paused') void controller.resume().catch(report);
    else {
      const item = useDocumentStore.getState().project?.rundown.find((entry) => entry.id === itemId);
      const startMs = item?.playback?.startMs ?? 0;
      void controller.play(itemId, Math.max(startMs, cursorRef.current)).catch(report);
    }
  };
  const stop = (): void => { reset(); previewCoordinator?.cancelEditorPreview(); if (external) void player.controller?.stop().catch(report); };
  const stopForEdit = async (): Promise<void> => {
    if (!external || player.state.status !== 'paused') return;
    if (seekQueue.current) throw new Error('正在定位，请等定位完成后再编辑音频');
    cursorRef.current = playheadMs; setCursor(playheadMs);
    await player.controller?.stop();
  };
  return { playheadMs, playing, setPlayheadMs, setPlaying, reset, clock, stop, stopForEdit };
}
