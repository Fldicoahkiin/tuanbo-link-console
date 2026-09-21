import { useEffect, useState } from 'react';
import { removeRundownItemCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';

export function useProgramSelection({ visibleIds, scope, locked, notify }: {
  visibleIds: string[]; scope: string; locked: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selected = selectedIds.filter(id => visibleIds.includes(id));
  useEffect(() => { setSelectedIds([]); }, [scope]);
  const deleteSelection = (): void => {
    if (locked || !selected.length || !window.confirm(`确认删除选中的 ${selected.length} 个节目？源媒体文件会保留。`)) return;
    try {
      const commands = selected.map(id => removeRundownItemCommand(id));
      useDocumentStore.getState().execute({ ...commands[0]!, label: `删除 ${commands.length} 个节目`, execute: value => commands.reduce((current, command) => command.execute(current), value) });
      setSelectedIds([]);
    } catch (error) { notify(String(error), 'error'); }
  };
  return { selected, setSelectedIds, deleteSelection };
}
