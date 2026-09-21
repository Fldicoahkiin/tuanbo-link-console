import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { defaultShortcuts, shortcutActions, shortcutKey, shortcutLabel, useShortcutStore, type ShortcutBinding } from '../stores/shortcut-store';

export function ShortcutSettings(): JSX.Element {
  const { bindings, load, save, error } = useShortcutStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { load(); }, [load]);
  const update = (next: ShortcutBinding[]): void => {
    try { save(next); setEditing(null); setMessage(null); }
    catch (reason) { setMessage(String(reason)); }
  };
  return <div className="shortcut-settings"><p>灯光时间线快捷键，修改后立即生效并保存在本机。点击按键框后按下新组合；输入文字或打开对话框时不触发。</p>
    {error || message ? <p role="alert">{message ?? error}</p> : null}
    {Object.entries(shortcutActions).map(([action, name]) => <div className="shortcut-setting-row" key={action}><strong>{name}</strong><div>
      {bindings.filter(binding => binding.action === action).map(binding => <span className="shortcut-binding" key={binding.id}><input aria-label={`${name}快捷键`} readOnly value={editing === binding.id ? '请按快捷键…' : shortcutLabel(binding.key)} onFocus={() => setEditing(binding.id)} onBlur={() => setEditing(null)} onKeyDown={event => {
        event.preventDefault(); event.stopPropagation();
        if (event.code === 'Escape') { setEditing(null); event.currentTarget.blur(); return; }
        if (event.repeat || /^(Control|Shift|Alt|Meta)/.test(event.code)) return;
        const key = shortcutKey(event);
        if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit\d|F[1-9]|F1[0-2]|Space|Home|End|ArrowLeft|ArrowRight)$/.test(key) || event.ctrlKey || event.metaKey || event.altKey) { setMessage('请使用字母、数字、F1–F12、空格、方向键、Home、End，可搭配 Shift；Ctrl / Alt / Windows 组合保留给系统及现有编辑操作。'); return; }
        update(bindings.map(entry => entry.id === binding.id ? { ...entry, key } : entry));
      }} /><button aria-label={`删除${name}快捷键 ${shortcutLabel(binding.key)}`} onClick={() => update(bindings.filter(entry => entry.id !== binding.id))}><Trash2 /></button></span>)}
      <button onClick={() => { const key = ['F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].find(candidate => !bindings.some(binding => binding.key === candidate)); if (!key) { setMessage('请先修改或删除一个备用快捷键'); return; } const actionId = defaultShortcuts.find(binding => binding.action === action)!.action; update([...bindings, { id: crypto.randomUUID(), action: actionId, key }]); }}><Plus />添加快捷键</button>
    </div></div>)}
    <button onClick={() => update(defaultShortcuts)}>恢复默认快捷键</button>
  </div>;
}
