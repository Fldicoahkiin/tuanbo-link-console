import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { AudioLines, Download, FolderOpen, Upload } from 'lucide-react';
import { Button, Disclosure, Progress, StatusBadge } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { allocateP1TimecodeRanges, configureP1AutoFollowCommand, applyP1ProjectExportCommand, formatMtcOffset, p1ImportReport, setItemPlaybackCommand, synchronizeP1ProjectCommand, setPlaybackSourceCommand, withP1MtcStart, type P1SameNameSong } from '@tb/core/link';
import { SongMtcStart } from './SongMtcStart';
import { assertDocumentSession, useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { requireProjectLocation } from '../project-document';
import type { LinkP1ProjectImportProgress, LinkProject } from '@tb/schema';

type Props = {
  directImport?: boolean;
  onBusyChange?: (busy: boolean) => void;
  afterImport?: (() => Promise<void>) | undefined;
  purpose?: 'follow' | 'migration' | 'audio';
  /** false under another panel that already names the P1 project and shows its file. */
  heading?: boolean;
  disabled?: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

type SyncSummary = {
  path: string;
  itemCount: number;
  playlistCount: number;
  updatedAt: string;
};

function panelExplanation(purpose: NonNullable<Props['purpose']>, directImport: boolean, autoFollow: boolean): string {
  if (directImport) return '导入后由联动台播放，歌曲、裁剪和原始时间码都会保留。连好音频和 MIDI 就能沿用控台上的编排；连接 MA2 并读取后，编辑器里才会显示对应的 Cue。';
  switch (purpose) {
    case 'audio': return '读取 P1 音频，保留裁剪和原始歌曲时间码。MP4 音轨结尾缺少不超过 250 毫秒时会补上静音，保证节目长度和灯光时间码不变。P1 里没有控台 Cue 列表；要显示 Cue，请在设备连接里扫描控台后导入。写回 P1 会生成一个独立的 .hia；重新打开联动工程后，选择上次读取或导出的 P1 文件就能导出，不需要启动 P1 或连接控台网络。';
    case 'migration': return '把另一台电脑上的 .hia 和歌曲文件夹复制到同一个文件夹里。可以只导入音乐，也可以同时按原始时间码匹配控台 Cue。同名音频或时间线无法确定对应关系时，会单独列出来。';
    case 'follow': return autoFollow ? '已开启自动监听：在 P1 里打开生成的 .hia，直接点歌曲就会选中节目并跟随时间线。停止联动后，可以在集成中心恢复监听。' : '生成一次联动工程后，在 P1 里点歌曲就能自动控制 OBS，不用每首歌单独准备。';
  }
}

export function P1ProjectSyncPanel({ disabled = false, notify, purpose = 'follow', heading = true, afterImport, directImport = false, onBusyChange }: Props): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const documentId = useDocumentStore((state) => state.documentId);
  const [p1ProjectPath, setP1ProjectPath] = useState('');
  const [busy, setBusyState] = useState(false);
  const setBusy = (value: boolean): void => { setBusyState(value); onBusyChange?.(value); };
  const [progress, setProgress] = useState<LinkP1ProjectImportProgress | null>(null);
  const activeImport = useRef<string | null>(null);
  const cancelledImport = useRef(false);
  const [summary, setSummary] = useState<SyncSummary | null>(null);
  // The songs the last read brought in, so their MTC starts can be listed against the live project.
  const [importedKeys, setImportedKeys] = useState<string[] | null>(null);
  const report = project && importedKeys ? p1ImportReport(project, importedKeys) : null;
  useEffect(() => () => { if (activeImport.current) void linkDesktopViewModel.cancelP1Import(activeImport.current).catch(error => console.error(error)); }, []);
  useEffect(() => {
    setP1ProjectPath('');
    setSummary(null);
    setImportedKeys(null);
  }, [documentId]);

  const importProject = async (source: 'current' | 'picker', lighting = purpose !== 'migration' && Boolean(afterImport)): Promise<void> => {
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
        '当前工程里已经有节目。读取 P1 后，P1 的音频会排在节目单前面，现有的 Cue 和手动添加的节目都会保留。要继续吗？'
      )) return;
      const targetDocumentId = document.documentId;
      // P1 audio is copied next to the project file.
      const projectPath = await requireProjectLocation('导入 P1 工程');
      if (!projectPath) return;
      assertDocumentSession(targetDocumentId);
      const progressId = crypto.randomUUID();
      activeImport.current = progressId;
      cancelledImport.current = false;
      setProgress({ id: progressId, completed: 0, total: 0, song: '', state: 'starting' });
      const imported = await linkDesktopViewModel.importP1Project({ p1ProjectPath: sourcePath, linkProjectPath: projectPath, progressId }, update => setProgress(update));
      activeImport.current = null;
      setProgress(null);
      const command = synchronizeP1ProjectCommand(imported);
      useDocumentStore.getState().executeForDocument(targetDocumentId, purpose !== 'follow' ? { ...command, label: '导入 P1 音频，由联动台播放', execute: value => setPlaybackSourceCommand('internal').execute(command.execute(value)) } : command);
      setP1ProjectPath(imported.sourcePath);
      const keys = imported.items.map(item => item.p1Media.sourceKey);
      setImportedKeys(keys);
      const updated = useDocumentStore.getState().project;
      const sameName = updated ? p1ImportReport(updated, keys).sameName.length : 0;
      setSummary({
        path: imported.sourcePath,
        itemCount: imported.items.length,
        playlistCount: imported.playlists.length,
        updatedAt: new Date().toLocaleString('zh-CN')
      });
      notify(`已导入 ${imported.items.length} 首歌，每首歌的 MTC 起始码都按 P1 里的原样保留，下方列出了每首的起始码。${imported.skippedItems?.length ? `另有 ${imported.skippedItems.length} 首需要修复，已保留在节目单。` : ''}${sameName ? `有 ${sameName} 首本地歌和 P1 里的歌同名但起始码不同，请在下方确认。` : ''}${purpose === 'audio' ? '由联动台播放，不需要启动 P1。' : ''}`);
      if (lighting && afterImport) await afterImport();
    } catch (error) {
      notify(cancelledImport.current ? '已取消导入 P1，当前工程没有变化' : error instanceof Error ? error.message : String(error), 'error');
    } finally {
      activeImport.current = null;
      setProgress(null);
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
        `没有参考音频、不会写入 P1：${preview.ignoredCount}`,
        `输出：${preview.targetPath}`,
        '',
        '联动台的 OBS、视频和灯光 Cue 保存在 .tblink 里，由 P1 的 MTC 驱动，不会写入 P1。'
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
      setP1ProjectPath(exported.outputPath);
      setSummary({
        path: exported.outputPath,
        itemCount: exported.itemBindings.length,
        playlistCount: exported.playlists.length,
        updatedAt: new Date().toLocaleString('zh-CN')
      });
      notify(`P1 同步工程已生成：${exported.outputPath}。请在 P1 里打开这个 .hia 文件。`);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const p1Status: ConnectionStatus = project?.p1Sync ? { state: 'ready', value: '已关联', detail: '这个工程已经存了 P1 的歌曲' } : { state: 'idle', value: '未读取', detail: '还没有读取 P1 工程' };
  const closeAndImport = (event: MouseEvent<HTMLButtonElement>, source: 'current' | 'picker', lighting?: boolean): void => {
    event.currentTarget.closest('details')?.removeAttribute('open');
    void importProject(source, lighting);
  };
  const explanation = panelExplanation(purpose, directImport, project?.p1AutoFollow?.enabled === true);
  return <section className="settings-stack" aria-label="P1 音频工程同步">
    {heading ? <header className="settings-subsection-header"><h3>P1 音频工程同步</h3><StatusBadge name="P1 工程" status={p1Status} /></header> : null}
    {heading ? <p className="settings-connection-address p1-import-path" title={p1ProjectPath || (project?.p1Sync ? '已保存在联动工程里，不用重新导入' : '还没选择 P1 工程')}>
      {p1ProjectPath || (project?.p1Sync ? `已保存 P1 歌曲 · ${new Date(project.p1Sync.importedAt).toLocaleString('zh-CN')}` : '还没选择 .hia 工程')}
    </p> : null}
    {progress ? <Progress label="P1 导入进度" title="导入 P1 歌曲" status={progress.total ? `${progress.completed} / ${progress.total}` : '正在统计歌曲'} value={progress.completed} max={progress.total || undefined}
      detail={progress.song ? `${progress.state === 'skipped' ? '待修复' : '已导入'}：${progress.song}` : '正在读取 P1 工程'}>
      <Button variant="secondary" size="sm" onClick={() => { const id = activeImport.current; if (id) { cancelledImport.current = true; void linkDesktopViewModel.cancelP1Import(id).catch(error => notify(String(error), 'error')); } }}>取消导入</Button>
    </Progress> : null}
    <div className="settings-actions-row">
      {directImport ? <Button variant="primary" icon={FolderOpen} disabled={disabled || busy} onClick={() => void importProject('picker')}>导入 P1 歌曲（.hia）</Button> : null}
      {afterImport ? <Button variant="primary" icon={Download} disabled={disabled || busy} onClick={() => void importProject(purpose === 'migration' ? 'picker' : 'current', true)}>{purpose === 'migration' ? '导入 P1 音乐并匹配控台 Cue' : '一键读取当前音频与灯光'}</Button> : null}
      {purpose !== 'migration' && !directImport ? <>
        <Button variant="secondary" icon={Upload} aria-label="同步回 P1 工程" disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject()}>写回 P1</Button>
        {purpose === 'follow' ? <Button variant="secondary" icon={AudioLines} disabled={disabled || busy || !project?.p1Sync} onClick={() => void exportProject(true)}>生成点击播放联动工程</Button> : null}
      </> : null}
    </div>
    {directImport ? null : <Disclosure className="p1-import-choices" title={purpose === 'migration' ? '仅导入 P1 音乐' : '导入 P1 工程'} description="读取 P1 正在打开的工程，或者选一个 .hia 文件">
      <div className="settings-actions-row">
        <Button variant="secondary" icon={Download} disabled={disabled || busy} onClick={event => closeAndImport(event, 'current')}>读取 P1 当前工程</Button>
        <Button variant="secondary" icon={FolderOpen} disabled={disabled || busy} onClick={event => closeAndImport(event, 'picker')}>选择 .hia 文件</Button>
        {afterImport && purpose !== 'migration' ? <Button variant="secondary" icon={FolderOpen} disabled={disabled || busy} onClick={event => closeAndImport(event, 'picker', true)}>选择 .hia 并读取音频与灯光</Button> : null}
      </div>
    </Disclosure>}
    <p>{explanation}</p>
    {purpose === 'migration' ? <p>只导入音乐不需要连接控台；匹配 Cue 要先连接 MA2。在同一个联动工程里重复选同一份 .hia，会更新已有歌曲、复用相同的音频，并跳过已绑定的 Cue。改过 .hia 里的歌曲路径的话，可能会被当成新歌曲。</p> : null}
    {project ? <P1ImportDetails project={project} songs={report?.songs ?? []} /> : null}
    {project && report?.sameName.length ? <P1SameNameList project={project} entries={report.sameName} disabled={disabled || busy} notify={notify} /> : null}
    {summary ? <p className="p1-import-summary"><strong>{summary.itemCount}</strong> 首音频 · <strong>{summary.playlistCount}</strong> 个列表 · {summary.updatedAt}<br /><span className="settings-connection-address" title={summary.path}>{summary.path}</span></p> : null}
    {project?.p1Sync?.skippedItems?.length ? <Disclosure open className="p1-import-issues" title={`已保留 ${project.p1Sync.skippedItems.length} 首需要修复的节目，其余歌曲可以正常播放`}>
      <p>下面这些歌曲保留在节目单里，但已停用。补齐原文件后重新导入就能恢复；写回 P1 时原条目也会保留。</p>
      {project.p1Sync.skippedItems.map(entry => <p key={entry.sourceKey}><strong>{entry.playlistName} / {entry.title}</strong>：{entry.reason}</p>)}
    </Disclosure> : null}
  </section>;
}

/** Songs whose P1 trim was repaired, and the MTC start of each song the last import brought in. */
function P1ImportDetails({ project, songs }: { project: LinkProject; songs: readonly { itemId: string; title: string }[] }): JSX.Element {
  const repaired = project.rundown.filter(item => item.notes.startsWith('P1 裁剪'));
  return <>
    {repaired.length ? <Disclosure className="p1-import-issues" title="已恢复的歌曲：请检查裁剪范围">{repaired.map(item => <p key={item.id}><strong>{item.title}</strong>：{item.notes}</p>)}</Disclosure> : null}
    {songs.length ? <Disclosure className="p1-import-issues" title={`这次导入的 ${songs.length} 首歌和它们的 MTC 起始码`}>
      <ul className="settings-song-list">{songs.map(song => {
        const item = project.rundown.find(value => value.id === song.itemId);
        return item ? <li key={song.itemId}><span>{song.title}</span><SongMtcStart project={project} item={item} /></li> : null;
      })}</ul>
    </Disclosure> : null}
  </>;
}

/**
 * Local songs named like a song from P1 but starting elsewhere. A console timeline recorded in the
 * old P1 workflow starts at the P1 song's start, so the operator can move an unlit local song there;
 * a song lit on its own console timeline is only explained, since its start moves that timeline.
 */
function P1SameNameList({ project, entries, disabled, notify }: { project: LinkProject; entries: P1SameNameSong[]; disabled: boolean; notify: Props['notify'] }): JSX.Element {
  const code = (ms: number): string => formatMtcOffset(ms, project.timebase.frameRate);
  const adopt = (entry: P1SameNameSong): void => {
    const local = project.rundown.find(item => item.id === entry.localId);
    if (!local) { notify(`节目单里已经没有「${entry.localTitle}」`, 'error'); return; }
    try {
      useDocumentStore.getState().execute(setItemPlaybackCommand(local.id, withP1MtcStart(local, entry.p1StartMs)));
      notify(`「${entry.localTitle}」的 MTC 起始码已改成 ${code(entry.p1StartMs)}，和 P1 里的「${entry.p1Title}」一样。可以撤销。`);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <Disclosure open className="p1-import-issues" title={`有 ${entries.length} 首本地歌和 P1 里的歌同名，但 MTC 起始码不同`}>
    <p>控台上按老流程录的时间线，是从 P1 的起始码开始的。确认是同一首歌后，把本地这首改成 P1 的起始码，就能和控台上的时间线配对。</p>
    {entries.map(entry => <div className="settings-same-name" key={entry.localId}>
      <p><strong>{entry.localTitle}</strong>：本地是 {entry.localStart.state === 'set' ? code(entry.localStart.startMs) : entry.localStart.state === 'unset' ? '还没有起始码' : `无效的起始码（${entry.localStart.reason}）`}，P1 的「{entry.p1Title}」是 {code(entry.p1StartMs)}。
        {entry.durationDifferenceMs !== null && entry.durationDifferenceMs > 500 ? `两首音频长度差 ${(entry.durationDifferenceMs / 1000).toFixed(1)} 秒，P1 可能裁剪过开头，请先核对再改。` : ''}
        {entry.lit ? '这首歌在控台上已经有自己的时间线，改起始码会把那条时间线一起挪走，所以这里不提供一键修改。要用控台上原来录的时间线，请给 P1 导入的那首配对。' : null}</p>
      {entry.lit ? null : <div className="settings-actions-row"><Button variant="secondary" size="sm" disabled={disabled} onClick={() => adopt(entry)}>改成 P1 的起始码</Button></div>}
    </div>)}
  </Disclosure>;
}

async function ensureLinkDocument(sourcePath: string): Promise<void> {
  const initial = useDocumentStore.getState();
  if (initial.project) return;
  const sourceName = sourcePath.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.hia$/i, '').trim();
  const project = await linkDesktopViewModel.createProject(sourceName ? `${sourceName} 联动工程` : 'P1 联动工程');
  if (useDocumentStore.getState().documentId !== initial.documentId || useDocumentStore.getState().project) {
    throw new Error('工程已切换，已取消自动创建 P1 联动工程');
  }
  useDocumentStore.getState().setProject(project, null);
}

