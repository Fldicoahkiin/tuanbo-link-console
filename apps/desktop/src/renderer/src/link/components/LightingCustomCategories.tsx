import { useMemo, useState } from 'react';
import { Folder, Plus, Trash2, Settings2, Sun, ScanLine, Sparkles } from 'lucide-react';
import { editLightingCategoryCommand, projectLightingLibrary, lightingCategoryNavigation, type LightingCategoryMenuItem } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { LightingCategoryManager } from './LightingCategoryManager';
import '../lighting-attributes.css';

export function LightingCustomCategories({ selected, selectedSection, onSelect, onSection }: { selected: string | null; selectedSection: 'front' | 'rim' | 'effect' | null; onSelect: (id: string | null) => void; onSection: (section: 'front' | 'rim' | 'effect') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const categories = useMemo(() => project ? projectLightingLibrary(project).categories.filter(category => category.custom) : [], [project]);
  const items = useMemo(() => project ? lightingCategoryNavigation(projectLightingLibrary(project)) : [], [project]);
  const [managing, setManaging] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState('');
  const save = (name: string | null): void => {
    if (!editing) return;
    try {
      useDocumentStore.getState().execute(editLightingCategoryCommand(editing.id, name));
      if (name !== null) onSelect(editing.id); else if (selected === editing.id) onSelect(null);
      setEditing(null); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const renderItem = (item: LightingCategoryMenuItem): JSX.Element => {
    const Icon = item.kind === 'category' ? Folder : item.section === 'front' ? Sun : item.section === 'rim' ? ScanLine : Sparkles;
    return <button key={item.id} data-section={item.kind === 'category' ? 'effect' : item.section} aria-pressed={item.kind === 'category' ? selected === item.categoryId : selectedSection === item.section} title={item.name} onClick={() => item.kind === 'category' ? onSelect(item.categoryId) : onSection(item.section)} onContextMenu={event => { event.preventDefault(); if (item.kind === 'category') setEditing({ id: item.categoryId, name: item.name }); else setManaging(true); }}><Icon/><span>{item.name}</span></button>;
  };
  return <>
    {items.filter(item => item.display === 'common').map(renderItem)}
    {items.some(item => item.display === 'more') ? <details className="lighting-more-categories"><summary>更多分类</summary>{items.filter(item => item.display === 'more').map(renderItem)}</details> : null}
    <button onClick={() => setManaging(true)}><Settings2/><span>分类管理</span></button>
    <button onClick={() => setEditing({ id: crypto.randomUUID(), name: '' })}><Plus/><span>新建分类</span></button>
    {editing ? <form className="lighting-custom-category-form" aria-label="编辑自定义分类" onSubmit={event => { event.preventDefault(); save(editing.name); }}><input aria-label="自定义分类名称" autoFocus maxLength={64} required value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })}/><footer><button type="submit">保存</button><button type="button" onClick={() => setEditing(null)}>取消</button>{categories.some(category => category.id === editing.id) ? <button type="button" aria-label="删除此分类" title="只删除分类，保留 Cue" onClick={() => save(null)}><Trash2/></button> : null}</footer>{error ? <small role="alert">{error}</small> : null}</form> : null}
    {managing ? <LightingCategoryManager items={items} onClose={() => setManaging(false)} onHidden={item => { if (item.kind === 'category' ? selected === item.categoryId : selectedSection === item.section) onSelect(null); }}/> : null}
  </>;
}
