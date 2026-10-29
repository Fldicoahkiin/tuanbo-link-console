import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsCategory } from './settings-navigation';
import { useRef } from 'react';
import { usePendingUpdate } from '../view-models/update-availability';

/** Marks where a newer version waits; the toast already announced it, so screen readers skip the dot. */
export function UpdateDot({ version }: { version: string }): JSX.Element {
  return <span className="update-dot" title={`有新版本 ${version}`} aria-hidden="true" />;
}

/**
 * Settings navigation, one column (2026-10-28, pictures 4 to 6: a second column repeated the group,
 * so "设备连接" showed three times). Each group opens its pages right under it.
 */
export function SettingsNavigation({ selected, onSelect }: { selected: SettingsCategory; onSelect: (category: SettingsCategory) => void }): JSX.Element {
  const activeGroup = SETTINGS_SECTIONS.find((section) => section.id === selected)?.group;
  const lastVisited = useRef<Partial<Record<string, SettingsCategory>>>({});
  const pendingUpdate = usePendingUpdate();
  if (activeGroup) lastVisited.current[activeGroup] = selected;
  return <nav className="settings-submenus" aria-label="设置子菜单">{SETTINGS_GROUPS.map(({ id, name, icon: Icon }) => {
    const entries = SETTINGS_SECTIONS.filter((section) => section.group === id);
    const active = activeGroup === id;
    return <div className="settings-nav-group" key={id} data-open={active}>
      <button className={active ? 'active' : ''} aria-current={active ? 'true' : undefined} aria-expanded={active} onClick={() => { if (!active) onSelect(lastVisited.current[id] ?? entries[0]!.id); }}><Icon aria-hidden="true" /><span><strong>{name}</strong></span>{id === 'appearance' && pendingUpdate ? <UpdateDot version={pendingUpdate} /> : null}</button>
      {active ? <nav className="settings-nav-pages" aria-label="设置子子菜单">{entries.map(({ id: page, name: pageName }) => <button key={page} className={selected === page ? 'active' : ''} aria-label={pageName} aria-current={selected === page ? 'page' : undefined} onClick={() => onSelect(page)}><span><strong>{pageName}</strong></span>{page === 'updates' && pendingUpdate ? <UpdateDot version={pendingUpdate} /> : null}</button>)}</nav> : null}
    </div>;
  })}</nav>;
}
