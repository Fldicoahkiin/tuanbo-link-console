import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsCategory } from './settings-navigation';

export function SettingsNavigation({ selected, onSelect }: { selected: SettingsCategory; onSelect: (category: SettingsCategory) => void }): JSX.Element {
  const activeGroup = SETTINGS_SECTIONS.find((section) => section.id === selected)?.group;
  return <nav className="main-nav settings-submenus" aria-label="设置子菜单">{SETTINGS_GROUPS.map(({ id, name, icon: Icon }) => {
    const entries = SETTINGS_SECTIONS.filter((section) => section.group === id);
    return <button key={id} className={activeGroup === id ? 'active' : ''} aria-current={activeGroup === id ? 'true' : undefined} onClick={() => { if (activeGroup !== id) onSelect(entries[0]!.id); }}><Icon /><span><strong>{name}</strong></span></button>;
  })}</nav>;
}

export function SettingsSectionNavigation({ selected, onSelect }: { selected: SettingsCategory; onSelect: (category: SettingsCategory) => void }): JSX.Element {
  const activeGroup = SETTINGS_SECTIONS.find((section) => section.id === selected)!.group;
  const group = SETTINGS_GROUPS.find((entry) => entry.id === activeGroup)!;
  return <aside className="settings-section-sidebar"><h2>{group.name}</h2><nav className="main-nav" aria-label="设置子子菜单">{SETTINGS_SECTIONS.filter((section) => section.group === activeGroup).map(({ id, name, icon: Icon }) => <button key={id} className={selected === id ? 'active' : ''} aria-current={selected === id ? 'page' : undefined} onClick={() => onSelect(id)}><Icon /><span><strong>{name}</strong></span></button>)}</nav></aside>;
}
