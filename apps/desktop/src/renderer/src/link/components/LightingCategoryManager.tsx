import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import { editLightingCategoryCommand, updateLightingCategoryNavigationCommand, type LightingCategoryMenuItem, type LinkCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';

export function LightingCategoryManager({ items, onClose, onHidden }: { items: LightingCategoryMenuItem[]; onClose: () => void; onHidden: (item: LightingCategoryMenuItem) => void }): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const execute = (command: LinkCommand): boolean => {
    try { useDocumentStore.getState().execute(command); setError(''); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  };
  return createPortal(<dialog ref={dialog} className="lighting-attribute-dialog lighting-category-manager" aria-label="分类管理" onCancel={onClose}>
    <header><strong>分类管理</strong><button aria-label="关闭分类管理" onClick={onClose}><X/></button></header>
    <p>勾选要显示的分类。常用分类放在左侧，其余收进“更多分类”。用箭头调整顺序，设置随工程保存。</p>
    <div className="lighting-category-manager-list">{items.map((item, index) => <div className="lighting-category-manager-row" key={item.id} data-id={item.id}>
      {item.kind === 'category' ? <input key={item.name} aria-label={`分类名称 ${item.name}`} defaultValue={item.name} maxLength={64} onBlur={event => {
        const name = event.currentTarget.value.trim(); if (name !== item.name) execute(editLightingCategoryCommand(item.categoryId, name));
      }}/> : <strong>{item.name}</strong>}
      <label><input type="checkbox" aria-label={`显示 ${item.name}`} checked={item.display !== 'hidden'} onChange={event => {
        const display = event.target.checked ? 'common' : 'hidden';
        if (execute(updateLightingCategoryNavigationCommand(item.id, { display })) && display === 'hidden') onHidden(item);
      }}/>显示</label>
      <label><input type="checkbox" aria-label={`常用 ${item.name}`} disabled={item.display === 'hidden'} checked={item.display === 'common'} onChange={event => execute(updateLightingCategoryNavigationCommand(item.id, { display: event.target.checked ? 'common' : 'more' }))}/>常用</label>
      <button aria-label={`上移 ${item.name}`} disabled={index === 0} onClick={() => execute(updateLightingCategoryNavigationCommand(item.id, { move: -1 }))}><ArrowUp/></button>
      <button aria-label={`下移 ${item.name}`} disabled={index === items.length - 1} onClick={() => execute(updateLightingCategoryNavigationCommand(item.id, { move: 1 }))}><ArrowDown/></button>
      {item.kind === 'category' ? <button aria-label={`删除分类 ${item.name}`} title="删除分类，保留 Cue" onClick={() => { if (execute(editLightingCategoryCommand(item.categoryId, null))) onHidden(item); }}><Trash2/></button> : <span/>}
    </div>)}</div>
    <form className="lighting-category-create" onSubmit={event => { event.preventDefault(); if (execute(editLightingCategoryCommand(crypto.randomUUID(), newName))) setNewName(''); }}>
      <input aria-label="新分类名称" placeholder="新分类名称" required maxLength={64} value={newName} onChange={event => setNewName(event.target.value)}/><button type="submit">新建分类</button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    <footer>隐藏分类不会丢失归类记录；删除分类也不会删除控台上的 Cue。</footer>
  </dialog>, document.body);
}
