import { useState } from 'react';
import { create } from 'zustand';

/**
 * The editor timeline's view preferences on this computer (0.5.9 E12, 05 设计第 5 节): whether parts snap. The toolbar's
 * magnet and N (`view.snap`) read and write it; it is kept in this computer's interface preferences, so it is the same
 * after the app opens again. The lighting workbench keeps its own snapping switch for its page, as before.
 */
export const SNAP_KEY = 'tblink.editor-snap';

/** The saved choice: on unless this computer turned it off. Storage that cannot be read counts as nothing saved. */
export function readSnapEnabled(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try { return storage?.getItem(SNAP_KEY) !== 'off'; } catch { return true; }
}

function writeSnapEnabled(storage: Pick<Storage, 'setItem'> | undefined, enabled: boolean): void {
  // Not saved (a private window, blocked storage): the switch still works for this run.
  try { storage?.setItem(SNAP_KEY, enabled ? 'on' : 'off'); } catch { return; }
}

const local = (): Storage | undefined => typeof localStorage === 'undefined' ? undefined : localStorage;

export const useTimelineViewStore = create<{ snapEnabled: boolean; setSnapEnabled: (enabled: boolean) => void; toggleSnap: () => void }>((set, get) => ({
  snapEnabled: readSnapEnabled(local()),
  setSnapEnabled: (snapEnabled) => { writeSnapEnabled(local(), snapEnabled); set({ snapEnabled }); },
  toggleSnap: () => get().setSnapEnabled(!get().snapEnabled)
}));

/** The timeline's snapping switch: the editor's from this store, the lighting workbench's its own for the page, as before. */
export function useTimelineSnap(lightingWorkspace: boolean): [boolean, (enabled: boolean) => void] {
  const [lighting, setLighting] = useState(true);
  const editor = useTimelineViewStore(state => state.snapEnabled), setEditor = useTimelineViewStore(state => state.setSnapEnabled);
  return lightingWorkspace ? [lighting, setLighting] : [editor, setEditor];
}
