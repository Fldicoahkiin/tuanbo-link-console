import { useState } from 'react';
import type { RundownItem } from '@tb/schema';
import { updateRundownItemCommand } from '@tb/core/link';
import { Pencil } from 'lucide-react';
import { useDocumentStore } from '../stores/document-store';
import { DocumentActions, type DocumentActionProps } from './DocumentActions';
import { Button, TextInput } from '../ui';

export function CueRundownHeader({ item, documentActions, notify }: {
  item: RundownItem | null;
  documentActions: DocumentActionProps;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  return <div className="titlebar-document" data-page="editor">
    {item ? <ProgramName key={`${item.id}:${item.title}`} item={item} notify={notify} /> : <span className="titlebar-program-empty">未选择节目</span>}
    <DocumentActions {...documentActions} />
  </div>;
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
  return <div className="titlebar-program"><span>正在编辑</span>{editing
    ? <TextInput autoFocus aria-label="当前节目名称" value={name} onChange={(event) => setName(event.currentTarget.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.preventDefault(); setName(item.title); setEditing(false); } }} />
    : <Button variant="ghost" className="titlebar-program-name" onClick={() => setEditing(true)} title={item.title} aria-label={`修改节目名称：${item.title}`}><strong>{item.title}</strong><Pencil aria-hidden="true" /></Button>}</div>;
}
