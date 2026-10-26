import { SettingsConfirm } from './SettingsControls';
import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { defaultShortcuts, shortcutActions, shortcutKey, shortcutLabel, useShortcutStore, type ShortcutBinding } from '../stores/shortcut-store';

export function ShortcutSettings(): JSX.Element {
  const { bindings, load, save, error } = useShortcutStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ShortcutBinding | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { load(); }, [load]);
  const update = (next: ShortcutBinding[]): boolean => {
    try { save(next); setEditing(null); setMessage(null); return true; }
    catch (reason) { setMessage(String(reason)); return false; }
  };
  return <div className="shortcut-settings"><p>灯光时间线的快捷键，修改后立即生效并保存在这台电脑上。点一下按键框，再按下新的组合键；输入文字或打开对话框时快捷键不起作用。</p>
    {error || message ? <p role="alert">{message ?? error}</p> : null}
    {Object.entries(shortcutActions).map(([action, name]) => <div className="shortcut-setting-row" key={action}><strong>{name}</strong><div>
      {bindings.filter(binding => binding.action === action).map(binding => <span className="shortcut-binding" key={binding.id}><input aria-label={`${name}快捷键`} readOnly value={editing === binding.id ? '请按快捷键…' : shortcutLabel(binding.key)} onFocus={() => setEditing(binding.id)} onBlur={() => setEditing(null)} onKeyDown={event => {
        if (event.code === 'Tab') { setEditing(null); return; }
        event.preventDefault(); event.stopPropagation();
        if (event.code === 'Escape') { setEditing(null); event.currentTarget.blur(); return; }
        if (event.repeat || /^(Control|Shift|Alt|Meta)/.test(event.code)) return;
        const key = shortcutKey(event);
        if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit\d|F[1-9]|F1[0-2]|Space|Home|End|ArrowLeft|ArrowRight)$/.test(key) || event.ctrlKey || event.metaKey || event.altKey) { setMessage('请使用字母、数字、F1–F12、空格、方向键、Home 或 End，可以加 Shift；Ctrl、Alt、Windows 键的组合留给系统和现有的编辑操作。'); return; }
        update(bindings.map(entry => entry.id === binding.id ? { ...entry, key } : entry));
      }} /><button aria-label={`删除${name}快捷键 ${shortcutLabel(binding.key)}`} onClick={() => { if (update(bindings.filter(entry => entry.id !== binding.id))) setRemoved(binding); }}><Trash2 /></button></span>)}
      <button onClick={() => { const key = ['F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].find(candidate => !bindings.some(binding => binding.key === candidate)); if (!key) { setMessage('请先修改或删除一个备用快捷键'); return; } const actionId = defaultShortcuts.find(binding => binding.action === action)!.action; update([...bindings, { id: crypto.randomUUID(), action: actionId, key }]); }}><Plus />添加快捷键</button>
    </div></div>)}
    {removed ? <div className="settings-feedback" role="status">已删除 {shortcutLabel(removed.key)}<button onClick={() => { if (update([...bindings, removed])) setRemoved(null); }}>撤销删除</button></div> : null}
    <button onClick={() => setConfirmReset(true)}>恢复默认快捷键</button>
    {confirmReset ? <SettingsConfirm title="恢复默认快捷键？" confirmLabel="恢复默认" onClose={() => setConfirmReset(false)} onConfirm={() => { if (update(defaultShortcuts)) { setConfirmReset(false); setRemoved(null); } }}>你设置的快捷键都会恢复成默认值。</SettingsConfirm> : null}
  </div>;
}
