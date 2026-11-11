import { useEffect, useMemo, useState } from 'react';
import { createLightingDocument, type LightingDocument, type RundownItem } from '@tb/schema';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { libraryTemplates, projectLightingLibrary } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { matchedReferenceAudioUrl, type ResolvedReferenceAudioUrl } from './reference-audio-link';

/** The only way a page gets the link of a song's audio (home player and editors). */
export function useReferenceAudioUrl(input: {
  item: RundownItem | null;
  projectPath: string | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): string | null {
  const { item, notify, projectPath } = input;
  const relativePath = item?.referenceAudio?.relativePath;
  const sha256 = item?.referenceAudio?.sha256;
  const [resolved, setResolved] = useState<ResolvedReferenceAudioUrl | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (!projectPath || !relativePath || !sha256) return;
    void linkDesktopViewModel.resolveReferenceAudioUrl({ projectPath, relativePath })
      .then((url) => { if (!cancelled) setResolved({ projectPath, relativePath, sha256, url }); })
      .catch((error: unknown) => { if (!cancelled) notify(toMessage(error), 'error'); });
    return () => { cancelled = true; };
  }, [relativePath, sha256, notify, projectPath]);
  return matchedReferenceAudioUrl(resolved, projectPath, item?.referenceAudio);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The ids of the lighting track a song without lighting starts with, one pair per song for the whole session: the
 * placeholder stays the same until the song's length or the library changes, and a point added to it lands on the
 * track and clip selected before (0.5.9 E3; before, every edit anywhere made new ones).
 */
const placeholderIds = new Map<string, { trackId: string; clipId: string }>();

function placeholderLighting(itemId: string, durationMs: number | undefined, templates: LightingDocument['templates']): LightingDocument {
  let ids = placeholderIds.get(itemId);
  if (!ids) { ids = { trackId: crypto.randomUUID(), clipId: crypto.randomUUID() }; placeholderIds.set(itemId, ids); }
  const document = createLightingDocument();
  document.templates = templates;
  document.tracks.push({ id: ids.trackId, kind: 'ma2', name: '灯光', color: '#ba8fff', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: ids.clipId, name: '灯光编排', start: 0, duration: durationMs && durationMs > 0 ? durationMs : 60000, timeLock: 'time', events: [], muted: false }] });
  return document;
}

/** No song: an empty document, the same one every time. */
const NO_SONG_LIGHTING: LightingDocument = createLightingDocument();

export function useLightingDocument(item: RundownItem | null): LightingDocument {
  const project = useDocumentStore(state => state.project);
  const itemId = item?.id; const lighting = item?.lighting; const durationMs = item?.referenceAudio?.durationMs;
  // Worked out once per edit; with a user library they are cached by it (core lighting-library.ts), the same object between edits.
  const library = useMemo(() => project ? libraryTemplates(projectLightingLibrary(project)) : undefined, [project]);
  const templates = library ?? lighting?.templates;
  return useMemo(() => {
    if (lighting) return { ...lighting, templates: templates ?? [] };
    if (!itemId) return templates ? { ...NO_SONG_LIGHTING, templates } : NO_SONG_LIGHTING;
    return placeholderLighting(itemId, durationMs, templates ?? []);
  }, [itemId, lighting, durationMs, templates]);
}
