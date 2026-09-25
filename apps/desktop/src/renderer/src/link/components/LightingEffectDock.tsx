import { LightingMaterialManager } from './LightingMaterialManager';

import { LightingCueComposer, cueIngredients, type CueIngredient } from './LightingCueComposer';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, Settings2, Download, Search, Trash2, Layers, Star } from 'lucide-react';
import { Ma2EffectImport } from './Ma2EffectImport';
import { FIXTURE_CATEGORIES } from './LightingFixtureMapping';
import { LightingEffectCombination } from './LightingEffectCombination';
import { lightingTrackSchema, type LightingDocument } from '@tb/schema';

export const EFFECT_DRAG = 'application/x-tblink-lighting-effect';
export function LightingEffectDock({ document, disabled, onChange, eventId, ms, durationMs, onNew, headerActions, externalPanel, onLibrary, cueSelectionVersion, pointDetails }: {
  pointDetails: boolean; cueSelectionVersion: number; externalPanel?: ReactNode; onLibrary: () => void; headerActions?: ReactNode; document: LightingDocument; disabled: boolean; eventId?: string | undefined; ms: number; durationMs: number; onNew: () => void;
  onStamp: (id: string) => void; onChange: (document: LightingDocument, label: string) => boolean | void;
}): JSX.Element {
  const [ingredients, setIngredients] = useState<CueIngredient[]>([]);
  const loadedCue = useRef('');
  useEffect(() => {
    const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => event.id === eventId || event.effectGroupId === eventId && eventId !== undefined)));
    const key = `${eventId ?? 'new'}:${JSON.stringify(events)}`;
    if (loadedCue.current === key) return;
    loadedCue.current = key;
    setIngredients(cueIngredients(document, eventId));
  }, [eventId, document]);
  const [menus, setMenus] = useState(() => (localStorage.getItem('lighting-material-menus') ?? FIXTURE_CATEGORIES.join('\n')).split('\n').filter(Boolean));
  const [managing, setManaging] = useState(false);
  const categories = [...new Set([...menus, ...document.templates.flatMap(effect => effect.categories ?? []).filter(value => !localStorage.getItem('lighting-material-menus') || menus.includes(value))])];
  const addIngredient = (id: string): void => {
    const effect = document.templates.find(entry => entry.id === id); const binding = effect?.track.cueStamp;
    if (!effect || binding?.mode !== 'fixed') return;
    if (!/^[1-9]\d*\.[1-9]\d*$/.test(binding.executor)) { setError(`“${effect.name}”尚未绑定执行器，请先打开素材配置填写。`); return; }
    const values = effect.members ?? [{ name: effect.name, sequence: binding.sequence, cue: binding.cue, executor: binding.executor, delayMs: 0 }];
    setIngredients(current => [...current.filter(entry => !values.some(value => value.executor === entry.executor)), ...values.map(value => ({ ...value, delayMs: 0 }))]);
  };
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('全部');
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [combining, setCombining] = useState(false);
  useEffect(() => { setManaging(false); setImporting(false); setCombining(false); setEditing(null); }, [cueSelectionVersion]);
  const resetPanels = (): void => { setManaging(false); setImporting(false); setCombining(false); setEditing(null); };
  const openPanel = (panel: 'manage' | 'import' | 'edit' | 'combine'): void => {
    onLibrary(); resetPanels(); setError('');
    if (panel === 'manage') setManaging(true);
    if (panel === 'import') setImporting(true);
    if (panel === 'edit') setEditing('新增效果');
    if (panel === 'combine') setCombining(true);
  };
  const effects = document.templates.filter(entry => entry.track.cueStamp?.mode === 'fixed');
  const save = (form: HTMLFormElement): void => {
    try {
      const data = new FormData(form); const text = (key: string): string => { const value = data.get(key); if (typeof value !== 'string') throw new Error('缺少字段'); return value; }; const name = text('name').trim();
      const track = lightingTrackSchema.parse({ id: crypto.randomUUID(), name, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: Number(data.get('sequence')), cue: text('cue'), executor: text('executor') } });
      const old = effects.find(entry => entry.id === editing);
      onChange({ ...document, templates: [...document.templates.filter(entry => entry.id !== old?.id), { ...old, id: old?.id ?? crypto.randomUUID(), name, track, categories: data.getAll('category').filter((value): value is string => typeof value === 'string') }] }, '保存灯光效果');
      setEditing(null); setError('');
    } catch { setError('请填写效果名称、有效的序列 / Cue 编号和执行器，例如 1.101。'); }
  };
  const current = effects.find(entry => entry.id === editing);
  const binding = current?.track.cueStamp;
  const visible = effects.filter(effect => effect.name.toLowerCase().includes(query.toLowerCase()) && (category === '全部' || (category === '收藏' ? effect.favorite : category === '组合' ? effect.members : category === '待分类' ? !effect.categories?.some(value => categories.includes(value)) : effect.categories?.includes(category))));
  return <section className="lighting-effect-dock" aria-label="灯光效果库" data-details={pointDetails} data-panel={Boolean(externalPanel || managing || importing || combining || editing)}>
    <div className="cue-material-browser">
    <div className="effect-library-filter"><label className="effect-search"><Search /><input aria-label="搜索效果" placeholder="搜索效果" value={query} onChange={event => { setQuery(event.target.value); setError(''); }} /></label><nav aria-label="灯具分类">{['全部', ...categories, '组合', '收藏', '待分类'].map(value => <button key={value} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</nav></div>
    {error && !editing ? <p role="alert">{error}</p> : null}
    <div className="lighting-effect-cards">
      {visible.map(effect => <div className={`lighting-effect-card${selected.includes(effect.id) ? ' is-selected' : ''}`} key={effect.id}><input type="checkbox" aria-label={`选择效果 ${effect.name}`} checked={selected.includes(effect.id)} disabled={disabled} onChange={event => setSelected(event.target.checked ? [...selected, effect.id] : selected.filter(id => id !== effect.id))} /><button title={effect.track.cueStamp?.mode === 'fixed' && !effect.track.cueStamp.executor ? '请先配置执行器' : effect.members ? `${effect.members.length} 个 Cue · 点击加入当前组合，拖到波形上打点` : '点击加入当前组合，拖到波形上打点'} draggable={effect.track.cueStamp?.mode === 'fixed' && Boolean(effect.track.cueStamp.executor)} onDragStart={event => { event.dataTransfer.setData(EFFECT_DRAG, effect.id); event.dataTransfer.effectAllowed = 'copy'; }} onClick={() => addIngredient(effect.id)}><strong>{effect.name}</strong><small>{effect.members ? `${effect.members.length} 个 Cue` : effect.track.cueStamp?.mode === 'fixed' ? `${effect.track.cueStamp.sequence} / ${effect.track.cueStamp.cue}${effect.track.cueStamp.executor ? '' : ' · 待绑定'}` : ''}</small></button><button className="effect-settings" aria-label={`收藏 ${effect.name}`} aria-pressed={effect.favorite === true} disabled={disabled} onClick={() => onChange({ ...document, templates: document.templates.map(value => value.id === effect.id ? { ...value, favorite: !value.favorite } : value) }, '收藏灯光效果')}><Star /></button><button className="effect-settings" aria-label={`配置 ${effect.name}`} disabled={disabled} onClick={() => setEditing(effect.id)}><Settings2 /></button></div>)}
      {!visible.length ? <div className="effect-empty"><Layers aria-hidden="true" /><strong>{effects.length ? '未找到匹配素材' : '建立你的灯光素材库'}</strong><span>{effects.length ? '清除搜索和分类，查看全部素材。' : '从控台读取，或添加已有 Cue。'}</span>{effects.length ? <button onClick={() => { setQuery(''); setCategory('全部'); }}>清除筛选</button> : <button disabled={disabled} onClick={() => openPanel('edit')}>添加素材</button>}</div> : null}
    </div>
    </div><LightingCueComposer details={pointDetails} onAddMaterials={onLibrary} key={eventId ?? "new"} document={document} eventId={eventId} ms={ms} durationMs={durationMs} ingredients={ingredients} onIngredients={setIngredients} onChange={onChange} onNew={() => { onNew(); setIngredients([]); }} disabled={disabled} />
    <nav className="effect-library-actions" aria-label="灯光工作台功能"><label className="lighting-output-choice">灯光输出<select aria-label="灯光输出方式" disabled={disabled} value={document.outputMode} onChange={event => onChange({ ...document, outputMode: event.currentTarget.value === 'direct' ? 'direct' : 'timecode' }, '修改灯光输出方式')}><option value="timecode">MTC · 控台时间线播放</option><option value="direct">MIDI · 直接触发 Cue</option></select></label><button aria-current={!pointDetails && !externalPanel && !managing && !editing && !importing && !combining ? "page" : undefined} aria-label="素材库" title="素材库" onClick={() => { resetPanels(); onLibrary(); }}><Layers /><span>素材库</span></button><div onClickCapture={resetPanels}>{headerActions}</div><button aria-current={managing ? "page" : undefined} title="素材管理" aria-label="素材管理" onClick={() => openPanel('manage')}><Settings2 /><span>素材管理</span></button>{selected.length > 0 ? <><button title={`组合 ${selected.length}`} aria-label={`组合 ${selected.length}`} disabled={disabled || selected.length < 2} onClick={() => openPanel('combine')}><Layers /><span>组合 {selected.length}</span></button><button aria-label="移除" title="只从本软件效果库移除" disabled={disabled} onClick={() => { onChange({ ...document, templates: document.templates.filter(effect => !selected.includes(effect.id)) }, '移除灯光效果'); setSelected([]); }}><Trash2 /><span>移除素材</span></button></> : null}<button aria-current={importing ? "page" : undefined} title="读取控台" aria-label="读取控台" disabled={disabled} onClick={() => openPanel('import')}><Download /><span>读取控台</span></button><button aria-current={editing ? "page" : undefined} title="添加效果" aria-label="添加效果" disabled={disabled} onClick={() => openPanel('edit')}><Plus /><span>添加素材</span></button></nav>
    {externalPanel ? <div className="effect-inline-panel">{externalPanel}</div> : null}
    {managing ? <LightingMaterialManager document={document} categories={categories} onChange={onChange} onClose={() => setManaging(false)} onSave={names => { localStorage.setItem('lighting-material-menus', names.join('\n')); setMenus(names); setCategory('全部'); setManaging(false); }} /> : null}
    {importing ? <Ma2EffectImport document={document} disabled={disabled} onChange={onChange} onClose={() => setImporting(false)} /> : null}
    {combining ? <LightingEffectCombination document={document} ids={selected} onChange={onChange} onClose={() => { setCombining(false); setSelected([]); }} /> : null}
    {editing ? <div className="effect-binding-backdrop"><form className="effect-binding-form" onSubmit={event => { event.preventDefault(); save(event.currentTarget); }}><label>效果名称<input name="name" required defaultValue={current?.name ?? ''} /></label><fieldset className="effect-category-options"><legend>灯具分类</legend>{categories.map(value => <label key={value}><input type="checkbox" name="category" value={value} defaultChecked={current?.categories?.includes(value)} />{value}</label>)}</fieldset><label>序列<input name="sequence" type="number" min="1" max="99999" required defaultValue={binding?.mode === 'fixed' ? binding.sequence : ''} /></label><label>Cue<input name="cue" required defaultValue={binding?.mode === 'fixed' ? binding.cue : ''} /></label><label>执行器<input name="executor" required placeholder="例如 1.101" defaultValue={binding?.mode === 'fixed' ? binding.executor : ''} /></label>{error ? <p role="alert">{error}</p> : null}<footer><button type="button" onClick={() => setEditing(null)}>取消</button><button disabled={disabled}>保存效果</button></footer></form></div> : null}

  </section>;
}
