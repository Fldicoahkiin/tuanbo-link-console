import { useEffect, useRef, useState } from 'react';
import type { RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import type { ProjectPlayer } from './ProjectPlayerControls';
import { recoverProgramAudio } from './recover-program-audio';

export function usePlayProgram(player: ProjectPlayer, busy: boolean, setBusy: (busy: boolean) => void, playlistId: string, select: (id: string) => void, notify: (message: string, tone?: 'info' | 'error') => void) {
  const processing = useRef(false);
  const [pending, setPending] = useState<{ id: string; documentId: number; controller: ProjectPlayer['controller'] } | null>(null);
  const documentId = useDocumentStore(state => state.documentId);
  useEffect(() => {
    if (!pending) return;
    if (pending.documentId !== documentId) { setPending(null); return; }
    // Updating audio creates a new controller; never replay through the old
    // controller's immutable, audio-less project snapshot.
    if (!player.controller || player.controller === pending.controller) return;
    const item = useDocumentStore.getState().project?.rundown.find(entry => entry.id === pending.id);
    setPending(null);
    if (!item?.referenceAudio || !item.enabled) return;
    player.controller.setPlaylist(playlistId); select(item.id); void player.controller.play(item.id);
  }, [pending, documentId, player.controller, playlistId, select]);
  return (item: RundownItem): void => {
    if (busy || pending || processing.current || !player.controller) { notify('正在准备播放，请稍候'); return; }
    if (!item.enabled) return;
    if (item.referenceAudio) { player.controller.setPlaylist(playlistId); select(item.id); void player.controller.play(item.id); return; }
    const controller = player.controller;
    processing.current = true; setBusy(true);
    void (async () => {
      try {
        await controller.stop();
        if (useDocumentStore.getState().documentId !== documentId) throw new Error('工程已切换，已取消恢复音轨');
        notify(`正在从“${item.title}”的已有视频恢复原声音轨…`);
        await recoverProgramAudio(item.id);
        setPending({ id: item.id, documentId, controller });
      } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
      finally { processing.current = false; setBusy(false); }
    })();
  };
}
