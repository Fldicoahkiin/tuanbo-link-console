import { DEVICE_WORKFLOW_GROUPS, SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsCategory } from './settings-navigation';

const deviceHints: Partial<Record<SettingsCategory, string>> = {
  songs: 'P1 / 本地歌曲', audio: '音频 / 时间码', obs: '画面 / 机位', ma2: '读取 / 编辑灯光',
  virtual: '软件之间连接', maintenance: '启动 / 预览修复', logs: '查看 / 导出'
};

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
  const renderEntry = (id: SettingsCategory): JSX.Element => {
    const { name, icon: Icon } = SETTINGS_SECTIONS.find(section => section.id === id)!;
    return <button key={id} data-device-category={activeGroup === 'devices' ? id : undefined} className={selected === id ? 'active' : ''} aria-label={name} aria-current={selected === id ? 'page' : undefined} onClick={() => onSelect(id)}><Icon /><span><strong>{name}</strong>{activeGroup === 'devices' ? <small>{deviceHints[id]}</small> : null}</span></button>;
  };
  return <aside className="settings-section-sidebar"><h2>{group.name}</h2><nav className="main-nav" aria-label="设置子子菜单">{activeGroup === 'devices' ? DEVICE_WORKFLOW_GROUPS.map(section => <div className="device-workflow-group" key={section.name}><h3>{section.name}</h3>{section.entries.map(renderEntry)}</div>) : SETTINGS_SECTIONS.filter(section => section.group === activeGroup).map(section => renderEntry(section.id))}</nav></aside>;
}
