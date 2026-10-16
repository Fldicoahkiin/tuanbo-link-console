import { useCallback, useState } from 'react';
import { useSettingsSessionStore } from './stores/settings-session-store';

/** Leaving settings with unsaved edits asks for confirmation before discarding them. */
export function useSettingsExit(onLeave: () => void) {
  const [settingsExit, setSettingsExit] = useState<(() => void) | null>(null);
  const leaveSettings = useCallback((after?: () => void): void => {
    const leave = (): void => { useSettingsSessionStore.getState().reset(); onLeave(); setSettingsExit(null); after?.(); };
    if (Object.values(useSettingsSessionStore.getState().dirty).some(Boolean)) setSettingsExit(() => leave);
    else leave();
  }, [onLeave]);
  return { settingsExit, setSettingsExit, leaveSettings };
}
