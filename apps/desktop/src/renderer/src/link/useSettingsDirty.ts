import { useEffect } from 'react';
import { useSettingsSessionStore } from './stores/settings-session-store';

export function useSettingsDirty(section: string, dirty: boolean): void {
  useEffect(() => {
    useSettingsSessionStore.getState().setDirty(section, dirty);
    return () => useSettingsSessionStore.getState().setDirty(section, false);
  }, [section, dirty]);
}
