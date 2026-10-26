import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Filter, X } from 'lucide-react';
import { emptyMa2AttributeFilter, ma2AttributeRoles, ma2FilterRoles, type Ma2AttributeFilter as AttributeFilter } from '@tb/core/link';
import '../lighting-attributes.css';

const statuses = [['all', '全部状态'], ['empty', '空 Cue'], ['tracking', '本步无属性 · 可能继承'], ['unread', '还没读取'], ['partial', '读取不完整'], ['failed', '读取失败']] as const;
function FilterDialog({ value, onChange, onClose }: { value: AttributeFilter; onChange: (value: AttributeFilter) => void; onClose: () => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} className="lighting-attribute-dialog ma2-attribute-filter" aria-label="属性筛选" onCancel={onClose}>
    <header><strong>按 Cue 属性筛选</strong><button onClick={onClose} aria-label="关闭属性筛选"><X/></button></header>
    <p>按这一步实际写入的属性筛选，可以多选。亮度类里哪些是面光，需要结合灯具或用途分类来判断。</p>
    <fieldset><legend>匹配方式</legend><div className="ma2-filter-modes">{([['contains-all','包含全部所选'],['contains-any','包含任一所选'],['only','仅含所选属性']] as const).map(([mode, label]) => <label key={mode}><input type="radio" name="attribute-match" checked={value.mode === mode} onChange={() => onChange({ ...value, mode })}/>{label}</label>)}</div></fieldset>
    <fieldset><legend>灯具属性</legend><div className="ma2-filter-options">{ma2FilterRoles.map(role => <label key={role}><input type="checkbox" checked={value.roles.includes(role)} onChange={event => onChange({ ...value, roles: event.target.checked ? [...value.roles, role] : value.roles.filter(item => item !== role) })}/>{ma2AttributeRoles[role]}</label>)}</div></fieldset>
    <label className="ma2-filter-status">读取 / 内容状态<select aria-label="Cue 内容状态" value={value.status} onChange={event => { const status = statuses.find(([key]) => key === event.target.value)?.[0]; if (status) onChange({ ...value, status, ...(status !== 'all' ? { roles: [] } : {}) }); }}>{statuses.map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></label>
    <p>空 Cue：已完整读取，没有属性、效果、命令或额外的播放设置，同一序列里也没有可能被继承的数据。未读取或读取失败的不算空 Cue。</p>
    <footer><button onClick={() => onChange(emptyMa2AttributeFilter)}>清除筛选</button><button onClick={onClose}>完成</button></footer>
  </dialog>, document.body);
}

export function Ma2AttributeFilter({ value, onChange, count }: { value: AttributeFilter; onChange: (value: AttributeFilter) => void; count: number }): JSX.Element {
  const [open, setOpen] = useState(false);
  const active = value.roles.length > 0 || value.status !== 'all';
  const title = [value.mode === 'only' ? '仅含' : value.mode === 'contains-all' ? '包含全部' : '包含任一', ...value.roles.map(role => ma2AttributeRoles[role]), statuses.find(([key]) => key === value.status)?.[1]].join(' · ');
  return <><button aria-pressed={active} title={active ? title : '按灯具属性或空 Cue 筛选'} onClick={() => setOpen(true)}><Filter/>{active ? `属性筛选 · ${count} 项` : '属性筛选'}</button>{active ? <button aria-label="清除属性筛选" onClick={() => onChange(emptyMa2AttributeFilter)}><X/></button> : null}{open ? <FilterDialog value={value} onChange={onChange} onClose={() => setOpen(false)}/> : null}</>;
}
