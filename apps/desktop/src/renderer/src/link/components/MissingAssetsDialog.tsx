import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileSearch, FolderSearch } from 'lucide-react';
import { projectAssetFiles, type ProjectAssetFile } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { Button } from './Button';
import { ModalSurface } from './ModalSurface';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Outcome = 'not-found' | 'mismatch';
const OUTCOME_LABELS: Record<Outcome, string> = { 'not-found': '未找到', mismatch: '内容不一致' };
const RELINK_BATCH = 4;

/** Lists project files missing from the project folder when a project opens (or
 * when asked) and copies them back from the folder the .tblink came from. */
export function MissingAssetsDialog({ request, locked, notify }: {
  request: number;
  locked: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element | null {
  const documentId = useDocumentStore((state) => state.documentId);
  const path = useDocumentStore((state) => state.path);
  const [missing, setMissing] = useState<ProjectAssetFile[] | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome> | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState('');
  const handledRequest = useRef(request);
  const reloadedAfterRelink = useRef(false);

  useEffect(() => {
    const document = useDocumentStore.getState();
    const reason = request !== handledRequest.current ? 'request' : reloadedAfterRelink.current ? 'relink' : 'open';
    handledRequest.current = request; reloadedAfterRelink.current = false;
    if (!document.project || !document.path) { setMissing(null); return; }
    let cancelled = false;
    void findMissingFiles(document.path, document.project).then((files) => {
      if (cancelled) return;
      if (reason !== 'relink') { setOutcomes(null); setError(''); }
      if (files.length) setMissing(files);
      else {
        setMissing(null);
        if (reason === 'request') notify('工程用到的素材都在工程文件夹内');
      }
    }).catch((failure: unknown) => {
      if (!cancelled) notify(`素材检查失败：${toMessage(failure)}`, 'error');
    });
    return () => { cancelled = true; };
  }, [documentId, path, request, notify]);

  if (!missing || !path) return null;
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));

  const relink = async (): Promise<void> => {
    const document = useDocumentStore.getState();
    if (!document.path || document.documentId !== documentId) return;
    const projectPath = document.path;
    setError('');
    try {
      const sourceDirectory = await linkDesktopViewModel.pickAssetSourceDirectory(projectPath);
      if (!sourceDirectory) return;
      const next: Record<string, Outcome> = {};
      let restored = 0;
      for (let offset = 0; offset < missing.length; offset += RELINK_BATCH) {
        setProgress(`正在核对并复制 ${offset + 1}–${Math.min(offset + RELINK_BATCH, missing.length)} / ${missing.length}`);
        const files = missing.slice(offset, offset + RELINK_BATCH).map(({ relativePath, sha256 }) => ({ relativePath, sha256 }));
        for (const result of await linkDesktopViewModel.relinkAssetFiles({ projectPath, sourceDirectory, files })) {
          if (result.status === 'restored') restored += 1;
          else if (result.status !== 'present') next[result.relativePath] = result.status;
        }
      }
      setOutcomes(next);
      const remaining = Object.keys(next).length;
      if (!restored) return;
      notify(remaining ? `已找回 ${restored} 个素材，仍有 ${remaining} 个缺失` : `已找回 ${restored} 个素材`);
      // The project document is unchanged; setting it again lets every view see the
      // restored files. Unsaved edits stay unsaved: nothing is written to the project file.
      const current = useDocumentStore.getState();
      if (current.documentId !== documentId || current.path !== projectPath || !current.project) return;
      reloadedAfterRelink.current = true;
      current.setProject(current.project, projectPath, { restored: current.dirty, upgraded: current.upgradeBackupPending });
    } catch (failure) {
      setError(toMessage(failure));
    } finally {
      setProgress(null);
    }
  };

  const remainingCount = outcomes ? missing.filter((file) => outcomes[file.relativePath]).length : 0;
  // The project page may be hidden behind another page; the modal must still show.
  return createPortal(<ModalSurface className="modal-card project-dialog missing-assets-dialog" label="找回缺失素材" onClose={() => { if (!progress) setMissing(null); }}>
    <form onSubmit={(event) => { event.preventDefault(); void relink(); }}>
      <FileSearch className="dialog-symbol" aria-hidden="true" />
      <h2>找不到 {missing.length} 个素材</h2>
      <p>工程文件夹里缺少下面这些文件。通常是只移动或复制了 .tblink 文件，没有带上它原来所在文件夹里的 assets 文件夹。</p>
      <p>选择 .tblink 原来所在的文件夹，软件会在其中相同的位置查找，内容核对一致后复制到当前工程文件夹：{folder}</p>
      <ul className="missing-assets-list" aria-label="缺失的素材">
        {missing.map((file) => <li key={file.relativePath}>
          <span title={file.relativePath}>{file.label}</span>
          {outcomes?.[file.relativePath] ? <small>{OUTCOME_LABELS[outcomes[file.relativePath]!]}</small> : null}
        </li>)}
      </ul>
      {outcomes && remainingCount ? <p role="status">{remainingCount === missing.length
        ? '所选文件夹里没有可用的文件。请确认选择的是 .tblink 原来所在的文件夹，里面应有 assets 文件夹。'
        : `仍有 ${remainingCount} 个没有找回，可以再选择其他文件夹。`}</p> : null}
      {locked ? <p role="status">停止播放后才能找回素材。</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <div className="modal-actions">
        <Button type="button" className="secondary-button" disabled={Boolean(progress)} onClick={() => setMissing(null)}>稍后处理</Button>
        <Button type="submit" className="primary-button" disabled={locked} loading={Boolean(progress)}><FolderSearch />{progress ?? '选择原工程文件夹'}</Button>
      </div>
    </form>
  </ModalSurface>, document.body);
}

async function findMissingFiles(projectPath: string, project: LinkProject): Promise<ProjectAssetFile[]> {
  const files = projectAssetFiles(project);
  const missing = new Set<string>();
  for (let offset = 0; offset < files.length; offset += 512) {
    const batch = files.slice(offset, offset + 512).map(({ relativePath, sha256 }) => ({ relativePath, sha256 }));
    for (const relativePath of await linkDesktopViewModel.findMissingAssetFiles({ projectPath, files: batch })) missing.add(relativePath);
  }
  return files.filter((file) => missing.has(file.relativePath));
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
