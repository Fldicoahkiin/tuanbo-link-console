import { useEffect, useRef } from 'react';
import { type SettingsCategory, type SettingsLocation } from './components/settings-navigation';

const fields = {
  'audio-output': '[aria-label="音乐监听设备"]',
  'lighting-mtc': '[aria-label="灯光 MIDI 输出"]',
  'lighting-actions': '[aria-label="灯光事件输出端口"]',
  'obs-connection': '[aria-label="OBS 连接设置"]',
  'ma2-connection': '[aria-label="MA2 连接设置"]'
} as const;

/** A fresh location object also retriggers navigation within the current settings page. */
export function useSettingsLocation(location: SettingsLocation | null, open: boolean, category: SettingsCategory) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !location || location.category !== category) return;
    const section = ref.current?.querySelector<HTMLElement>(`[data-settings-section="${category}"]`);
    if (!section) return;
    const field = location.focus ? section.querySelector<HTMLElement>(fields[location.focus]) : null;
    const target = field?.closest<HTMLElement>('.ui-field, .ui-switch, label') ?? field ?? section;
    // Port settings may be inside a closed disclosure. Open its ancestors before scrolling.
    for (let parent = target.parentElement; parent && parent !== ref.current; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    const oldTabIndex = target.getAttribute('tabindex');
    target.tabIndex = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
      target.focus({ preventScroll: true });
      // Restart the brief emphasis even when the same status is clicked again.
      target.classList.remove('settings-location-highlight');
      void target.offsetWidth;
      target.classList.add('settings-location-highlight');
      timer = setTimeout(() => target.classList.remove('settings-location-highlight'), 1400);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      target.classList.remove('settings-location-highlight');
      if (oldTabIndex === null) target.removeAttribute('tabindex'); else target.setAttribute('tabindex', oldTabIndex);
    };
  }, [location, open, category]);
  return { ref };
}
