import { useState } from 'react';
import type { RundownItem } from '@tb/schema';
import { updateRundownItemCommand } from '@tb/core/link';
import { Pencil } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { DocumentActions, type DocumentActionProps } from './DocumentActions';

export function CueRundownHeader({ item, documentActions, notify }: {
  item: RundownItem | null;
  documentActions: DocumentActionProps;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  return <header className="p1-project-ribbon editor-toolbar">
    {item ? <ProgramName key={`${item.id}:${item.title}`} item={item} notify={notify} /> : <span className="editor-program-empty">未选择节目</span>}
    <div className="toolbar-drag-space" />
    <div className="editor-toolbar-actions"><DocumentActions {...documentActions} /></div>
  </header>;
}

function ProgramName({ item, notify }: { item: RundownItem; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.title);
  const commit = (): void => {
    const title = name.trim();
    if (!title) { notify('节目名称不能为空。', 'error'); return; }
    if (title !== item.title) {
      const document = useDocumentStore.getState();
      const current = document.project?.rundown.find((candidate) => candidate.id === item.id);
      if (!current) return;
      try { document.execute(updateRundownItemCommand(item.id, { title, enabled: current.enabled, notes: current.notes })); }
      catch (error) { notify(String(error), 'error'); return; }
    }
    setEditing(false);
  };
  return <div className="editor-program-name"><span>正在编辑</span>{editing
    ? <input autoFocus aria-label="当前节目名称" value={name} onChange={(event) => setName(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); setName(item.title); setEditing(false); } }} />
    : <button onClick={() => setEditing(true)} title={item.title} aria-label={`修改节目名称：${item.title}`}><strong>{item.title}</strong><Pencil /></button>}</div>;
}
