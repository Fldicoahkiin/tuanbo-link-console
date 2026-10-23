import { Button } from './Button';
import { useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { importProgramFiles } from './import-program-files';
import { useDocumentStore } from '../stores/document-store';
import { requireProjectLocation } from '../project-document';

export function ImportPlayerMusic({ disabled, notify, onBusy, playlistId }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; playlistId: string }): JSX.Element {
  const input = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false);
  const choose = async (): Promise<void> => {
    if (!useDocumentStore.getState().project) return;
    try {
      // Programs are copied next to the project file.
      if (!await requireProjectLocation('添加节目')) return;
      input.current?.click();
    } catch (error) { notify(String(error), 'error'); }
  };
  const importFiles = async (files: File[]): Promise<void> => {
    if (disabled || busy) return;
    setBusy(true); onBusy(true);
    try { await importProgramFiles(files, playlistId, notify); }
    finally { setBusy(false); onBusy(false); if (input.current) input.current.value = ''; }
  };
  return <><Button className="primary-button import-player-music" disabled={disabled || busy} onClick={() => void choose()}><ListPlus />{busy ? '正在添加节目…' : '添加节目'}</Button>
    <input ref={input} type="file" aria-label="导入主控音乐" hidden multiple accept="audio/*,video/mp4,.wav,.mp3,.flac,.m4a,.aac,.ogg,.mp4" onChange={(event) => void importFiles([...event.currentTarget.files ?? []])} /></>;
}

