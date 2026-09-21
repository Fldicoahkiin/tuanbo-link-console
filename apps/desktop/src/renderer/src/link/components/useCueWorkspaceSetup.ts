import { useEffect, useMemo, type Dispatch, type SetStateAction } from 'react';
import { createLightingDocument, type LightingDocument, type RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function useReferenceAudioUrl(input: {
  item: RundownItem | null;
  projectPath: string | null;
  setAudioUrl: Dispatch<SetStateAction<string | null>>;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): void {
  const { item, notify, projectPath, setAudioUrl } = input;
  const relativePath = item?.referenceAudio?.relativePath;
  const sha256 = item?.referenceAudio?.sha256;
  useEffect(() => {
    let cancelled = false;
    if (!projectPath || !relativePath) {
      setAudioUrl(null);
      return;
    }
    void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath })
      .then((url) => { if (!cancelled) setAudioUrl(url); })
      .catch((error: unknown) => { if (!cancelled) notify(toMessage(error), 'error'); });
    return () => { cancelled = true; };
  }, [relativePath, sha256, notify, projectPath, setAudioUrl]);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLightingDocument(item: RundownItem | null): LightingDocument {
  const itemId = item?.id; const lighting = item?.lighting; const durationMs = item?.referenceAudio?.durationMs;
  return useMemo(() => {
    if (lighting) return lighting;
    const document = createLightingDocument();
    if (!itemId) return document;
    document.tracks.push({ id: crypto.randomUUID(), kind: 'ma2', name: '灯光', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: crypto.randomUUID(), name: '灯光编排', start: 0, duration: durationMs && durationMs > 0 ? durationMs : 60000, timeLock: 'time', events: [], muted: false }] });
    return document;
  }, [itemId, lighting, durationMs]);
}
