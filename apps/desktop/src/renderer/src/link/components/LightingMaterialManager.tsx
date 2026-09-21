import { useState } from 'react';
import { ArrowUp, ArrowDown, Plus, Trash2 } from 'lucide-react';
import type { LightingDocument } from '@tb/schema';

export function LightingMaterialManager({ document, categories, onChange, onSave, onClose }: {
  document: LightingDocument; categories: string[]; onChange: (document: LightingDocument, label: string) => void;
  onSave: (names: string[]) => void; onClose: () => void;
}): JSX.Element {
  const [names, setNames] = useState(categories);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const move = <T,>(values: T[], index: number, delta: number): T[] => {
    const next = [...values]; const target = index + delta;
    if (target < 0 || target >= values.length) return next;
    [next[index], next[target]] = [next[target]!, next[index]!]; return next;
  };
  return <div className="effect-binding-backdrop"><form className="effect-binding-form material-preferences" onSubmit={event => {
    event.preventDefault(); const values = names.map(name => name.trim());
    if (values.some(name => !name || name.length > 64 || ['全部', '组合', '收藏', '待分类'].includes(name)) || new Set(values).size !== values.length) { setError('请使用不重复的分类名称，长度为 1–64 字。'); return; }
    onSave(values);
  }}>
    <section className="preference-section"><h4>素材 <small>{document.templates.length}</small></h4><div className="preference-rows">
      {document.templates.map((effect, index) => <div className="preference-row" key={effect.id}><input aria-label={`素材名称 ${effect.name}`} defaultValue={effect.name} onBlur={event => { const name = event.target.value.trim(); if (!name) { event.target.value = effect.name; return; } if (name !== effect.name) onChange({ ...document, templates: document.templates.map(value => value.id === effect.id ? { ...value, name, track: { ...value.track, name } } : value) }, '重命名素材'); }} /><div className="row-actions"><button type="button" title="上移" aria-label={`上移 ${effect.name}`} disabled={!index} onClick={() => onChange({ ...document, templates: move(document.templates, index, -1) }, '调整素材顺序')}><ArrowUp /></button><button type="button" title="下移" aria-label={`下移 ${effect.name}`} disabled={index === document.templates.length - 1} onClick={() => onChange({ ...document, templates: move(document.templates, index, 1) }, '调整素材顺序')}><ArrowDown /></button><button type="button" title="删除素材" aria-label={`删除素材 ${effect.name}`} onClick={() => onChange({ ...document, templates: document.templates.filter(value => value.id !== effect.id) }, '删除库中素材')}><Trash2 /></button></div></div>)}
      {!document.templates.length ? <p className="preference-empty">还没有素材。从“添加素材”或“读取控台”开始。</p> : null}
    </div><p className="preference-hint">移除素材不会删除已编好的 Cue。</p></section>
    <section className="preference-section"><h4>分类菜单</h4><div className="preference-rows">{names.map((name, index) => <div className="preference-row" key={index}><input aria-label={`分类名称 ${index + 1}`} value={name} onChange={event => setNames(names.map((value, i) => i === index ? event.target.value : value))} /><div className="row-actions"><button type="button" title="上移" aria-label={`上移分类 ${index + 1}`} disabled={!index} onClick={() => setNames(move(names, index, -1))}><ArrowUp /></button><button type="button" title="下移" aria-label={`下移分类 ${index + 1}`} disabled={index === names.length - 1} onClick={() => setNames(move(names, index, 1))}><ArrowDown /></button><button type="button" title="删除分类" aria-label={`删除分类 ${index + 1}`} onClick={() => setNames(names.filter((_, i) => i !== index))}><Trash2 /></button></div></div>)}
    <div className="preference-row"><input aria-label="新分类" placeholder="添加分类…" value={draft} onChange={event => setDraft(event.target.value)} /><button type="button" className="row-icon" aria-label="添加分类" title="添加分类" disabled={!draft.trim()} onClick={() => { setNames([...names, draft.trim()]); setDraft(''); }}><Plus /></button></div></div><p className="preference-hint">按列表顺序显示。菜单设置保存在这台电脑。</p></section>
    {error ? <p role="alert">{error}</p> : null}<footer><button type="button" onClick={onClose}>返回素材库</button><button className="primary-action">保存菜单</button></footer>
  </form></div>;
}
