import { useMemo, useRef, useState } from 'react';
import { isShowWait, songPaddingLimits, songPaddingRefusal, toUserErrorMessage } from '@tb/core/link';
import type { RundownItem } from '@tb/schema';
import { useDocumentStore, useSongAudioEditWait } from '../stores/document-store';
import { currentShowWait, useShowGate } from '../stores/show-state-store';
import { PADDING_SYNC_FIRST, useMa2PaddingWait } from '../runtime/ma2-song-shift';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { PADDING_RENDERING, padSongSteps, songPaddingState, type SongPaddingState } from './song-padding-flow';

export type SongPadding = SongPaddingState & {
  item: RundownItem | null;
  /** The song's blank time and how far it can go, at the project's frame rate (core songPaddingLimits); null without audio. */
  limits: ReturnType<typeof songPaddingLimits>;
  frameRate: NonNullable<ReturnType<typeof useDocumentStore.getState>['project']>['timebase']['frameRate'];
  /** 正在生成音频… while the main process makes the audio. */
  status: string | null;
  /** Why the last padding was not made; cleared by the next one. */
  error: string | null;
  /** Adds (or takes away) `leadDeltaMs` before the music and leaves `tailMs` after it: one undo step. */
  pad: (leadDeltaMs: number, tailMs: number) => Promise<void>;
  /** Why this padding cannot be made now, or null: the page's wait first, then the song's own limits (core songPaddingRefusal). */
  refusal: (leadDeltaMs: number, tailMs: number) => string | null;
  /** A blocked handle pressed: says why, as the handle's tooltip does. */
  explain: () => void;
};

/**
 * The song's blank time in the editor (0.5.9 E15): what the handles and the fields may do now, and padding it. A
 * failure is shown on the page and in a toast and written to the run log; nothing is tried again.
 */
export function useSongPadding(item: RundownItem | null, notify: (message: string, tone?: 'info' | 'error') => void): SongPadding {
  const project = useDocumentStore(state => state.project);
  const projectPath = useDocumentStore(state => state.path);
  const documentId = useDocumentStore(state => state.documentId);
  const frameRate = project?.timebase.frameRate ?? '25';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const making = useRef(false);
  const stageWait = useSongAudioEditWait(item?.id ?? null);
  const render = useShowGate('audio.render');
  const syncWait = useMa2PaddingWait(item?.id ?? null, documentId);
  const state = songPaddingState({ hasAudio: Boolean(item?.referenceAudio), internal: project?.playbackSource === 'internal',
    stageWait, renderWait: render.kind === 'wait' ? render.message : null, syncWait, busy });
  const limits = useMemo(() => item ? songPaddingLimits(item, frameRate) : null, [item, frameRate]);
  const latest = useRef(state);
  latest.current = state;
  const pad = async (leadDeltaMs: number, tailMs: number): Promise<void> => {
    if (!item || making.current) return;
    making.current = true; setBusy(true); setError(null);
    try {
      await padSongSteps({ itemId: item.id, leadDeltaMs, tailMs }, {
        project: () => useDocumentStore.getState().project, projectPath,
        // Asked again at the release: the show or the console may have changed since the page was drawn.
        // This padding's own 正在生成音频… is no reason to refuse it.
        blocked: () => {
          const blocked = latest.current.blocked;
          return (blocked === PADDING_RENDERING ? null : blocked) ?? currentShowWait('audio.render');
        },
        render: request => linkDesktopViewModel.renderAudioSegments(request),
        execute: command => useDocumentStore.getState().execute(command)
      });
    } catch (cause) {
      const message = toUserErrorMessage(cause);
      // Only a wait (the show, the console sync first): said, not a failure, not logged.
      if (isShowWait(cause) || message === PADDING_SYNC_FIRST) { notify(message, 'info'); return; }
      setError(message);
      notify(message, 'error');
      void linkDesktopViewModel.recordLog({ level: 'error', category: 'operator', message: `「${item.title}」加空白没有成功：${message}`,
        ...(project ? { projectId: project.projectId } : {}), itemId: item.id }).catch((logError: unknown) => setError(`${message}；运行日志写入失败：${toUserErrorMessage(logError)}`));
    } finally { making.current = false; setBusy(false); }
  };
  const explain = (): void => { if (state.blocked) notify(state.blocked, 'info'); };
  const refusal = (leadDeltaMs: number, tailMs: number): string | null => {
    const current = useDocumentStore.getState().project;
    return state.blocked ?? (item && current ? songPaddingRefusal(current, item.id, leadDeltaMs, tailMs) : '还没打开工程');
  };
  return { ...state, item, limits, frameRate, status: busy ? PADDING_RENDERING : null, error, pad, refusal, explain };
}
