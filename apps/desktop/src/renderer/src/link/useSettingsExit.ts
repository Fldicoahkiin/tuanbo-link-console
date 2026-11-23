import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react';

type Section = 'ma2' | 'obs' | 'maintenance';
type Save = () => Promise<boolean>;
export const SettingsSaves = createContext<Map<Section, Save> | null>(null);

/** Only mounted forms with local edits participate. */
export function useSettingsAutosave(section: Section, dirty: boolean, save: Save): void {
  const forms = useContext(SettingsSaves);
  useLayoutEffect(() => {
    if (!forms || !dirty) return;
    forms.set(section, save);
    return () => { forms.delete(section); };
  }, [forms, section, dirty, save]);
}

export function useSettingsExit(onLeave: () => void, onFailure: (section: Section) => void) {
  const forms = useRef(new Map<Section, Save>()).current;
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const leaveSettings = useCallback(async (after?: () => void): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    try {
      if (forms.size) setSaving(true);
      for (const [section, save] of [...forms]) {
        if (!await save()) { onFailure(section); return; }
      }
      onLeave();
      after?.();
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }, [forms, onLeave, onFailure]);
  return { forms, saving, leaveSettings };
}
