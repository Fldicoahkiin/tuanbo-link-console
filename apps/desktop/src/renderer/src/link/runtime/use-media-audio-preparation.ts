import { useEffect, useRef } from 'react';
import { useDocumentStore } from '../stores/document-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { MediaAudioPreparation } from './media-audio-preparation';

export function useMediaAudioPreparation(blocked: boolean, notify: (message: string, tone: 'error', key?: string) => void): void {
  const blockedRef = useRef(blocked);
  const updateRef = useRef<(() => void) | null>(null);
  blockedRef.current = blocked;
  useEffect(() => {
    const preparation = new MediaAudioPreparation(request => linkDesktopViewModel.importReferenceAudio(request), message => {
      notify(message, 'error', 'media-audio-preparation');
      void linkDesktopViewModel.recordLog({ level: 'error', category: 'system', device: '素材准备', result: 'failed', message })
        .catch((error: unknown) => console.error('无法记录素材准备错误', error));
    });
    const update = (): void => {
      const document = useDocumentStore.getState();
      preparation.update({ documentId: document.documentId, projectPath: document.path,
        assets: document.project?.mediaAssets ?? [], idle: !blockedRef.current && useRuntimeStore.getState().state === 'idle' });
    };
    updateRef.current = update;
    const documentSubscription = useDocumentStore.subscribe(state => [state.documentId, state.path, state.project?.mediaAssets] as const, update,
      { equalityFn: (left, right) => left.every((value, index) => value === right[index]) });
    const runtimeSubscription = useRuntimeStore.subscribe(update);
    update();
    return () => { updateRef.current = null; documentSubscription(); runtimeSubscription(); preparation.dispose(); };
  }, [notify]);
  useEffect(() => { updateRef.current?.(); }, [blocked]);
}
