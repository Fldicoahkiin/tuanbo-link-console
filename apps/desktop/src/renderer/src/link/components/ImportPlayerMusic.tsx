import { useRef, useState } from 'react';
import { ListPlus } from 'lucide-react';
import { addRundownItemCommand, programPlaylists } from '@tb/core/link';
import { rundownItemSchema } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel, linkFileViewModel } from '../view-models/link-desktop-view-model';

export function ImportPlayerMusic({ disabled, notify, onBusy, playlistId }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void; playlistId: string }): JSX.Element {
  const input = useRef<HTMLInputElement>(null); const [busy, setBusy] = useState(false);
  const choose = async (): Promise<void> => {
    const document = useDocumentStore.getState(); if (!document.project) return;
    try {
      if (!document.path) {
        const path = await linkDesktopViewModel.saveProject(null, document.project);
        if (!path) return;
        useDocumentStore.getState().markSaved(path, document.revision, document.documentId);
      }
      input.current?.click();
    } catch (error) { notify(String(error), 'error'); }
  };
  const importFiles = async (files: File[]): Promise<void> => {
    const document = useDocumentStore.getState(); if (!document.path || !document.project) return;
    setBusy(true); onBusy(true); let completed = 0;
    try {
      for (const file of files) {
        const durationMs = await audioDuration(file);
        const referenceAudio = await linkDesktopViewModel.importReferenceAudio({ projectPath: document.path, sourcePath: linkFileViewModel.getPathForFile(file), durationMs });
        const item = rundownItemSchema.parse({ id: crypto.randomUUID(), title: file.name, referenceAudio,
          ...(programPlaylists(document.project).some((list) => list.id === playlistId) ? { playlistId } : {}),
          visualLayers: [{ id: crypto.randomUUID(), name: '画面 1' }, { id: crypto.randomUUID(), name: '画面 2' }] });
        useDocumentStore.getState().executeForDocument(document.documentId, addRundownItemCommand(item)); completed += 1;
      }
      notify(`已添加 ${completed} 个节目，可以点击播放或进入 Cue 编辑器编排。`);
    } catch (error) { notify(`已导入 ${completed} 首；后续导入停止：${String(error)}`, 'error'); }
    finally { setBusy(false); onBusy(false); if (input.current) input.current.value = ''; }
  };
  return <><button className="primary-button import-player-music" disabled={disabled || busy} onClick={() => void choose()}><ListPlus />{busy ? '正在添加节目…' : '添加节目'}</button>
    <input ref={input} type="file" aria-label="导入主控音乐" hidden multiple accept="audio/*,video/mp4,.wav,.mp3,.flac,.m4a,.aac,.ogg,.mp4" onChange={(event) => void importFiles([...event.currentTarget.files ?? []])} /></>;
}

function audioDuration(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(); const url = URL.createObjectURL(file);
    const finish = (error?: Error): void => {
      clearTimeout(timer); const duration = Math.round(audio.duration * 1000);
      audio.onloadedmetadata = null; audio.onerror = null; audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url);
      if (error) reject(error); else if (!Number.isFinite(duration) || duration <= 0) reject(new Error('音频时长无效')); else resolve(duration);
    };
    const timer = setTimeout(() => finish(new Error('音频读取超过 10 秒')), 10_000);
    audio.onloadedmetadata = () => finish(); audio.onerror = () => finish(new Error(`无法解码 ${file.name}`)); audio.src = url;
  });
}
