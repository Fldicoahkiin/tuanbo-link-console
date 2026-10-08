import { useEffect, useMemo, useState } from 'react';
import { createLightingDocument, type LightingDocument, type RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { libraryTemplates, projectLightingLibrary } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';

export function useReferenceAudioUrl(input: {
  item: RundownItem | null;
  projectPath: string | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): string | null {
  const { item, notify, projectPath } = input;
  const relativePath = item?.referenceAudio?.relativePath;
  const sha256 = item?.referenceAudio?.sha256;
  const [resolved, setResolved] = useState<{ projectPath: string; relativePath: string; sha256: string; url: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!projectPath || !relativePath || !sha256) return;
    void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath })
      .then((url) => { if (!cancelled) setResolved({ projectPath, relativePath, sha256, url }); })
      .catch((error: unknown) => { if (!cancelled) notify(toMessage(error), 'error'); });
    return () => { cancelled = true; };
  }, [relativePath, sha256, notify, projectPath]);
  return resolved?.projectPath === projectPath && resolved.relativePath === relativePath && resolved.sha256 === sha256 ? resolved.url : null;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useLightingDocument(item: RundownItem | null): LightingDocument {
  const project = useDocumentStore(state => state.project);
  const itemId = item?.id; const lighting = item?.lighting; const durationMs = item?.referenceAudio?.durationMs;
  return useMemo(() => {
    const templates = project ? libraryTemplates(projectLightingLibrary(project)) : lighting?.templates ?? [];
    if (lighting) return { ...lighting, templates };
    const document = createLightingDocument();
    document.templates = templates;
    if (!itemId) return document;
    document.tracks.push({ id: crypto.randomUUID(), kind: 'ma2', name: '灯光', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: crypto.randomUUID(), name: '灯光编排', start: 0, duration: durationMs && durationMs > 0 ? durationMs : 60000, timeLock: 'time', events: [], muted: false }] });
    return document;
  }, [itemId, lighting, durationMs, project]);
}
