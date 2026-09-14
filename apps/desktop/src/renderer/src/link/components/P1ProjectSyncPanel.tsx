import { useEffect, useState } from 'react';
import { AudioLines, ChevronDown, Download, FileAudio2, FolderOpen, Upload } from 'lucide-react';
import { allocateP1TimecodeRanges, configureP1AutoFollowCommand, applyP1ProjectExportCommand, synchronizeP1ProjectCommand } from '@tb/core/link';
import { assertDocumentSession, useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Props = {
  disabled?: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

type SyncSummary = {
  path: string;
  itemCount: number;
  playlistCount: number;
  updatedAt: string;
};

export function P1ProjectSyncPanel({ disabled = false, notify }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const documentId = useDocumentStore((state) => state.documentId);
  const [p1ProjectPath, setP1ProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  useEffect(() => {
    setP1ProjectPath('');
    setSummary(null);
  }, [documentId]);

  const importProject = async (source: 'current' | 'picker'): Promise<void> => {
    setBusy(true);
    try {
      const sourcePath = source === 'current'
        ? await linkDesktopViewModel.detectCurrentP1Project()
        : await linkDesktopViewModel.pickP1Project();
      if (!sourcePath) return;
      await ensureLinkDocument(sourcePath);
      const document = useDocumentStore.getState();
      if (!document.project) throw new Error('联动工程创建失败');
      if (document.project.rundown.length > 0 && !document.project.p1Sync && !window.confirm(
        '当前工程已有节目。读取 P1 后会把 P1 音频排在节目单前部，并保留现有 Cue 与手工节目，是否继续？'
      )) return;
      const targetDocumentId = document.documentId;
      const projectPath = document.path ?? await saveUnsavedDocument(targetDocumentId);
      if (!projectPath) return;
      const imported = await linkDesktopViewModel.importP1Project({ p1ProjectPath: sourcePath, linkProjectPath: projectPath });
      useDocumentStore.getState().executeForDocument(targetDocumentId, synchronizeP1ProjectCommand(imported));
      await persistCurrentDocument(projectPath, targetDocumentId);
      setP1ProjectPath(imported.sourcePath);
      setSummary({
        path: imported.sourcePath,
        itemCount: imported.items.length,
        playlistCount: imported.playlists.length,
        updatedAt: new Date().toLocaleString('zh-CN')
      });
      notify(`已读取 P1：${imported.playlists.length} 个播放列表、${imported.items.length} 首音频；原有 Cue 已保留。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const exportProject = async (autoFollow = false): Promise<void> => {
    const document = useDocumentStore.getState();
    if (!document.project || !document.path) {
      notify('请先保存 .tblink 工程。', 'error');
      return;
    }
    const targetDocumentId = document.documentId;
    setBusy(true);
    try {
      const sourcePath = p1ProjectPath || await linkDesktopViewModel.detectCurrentP1Project();
      if (!sourcePath) throw new Error('未找到 P1 当前工程，请先在 P1 打开对应歌单');
      const config = autoFollow ? allocateP1TimecodeRanges(document.project) : document.project.p1AutoFollow;
      const exportDocument = config ? configureP1AutoFollowCommand(config).execute(document.project) : document.project;
      const preview = await linkDesktopViewModel.previewP1ProjectExport({
        p1ProjectPath: sourcePath,
        linkProjectPath: document.path,
        project: exportDocument
      });
      const confirmed = window.confirm([
        '确认生成 P1 同步工程？',
        `播放列表：${preview.playlistCount}`,
        `更新音频：${preview.updatedCount}`,
        `新增音频：${preview.addedCount}`,
        `移除音频：${preview.removedCount}`,
        `不含参考音频、不写入 P1：${preview.ignoredCount}`,
        `输出：${preview.targetPath}`,
        '',
        '联动台的 OBS、视频和灯光 Cue 保留在 .tblink 中，由 P1 MTC 驱动，不会写入 P1。'
      ].join('\n'));
      if (!confirmed) return;
      assertDocumentSession(targetDocumentId);
      const exported = await linkDesktopViewModel.exportP1Project({
        p1ProjectPath: sourcePath,
        linkProjectPath: document.path,
        project: exportDocument,
        expectedSourceSha256: preview.sourceSha256
      });
      useDocumentStore.getState().executeForDocument(targetDocumentId, applyP1ProjectExportCommand(exported));
      if (config) useDocumentStore.getState().executeForDocument(targetDocumentId, configureP1AutoFollowCommand(config));
      await persistCurrentDocument(document.path, targetDocumentId);
      setP1ProjectPath(exported.outputPath);
      setSummary({
        path: exported.outputPath,
        itemCount: exported.itemBindings.length,
        playlistCount: exported.playlists.length,
        updatedAt: new Date().toLocaleString('zh-CN')
      });
      notify(`P1 同步工程已原子生成：${exported.outputPath}。请在 P1 打开该 .hia 文件。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return <section className="p1-sync-panel">
    <div className="p1-sync-heading">
      <div><AudioLines /><span><strong>P1 音频工程同步</strong></span></div>
      <span className={`status-pill ${project?.p1Sync ? 'ok' : 'pending'}`}>{project?.p1Sync ? '已建立映射' : '未读取'}</span>
    </div>
    <div className="p1-sync-path" title={p1ProjectPath || '尚未选择 P1 工程'}>
      <FileAudio2 /><span>{p1ProjectPath || '未选择 .hia 工程'}</span>
    </div>
    <div className="p1-sync-actions">
      <details className={`p1-import-menu ${disabled || busy ? 'disabled' : ''}`}>
        <summary aria-label="导入 P1 工程" aria-disabled={disabled || busy} onClick={(event) => { if (disabled || busy) event.preventDefault(); }}><Download />导入 P1 工程<ChevronDown /></summary>
        <div className="p1-import-popover">
          <button className="secondary-button" disabled={disabled || busy} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void importProject('current'); }}><Download />读取 P1 当前工程</button>
          <button className="secondary-button" disabled={disabled || busy} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void importProject('picker'); }}><FolderOpen />选择 .hia 文件</button>
        </div>
      </details>
      <button className="primary-button" aria-label="同步回 P1 工程" disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject()}><Upload />写回 P1</button>
      <button className="primary-button" disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject(true)}><AudioLines />生成点击播放联动工程</button>
    </div>
    <p>{project?.p1AutoFollow?.enabled ? '已启用自动监听：在 P1 打开生成的 .hia，直接点歌曲即可选节目并跟随时间线。停止联动后可在集成中心恢复监听。' : '生成一次联动工程后，点击 P1 歌曲即可自动控制 OBS，无需逐首布防。'}</p>
    {summary ? <div className="p1-sync-summary"><strong>{summary.itemCount}</strong> 首音频 · <strong>{summary.playlistCount}</strong> 个列表 · {summary.updatedAt}<span>{summary.path}</span></div> : null}
  </section>;
}

async function ensureLinkDocument(sourcePath: string): Promise<void> {
  const initial = useDocumentStore.getState();
  if (initial.project) return;
  const sourceName = sourcePath.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.hia$/i, '').trim();
  const project = await linkDesktopViewModel.createProject(sourceName ? `${sourceName} 联动工程` : 'P1 联动工程');
  if (useDocumentStore.getState().documentId !== initial.documentId || useDocumentStore.getState().project) {
    throw new Error('当前工程已切换，已取消自动创建 P1 联动工程');
  }
  useDocumentStore.getState().setProject(project, null);
}

async function saveUnsavedDocument(documentId: number): Promise<string | null> {
  const document = assertDocumentSession(documentId);
  if (!document.project) throw new Error('联动工程状态丢失');
  const savedPath = await linkDesktopViewModel.saveProject(null, document.project);
  if (!savedPath) return null;
  assertDocumentSession(documentId).markSaved(savedPath, document.revision, documentId);
  return savedPath;
}

async function persistCurrentDocument(path: string, documentId: number): Promise<void> {
  const document = assertDocumentSession(documentId);
  if (!document.project) throw new Error('P1 同步后联动工程状态丢失');
  const savedPath = await linkDesktopViewModel.saveProject(path, document.project);
  if (!savedPath) throw new Error('P1 同步完成，但联动工程保存被取消');
  assertDocumentSession(documentId).markSaved(savedPath, document.revision, documentId);
}
