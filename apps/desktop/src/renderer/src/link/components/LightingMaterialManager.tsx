import { useState } from 'react';
import { ArrowUp, ArrowDown, Plus, Trash2, X, Search, Layers, Tags, Folder, LayoutGrid, List } from 'lucide-react';
import type { LightingDocument } from '@tb/schema';
import { ModalSurface } from '../ui/ModalSurface';

export function LightingMaterialManager({ document, categories, onChange, onSave, onClose }: {
  document: LightingDocument; categories: string[]; onChange: (document: LightingDocument, label: string) => void;
  onSave: (names: string[]) => void; onClose: () => void;
}): JSX.Element {
  const [names, setNames] = useState(categories);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'materials' | 'categories'>('materials');
  const [category, setCategory] = useState<string | null>(null);
  const [layout, setLayout] = useState<'list' | 'grid'>('list');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const move = <T,>(values: T[], index: number, delta: number): T[] => {
    const next = [...values]; const target = index + delta;
    if (target < 0 || target >= values.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!]; return next;
  };
  return <ModalSurface label="素材管理" className="cue-point-dialog" onClose={onClose}><form className="effect-binding-form material-preferences" onSubmit={event => {
    event.preventDefault(); const values = names.map(name => name.trim());
    if (values.some(name => !name || name.length > 64 || ['全部', '组合', '收藏', '待分类'].includes(name)) || new Set(values).size !== values.length) { setError('分类名称不能重复，长度为 1–64 个字。'); return; }
    onSave(values);
  }}>
    <nav className="material-manager-nav" aria-label="素材管理子菜单">
      <button type="button" aria-label="全部素材" aria-current={view === 'materials' && category === null ? 'page' : undefined} onClick={() => { setView('materials'); setCategory(null); }}><Layers />全部素材<span>{document.templates.length}</span></button>
      <div className="material-bin-list">{categories.map(name => <button key={name} type="button" aria-current={view === 'materials' && category === name ? 'page' : undefined} onClick={() => { setView('materials'); setCategory(name); }}><Folder /><span className="material-bin-name">{name}</span><small>{document.templates.filter(effect => effect.categories?.includes(name)).length}</small></button>)}</div>
      <button type="button" aria-label="分类管理" aria-current={view === 'categories' ? 'page' : undefined} onClick={() => setView('categories')}><Tags />分类管理<span>{names.length}</span></button>
    </nav>
    <div className="material-manager-content">
    <div className="material-manager-toolbar">
      {view === 'materials' ? <><label className="material-manager-search"><Search /><input aria-label="搜索管理素材" placeholder="搜索素材名称" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="material-manager-note">{category ?? '全部素材'}</span><div className="material-view-switch" role="group" aria-label="素材显示方式"><button type="button" aria-label="列表视图" title="列表视图" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List /></button><button type="button" aria-label="网格视图" title="网格视图" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid /></button></div></> : <><label className="material-manager-search"><Plus /><input aria-label="新分类" placeholder="新增分类" value={draft} onChange={event => setDraft(event.target.value)} /></label><button type="button" aria-label="添加分类" disabled={!draft.trim()} onClick={() => { setNames([...names, draft.trim()]); setDraft(''); }}>添加</button><span className="material-manager-note">{names.length} 个分类</span><button className="primary-action" disabled={names.length === categories.length && names.every((name, index) => name === categories[index])}>保存分类</button></>}
      <button type="button" className="material-manager-close" title="返回素材库" aria-label="返回素材库" onClick={onClose}><X /></button>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {view === 'materials' ? <section className="preference-section material-browser-list" data-layout={layout} aria-label="素材列表"><div className="material-table-heading"><span>名称</span><span>序列 / Cue</span><span>分类</span><span>操作</span></div><div className="preference-rows">
      {document.templates.map((effect, index) => effect.name.toLowerCase().includes(query.trim().toLowerCase()) && (category === null || effect.categories?.includes(category)) ? <div className="preference-row material-asset-row" key={effect.id}>{layout === 'grid' ? <div className="material-cue-tile"><Layers /><span>{effect.members ? `${effect.members.length} 个 Cue` : effect.track.cueStamp?.mode === 'fixed' ? `Cue ${effect.track.cueStamp.cue}` : '灯光素材'}</span></div> : null}<input aria-label={`素材名称 ${effect.name}`} defaultValue={effect.name} onBlur={event => { const name = event.target.value.trim(); if (!name) { event.target.value = effect.name; return; } if (name !== effect.name) onChange({ ...document, templates: document.templates.map(value => value.id === effect.id ? { ...value, name, track: { ...value.track, name } } : value) }, '重命名素材'); }} /><span className="material-asset-reference">{effect.members ? `${effect.members.length} 个 Cue` : effect.track.cueStamp?.mode === 'fixed' ? `${effect.track.cueStamp.sequence} / ${effect.track.cueStamp.cue}` : '—'}</span><span className="material-asset-category">{effect.categories?.join(' / ') || '未分类'}</span><div className="row-actions"><button type="button" title="上移" aria-label={`上移 ${effect.name}`} disabled={!index} onClick={() => onChange({ ...document, templates: move(document.templates, index, -1) }, '调整素材顺序')}><ArrowUp /></button><button type="button" title="下移" aria-label={`下移 ${effect.name}`} disabled={index === document.templates.length - 1} onClick={() => onChange({ ...document, templates: move(document.templates, index, 1) }, '调整素材顺序')}><ArrowDown /></button><button type="button" title="从素材库移除，保留已编好的 Cue" aria-label={`删除素材 ${effect.name}`} onClick={() => onChange({ ...document, templates: document.templates.filter(value => value.id !== effect.id) }, '删除库中素材')}><Trash2 /></button></div></div> : null)}
      {!document.templates.some(effect => effect.name.toLowerCase().includes(query.trim().toLowerCase()) && (category === null || effect.categories?.includes(category))) ? <p className="preference-empty">{query ? '没有匹配的素材' : category ? '此分类暂无素材' : '还没有素材，读取控台后可以添加'}</p> : null}
    </div></section> : <section className="preference-section material-category-list" aria-label="分类列表">
    <div className="material-category-heading"><span>排序</span><span>分类名称</span><span>操作</span></div><div className="preference-rows">{names.map((name, index) => <div className="preference-row" key={index}><span className="material-row-index">{String(index + 1).padStart(2, '0')}</span><input aria-label={`分类名称 ${index + 1}`} value={name} onChange={event => setNames(names.map((value, i) => i === index ? event.target.value : value))} /><div className="row-actions"><button type="button" title="上移" aria-label={`上移分类 ${index + 1}`} disabled={!index} onClick={() => setNames(move(names, index, -1))}><ArrowUp /></button><button type="button" title="下移" aria-label={`下移分类 ${index + 1}`} disabled={index === names.length - 1} onClick={() => setNames(move(names, index, 1))}><ArrowDown /></button><button type="button" title="删除分类" aria-label={`删除分类 ${index + 1}`} onClick={() => setNames(names.filter((_, i) => i !== index))}><Trash2 /></button></div></div>)}
    </div></section>}
    </div>
  </form></ModalSurface>;
}
