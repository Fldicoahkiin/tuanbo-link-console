import { useEffect, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button, Card, Dialog, IconButton, Notice, Switch, TextInput } from '../ui';
import { defaultShortcuts, shortcutActions, shortcutKey, shortcutLabel, useShortcutStore, type ShortcutBinding } from '../stores/shortcut-store';
import { ownKeys } from '../keys/key-owner';

export function ShortcutSettings(): JSX.Element {
  const { bindings, switchesOff, load, save, setSwitch, error } = useShortcutStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ShortcutBinding | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { load(); }, [load]);
  const update = (next: ShortcutBinding[]): boolean => {
    try { save(next); setEditing(null); setMessage(null); return true; }
    catch (reason) { setMessage(String(reason)); return false; }
  };
  const add = (action: string): void => {
    const key = ['F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].find(candidate => !bindings.some(binding => binding.key === candidate));
    if (!key) { setMessage('请先修改或删除一个备用快捷键'); return; }
    const actionId = defaultShortcuts.find(binding => binding.action === action)!.action;
    update([...bindings, { id: crypto.randomUUID(), action: actionId, key }]);
  };
  return <>
    <Card title="停止" description="保存在这台电脑上。">
      <Switch label="单按 Esc 停止" help="关掉后，单按 Esc 只关闭面板、取消选中和取消拖动，不停止播放。Shift+Esc 在任何地方都能停止，开着对话框、正在拖动或在输入框里也行。"
        checked={!switchesOff.has('plainEscapeStops')} onChange={event => {
          try { setSwitch('plainEscapeStops', event.currentTarget.checked); setMessage(null); }
          catch (reason) { setMessage(`「单按 Esc 停止」没有保存成功：${String(reason)}。请再试一次。`); }
        }} />
    </Card>
    <Card title="灯光时间线" description="改完立即生效，保存在这台电脑上。点一下按键框，再按新的组合键；正在输入文字或开着对话框时，快捷键不起作用。"
      actions={<Button variant="ghost" size="sm" icon={RotateCcw} onClick={() => setConfirmReset(true)}>恢复默认快捷键</Button>}>
      {error || message ? <Notice tone="error">{message ?? error}</Notice> : null}
      {removed ? <Notice tone="success" actions={<Button variant="secondary" size="sm" onClick={() => { if (update([...bindings, removed])) setRemoved(null); }}>撤销删除</Button>}>已删除 {shortcutLabel(removed.key)}</Notice> : null}
      <div className="settings-shortcuts">{Object.entries(shortcutActions).map(([action, name]) => <div className="settings-shortcut" key={action}>
        <span className="settings-shortcut-name">{name}</span>
        <div className="settings-shortcut-keys">
          {bindings.filter(binding => binding.action === action).map(binding => <span className="settings-shortcut-key" key={binding.id}>
            <TextInput aria-label={`${name}快捷键`} width="auto" {...ownKeys('*')} readOnly value={editing === binding.id ? '请按快捷键…' : shortcutLabel(binding.key)} onFocus={() => setEditing(binding.id)} onBlur={() => setEditing(null)} onKeyDown={event => {
              if (event.code === 'Tab') { setEditing(null); return; }
              event.preventDefault(); event.stopPropagation();
              if (event.code === 'Escape') { setEditing(null); event.currentTarget.blur(); return; }
              if (event.repeat || /^(Control|Shift|Alt|Meta)/.test(event.code)) return;
              const key = shortcutKey(event);
              if (!/^(?:(?:Ctrl|Alt|Shift|Meta)\+)*(?:Key[A-Z]|Digit\d|F[1-9]|F1[0-2]|Space|Home|End|ArrowLeft|ArrowRight)$/.test(key) || event.ctrlKey || event.metaKey || event.altKey) { setMessage('请用字母、数字、F1–F12、空格、方向键、Home 或 End，可以加 Shift；Ctrl、Alt、Windows 键的组合留给系统和现有的编辑操作。'); return; }
              update(bindings.map(entry => entry.id === binding.id ? { ...entry, key } : entry));
            }} />
            <IconButton label={`删除${name}快捷键 ${shortcutLabel(binding.key)}`} icon={Trash2} size="sm" onClick={() => { if (update(bindings.filter(entry => entry.id !== binding.id))) setRemoved(binding); }} />
          </span>)}
          <Button variant="ghost" size="sm" icon={Plus} onClick={() => add(action)}>添加快捷键</Button>
        </div>
      </div>)}</div>
    </Card>
    {confirmReset ? <Dialog title="恢复默认快捷键？" size="sm" onClose={() => setConfirmReset(false)} actions={<>
      <Button variant="secondary" onClick={() => setConfirmReset(false)}>取消</Button>
      <Button variant="primary" onClick={() => { if (update(defaultShortcuts)) { setConfirmReset(false); setRemoved(null); } }}>恢复默认</Button>
    </>}><p>你设置的快捷键都会恢复成默认值。</p></Dialog> : null}
  </>;
}
