import { Button } from './Button';
import { useEffect, useState } from 'react';
import { AudioLines, ChevronDown, Download, FileAudio2, FolderOpen, Upload } from 'lucide-react';
import { allocateP1TimecodeRanges, configureP1AutoFollowCommand, applyP1ProjectExportCommand, synchronizeP1ProjectCommand, setPlaybackSourceCommand } from '@tb/core/link';
import { assertDocumentSession, useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

type Props = {
  afterImport?: (() => Promise<void>) | undefined;
  purpose?: 'follow' | 'migration' | 'audio';
  disabled?: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

type SyncSummary = {
  path: string;
  itemCount: number;
  playlistCount: number;
  updatedAt: string;
};

export function P1ProjectSyncPanel({ disabled = false, notify, purpose = 'follow', afterImport }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const documentId = useDocumentStore((state) => state.documentId);
  const [p1ProjectPath, setP1ProjectPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  useEffect(() => {
    setP1ProjectPath('');
    setSummary(null);
  }, [documentId]);

  const importProject = async (source: 'current' | 'picker', lighting = Boolean(afterImport)): Promise<void> => {
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
      const command = synchronizeP1ProjectCommand(imported);
      useDocumentStore.getState().executeForDocument(targetDocumentId, purpose !== 'follow' ? { ...command, label: '导入 P1 音频并使用内部主控播放', execute: value => setPlaybackSourceCommand('internal').execute(command.execute(value)) } : command);
      await persistCurrentDocument(projectPath, targetDocumentId);
      setP1ProjectPath(imported.sourcePath);
      setSummary({
        path: imported.sourcePath,
        itemCount: imported.items.length,
        playlistCount: imported.playlists.length,
        updatedAt: new Date().toLocaleString('zh-CN')
      });
      notify(`已导入 ${imported.items.length} 首音频，另保留 ${imported.skippedItems?.length ?? 0} 首待修复节目；原始时间码已保留。${purpose === 'audio' ? '使用本软件内部主控播放，无需启动 P1。' : ''}`);
      if (lighting && afterImport) { await afterImport(); await persistCurrentDocument(projectPath, targetDocumentId); }
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
      const sourcePath = p1ProjectPath || await linkDesktopViewModel.pickP1Project();
      if (!sourcePath) return;
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
          <Button className="secondary-button" disabled={disabled || busy} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void importProject('current'); }}><Download />读取 P1 当前工程</Button>
          <Button className="secondary-button" disabled={disabled || busy} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void importProject('picker'); }}><FolderOpen />选择 .hia 文件</Button>
          {afterImport ? <Button className="secondary-button" disabled={disabled || busy} onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); void importProject('picker', true); }}><FolderOpen />选择 .hia 并读取音频与灯光</Button> : null}
        </div>
      </details>
      {afterImport ? <Button className="primary-button" disabled={disabled || busy} onClick={() => void importProject('current', true)}><Download />一键读取当前音频与灯光</Button> : null}
      {purpose !== 'migration' ? <><Button className="primary-button" aria-label="同步回 P1 工程" disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject()}><Upload />写回 P1</Button>
      {purpose === 'follow' ? <Button className="primary-button" disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject(true)}><AudioLines />生成点击播放联动工程</Button> : null}</> : null}
    </div>
    <p>{purpose === 'audio' ? '读取 P1 音频，保留裁剪和原始歌曲时间码。MP4 音轨尾部短缺不超过 250 毫秒时补静音，保持节目长度和灯光时间码不变。P1 不含控台 Cue 列表；要显示 Cue，请在设备连接中扫描控台后导入。写回生成独立 .hia；重新打开联动工程后，选择上次读取或导出的对应 P1 文件即可导出，无需启动 P1 或连接控台网络。' : purpose === 'migration' ? '读取原始音频及原有歌曲起始时间码，用于核对控台灯光配对。' : project?.p1AutoFollow?.enabled ? '已启用自动监听：在 P1 打开生成的 .hia，直接点歌曲即可选节目并跟随时间线。停止联动后可在集成中心恢复监听。' : '生成一次联动工程后，点击 P1 歌曲即可自动控制 OBS，无需逐首布防。'}</p>
    {project?.rundown.some(item => item.notes.startsWith('P1 裁剪')) ? <details className="p1-sync-issues"><summary>已恢复的歌曲：请核对裁剪范围</summary>{project.rundown.filter(item => item.notes.startsWith('P1 裁剪')).map(item => <p key={item.id}><strong>{item.title}</strong><br />{item.notes}</p>)}</details> : null}
    {summary ? <div className="p1-sync-summary"><strong>{summary.itemCount}</strong> 首音频 · <strong>{summary.playlistCount}</strong> 个列表 · {summary.updatedAt}<span>{summary.path}</span></div> : null}
    {project?.p1Sync?.skippedItems?.length ? <details open className="p1-sync-issues"><summary>已保留 {project.p1Sync.skippedItems.length} 首待修复节目，其余歌曲可以播放</summary><p>以下歌曲已保留在节目单并停用；补齐原文件后重新导入即可恢复，写回 P1 时仍保留原条目。</p>{project.p1Sync.skippedItems.map(entry => <p key={entry.sourceKey}><strong>{entry.playlistName} / {entry.title}</strong><br />{entry.reason}</p>)}</details> : null}
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
