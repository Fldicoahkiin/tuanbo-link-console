import { CueTrackingChoice } from './CueTrackingChoice';
import { setCueTrackingPreference, useCueTrackingPreference, setMa2ConsoleChanges, setMa2WriteMode, useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { pauseMa2RealtimeSession, pendingSongSummary, unlinkedSongSummary, recheckMa2Songs, retryMa2RealtimeSession, songsWithoutConsoleShow, syncMa2Once, writeMissingConsoleShows } from '../runtime/ma2-realtime-session';
import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronRight, Circle, CircleStop, Clock3, FolderArchive, FolderOpen, RefreshCw, Save, SlidersHorizontal } from 'lucide-react';
import type { LinkProject, Ma2ConsoleChanges, Ma2WriteMode, ProjectArchiveResult } from '@tb/schema';
import { hasMa2SongSyncTarget, ma2PendingChanges } from '@tb/core/link';
import { writeMa2NamesNow } from '../runtime/ma2-name-sync';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { currentShowWait, useShowGate } from '../stores/show-state-store';
import { takeMa2SongFromConsole, writeMa2SongFromSoftware } from '../runtime/ma2-song-sync';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { useSelectedProgram } from '../useSelectedProgram';
import { ma2WorkbenchSyncStatus } from '../view-models/ma2-workbench-sync-status';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { pendingMa2Renames, ma2RenameKey } from '@tb/core/link';
import { useRecoveryCopyStore } from '../recovery-copy-writer';
import { confirmReplaceDocument, saveDocument } from '../project-document';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from '../runtime/ma2-legacy-names';
import { Button, ChoiceGroup, Dialog, IconButton, Notice, Popover, Switch, type Choice } from '../ui';
import { Ma2SongDestinationDialog } from './Ma2SongDestination';
import './lighting-sync.css';

/** The write modes of 2026-11-04, after the sync dialog the user showed from another program. */
const WRITE_MODES: readonly Choice<Ma2WriteMode>[] = [
  { value: 'merge', title: '合并（保留控台上的 Cue）', help: '控台上新录的 Cue、改的名字和重新存的灯都留着，联动台只写自己改过的。' },
  { value: 'overwrite', title: '覆盖（只留联动台的 Cue）', help: '每首歌的序列只留时间线上的 Cue：控台上多出来的 Cue 删掉，名字和灯按联动台写回。' },
  { value: 'direct', title: '直接写入（不删除）', help: '只写新加和改过的 Cue，什么都不删：联动台删掉的点，控台序列里的 Cue 留着，只是不再触发。' }
];
const CONSOLE_CHANGES: readonly Choice<Ma2ConsoleChanges>[] = [
  { value: 'read-back', title: '读回联动台', help: '控台上挪的触发、删的 Cue、新加的触发都同步到时间线上。' },
  { value: 'software', title: '以联动台为准', help: '控台上的改动不读回，下次同步按时间线写回去：挪的挪回来，删的补回来。' }
];
const WRITE_LABEL: Record<Ma2WriteMode, string> = { merge: '合并', overwrite: '覆盖', direct: '直接写入' };
const CHANGES_LABEL: Record<Ma2ConsoleChanges, string> = { 'read-back': '读回控台改动', software: '以联动台为准' };
const STATUS_ICONS = { verified: Check, idle: Circle, writing: Clock3 };

function chooseMa2WriteMode(mode: Ma2WriteMode, confirmed: boolean, confirm: (value: boolean) => void): void {
  // Overwriting deletes Cues on the console, so it is confirmed once.
  if (mode === 'overwrite' && !confirmed) { confirm(true); return; }
  confirm(false); setMa2WriteMode(mode); recheckMa2Songs();
}

async function revealArchives(name?: string): Promise<void> {
  const path = useDocumentStore.getState().path;
  if (!path) throw new Error('请先保存工程');
  await linkDesktopViewModel.projectArchives({ version: 1, action: 'reveal', projectPath: path, ...(name ? { name } : {}) });
}

/**
 * A song that does not match the console yet. A stopped way-1 song has two ways out (2026-11-11): each
 * drops one side, so it is confirmed once.
 */
function UnsettledSong({ song, title, stopped, disabled, busy, choose }: { song: SongSync; title: string; stopped: boolean; disabled: boolean; busy: boolean; choose: (side: 'console' | 'software') => Promise<void> }): JSX.Element {
  const [asking, setAsking] = useState<'console' | 'software' | null>(null);
  return <div className="lighting-sync-song">
    <p role={song.state === 'blocked' ? 'alert' : 'status'}>{title}：{song.state === 'blocked' ? song.message : song.progress?.detail ?? song.message}</p>
    {stopped ? <div className="lighting-sync-song-actions">
      <Button variant="secondary" size="sm" disabled={disabled} title="读控台上这首歌现在的时间线，换掉联动台里的；联动台没写到控台的改动先存档" onClick={() => setAsking('console')}>用控台上的</Button>
      <Button variant="secondary" size="sm" disabled={disabled} title="按联动台的时间线写到控台，控台上的改动写回去；控台上的版本写入前会备份" onClick={() => setAsking('software')}>用联动台的</Button>
    </div> : null}
    {stopped && asking ? <Notice tone="warning" title={asking === 'console' ? `「${title}」换成控台上的版本？` : `「${title}」按联动台的写到控台？`} actions={<>
      <Button variant="danger" size="sm" disabled={busy} onClick={() => { setAsking(null); void choose(asking); }}>{asking === 'console' ? '用控台上的' : '用联动台的'}</Button>
      <Button variant="secondary" size="sm" onClick={() => setAsking(null)}>取消</Button>
    </>}>{asking === 'console' ? '联动台里这首歌还没写到控台的灯光改动会去掉，换成控台上现在的。去掉之前先存档，可以在“存档”里找回。' : '控台上这首歌改过的点会按联动台的时间线写回去。写入前控台上会留一份备份。'}</Notice> : null}
  </div>;
}

function ConfirmedSongs({ songs, itemId, rundown, total }: { songs: SongSync[]; itemId: string | null; rundown: LinkProject['rundown']; total: number }): JSX.Element {
  const selected = songs.find(song => song.itemId === itemId);
  const others = songs.filter(song => song !== selected);
  const titles = new Map(rundown.map(item => [item.id, item.title]));
  return <>
    {total ? <p>{songs.length === total ? `${songs.length} 首歌都和控台一致` : `已确认 ${songs.length}/${total} 首`}</p> : null}
    {selected ? <p>当前节目 · {titles.get(selected.itemId) ?? selected.name}：{selected.message}</p> : null}
    {others.length ? <details className="lighting-sync-confirmed"><summary>{others.length} 首歌已在控台确认</summary>
      {others.map(song => <p key={song.itemId}>{titles.get(song.itemId) ?? song.name}：{song.message}</p>)}
    </details> : null}
  </>;
}

/** 第 3 题 (S3b): the sync waits only while the program moves, prepares or stops; restoring an archive replaces the
 * project, which waits until the show has stopped. Both say why in showGate's own words. */
async function saveLightingProject(notice: (text: string) => void, notify: (text: string) => void): Promise<void> {
  const state = useDocumentStore.getState();
  if (!state.project) return;
  const outcome = await saveDocument();
  if (outcome.status === 'failed') throw new Error(outcome.message);
  if (outcome.status === 'canceled') return;
  const archived = await archiveMa2Project(state.documentId, state.project, 'manual');
  notice(`本地已保存并存档：${archived ?? ''}`); notify('本地已保存并创建存档');
}

async function lightingArchives(): Promise<ProjectArchiveResult['entries']> {
  const path = useDocumentStore.getState().path;
  if (!path) throw new Error('请先保存工程');
  return (await linkDesktopViewModel.projectArchives({ version: 1, action: 'list', projectPath: path })).entries;
}
async function restoreLightingArchive(name: string): Promise<boolean> {
  const state = useDocumentStore.getState(), wait = currentShowWait('document.replace');
  if (wait !== null || !state.path || !state.project) throw new Error(wait ?? '请先保存工程');
  // 保存 puts the latest edits into the "恢复前" archive the restore makes; 不保存 drops them.
  const replaced = await confirmReplaceDocument('restore-archive');
  if (!replaced) return false;
  const projectPath = useDocumentStore.getState().path;
  if (!projectPath) throw new Error('请先保存工程');
  await linkDesktopViewModel.projectArchives({ version: 1, action: 'restore', projectPath, name });
  const reopened = await linkDesktopViewModel.openProject(projectPath);
  useDocumentStore.getState().setProject(reopened.project, reopened.path, { upgraded: reopened.upgraded });
  await replaced();
  return true;
}

export function Ma2PendingChanges({ notify }: { notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const syncGate = useShowGate('ma2.sync.write'), replaceGate = useShowGate('document.replace');
  const project = useDocumentStore(state => state.project);
  const documentId = useDocumentStore(state => state.documentId);
  const targetIds = useMemo(() => new Set(project?.rundown.filter(item => hasMa2SongSyncTarget(item.lighting)).map(item => item.id)), [project?.rundown]);
  const [itemId, selectProgram] = useSelectedProgram(notify);
  const allUnlinked = useMemo(() => unlinkedSongSummary(project), [project]);
  const pending = useMemo(() => ma2PendingChanges(project), [project]);
  const unbound = useMemo(() => pendingSongSummary(project), [project]);
  const showless = useMemo(() => songsWithoutConsoleShow(project), [project]);
  const renames = useMemo(() => pendingMa2Renames(project), [project]);
  const legacy = useMemo(() => legacyMa2ConsoleNames(project), [project]);
  const session = useMa2SyncStore(state => state.session), names = useMa2SyncStore(state => state.names);
  const active = useMa2RealtimePreference(state => state.enabled);
  const once = useMa2RealtimePreference(state => state.once);
  const defaultTracking = useCueTrackingPreference(state => state.includeTracking);
  const writeMode = useMa2RealtimePreference(state => state.writeMode);
  const consoleChanges = useMa2RealtimePreference(state => state.consoleChanges);
  const [modesOpen, setModesOpen] = useState(false);
  const [modesAnchor, setModesAnchor] = useState<HTMLButtonElement | null>(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const closeModes = useCallback(() => { setModesOpen(false); setConfirmOverwrite(false); }, []);
  const timelineRead = useMa2ReadStore(state => state.busy ? (state.progress?.phase === 'selection' ? '正在检查选曲' : '正在读取时间线') : null);
  const readingMaterials = useMa2MaterialReadStore(state => state.busy && state.documentId === documentId);
  const recoveryError = useRecoveryCopyStore(state => state.error);
  const songSync = useMa2SyncStore(state => state.songs);
  const songs = Object.values(songSync).filter(song => song.documentId === documentId && (targetIds.has(song.itemId) || song.requestId));
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<ProjectArchiveResult['entries']>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [refreshItem, setRefreshItem] = useState<string | null>(null);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [archivingOff, setArchivingOff] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [statusAnchor, setStatusAnchor] = useState<HTMLButtonElement | null>(null);
  const closeDetails = useCallback(() => setDetailOpen(false), []);
  if (!project) return null;
  const working = names.state === 'syncing' || songs.some(song => song.state === 'syncing' || song.requestId);
  // One count per song, either way it was lit. A way 1 song keeps the baseline the console confirmed,
  // so its edits are counted from that: an undo back to it leaves nothing to sync, also while playing.
  const imported = (itemId: string): boolean => Boolean(project.rundown.find(item => item.id === itemId)?.lighting?.ma2Bindings?.length);
  const pendingIds = new Set([...unbound, ...showless, ...pending, ...songs.filter(song => song.localEditedAt !== undefined)].map(song => song.itemId));
  const detailSong = (song: { itemId: string }): boolean => !refreshItem || song.itemId === refreshItem;
  const detailSongs = songs.filter(detailSong);
  const unlinked = allUnlinked.filter(detailSong);
  const unsettled = detailSongs.filter(song => song.state !== 'verified');
  const settled = detailSongs.filter(song => song.state === 'verified' && !pendingIds.has(song.itemId));
  const count = pendingIds.size + renames.length;
  const manual = !active && once === null;
  const { label: status, tone } = ma2WorkbenchSyncStatus({
    songs, targetCount: targetIds.size + songs.filter(song => !targetIds.has(song.itemId)).length, names: names.state, session, localCount: count, recoveryError, manual,
    reading: timelineRead !== null || readingMaterials
  });
  const run = async (action: () => Promise<void> | void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setNotice(message); setDetailOpen(true); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const chooseWriteMode = (mode: Ma2WriteMode): void => chooseMa2WriteMode(mode, confirmOverwrite, setConfirmOverwrite);
  const chooseConsoleChanges = (choice: Ma2ConsoleChanges): void => { setMa2ConsoleChanges(choice); recheckMa2Songs(); };
  const save = () => saveLightingProject(setNotice, notify);
  const loadArchives = async (): Promise<void> => {
    setArchives(await lightingArchives()); setArchiveOpen(true); setDetailOpen(false);
  };
  const restore = async (name: string): Promise<void> => {
    if (!await restoreLightingArchive(name)) return;
    setConfirmRestore(null); setArchiveOpen(false); notify('已恢复存档；恢复前的工程另存为“恢复前”存档');
  };
  const refreshSelected = (): void => {
    if (!itemId) return;
    setRefreshItem(itemId); setNotice(''); setDetailOpen(true);
    if (targetIds.has(itemId)) syncMa2Once(itemId);
  };
  const openDetails = (): void => {
    setRefreshItem(null);
    if (!detailOpen) void linkDesktopViewModel.projectArchiveSettings({ action: 'status' }).then(value => setArchivingOff(!value.settings.enabled), (error: unknown) => setNotice(`存档设置读取失败：${error instanceof Error ? error.message : String(error)}`));
    setDetailOpen(value => !value); setArchiveOpen(false); setModesOpen(false);
  };
  return <section className="lighting-sync" aria-label="灯光同步操作">
    <header className="lighting-sync-heading">
      <h2>控台同步</h2>
      <IconButton ref={setModesAnchor} size="sm" className="lighting-sync-modes" icon={SlidersHorizontal} label="同步方式" title={`同步方式：${WRITE_LABEL[writeMode]} · ${CHANGES_LABEL[consoleChanges]}`}
        aria-expanded={modesOpen} aria-haspopup="dialog" onClick={() => { setModesOpen(value => !value); setDetailOpen(false); setConfirmOverwrite(false); }} />
      <Switch className="lighting-sync-switch" label="实时同步" aria-label="实时同步" aria-checked={active} checked={active} disabled={busy || (working && !active)}
        title="编辑完成后自动检查、存档、写入控台并确认；节目在走时先暂存，暂停或停止后再同步" onChange={() => {
          setNotice('');
          void run(active ? pauseMa2RealtimeSession : retryMa2RealtimeSession);
        }} />
    </header>
    <Button ref={setStatusAnchor} variant="ghost" className="lighting-sync-status" icon={STATUS_ICONS[tone]} aria-label="同步状态详情" aria-expanded={detailOpen} aria-haspopup="dialog" data-state={tone} title={status ?? '查看同步详情'} onClick={openDetails}>
      <span>同步详情</span><span className="lighting-sync-result" aria-live="polite" aria-atomic="true">{status}</span><ChevronRight aria-hidden="true" />
    </Button>
    <Button variant="ghost" size="sm" onClick={() => { setDestinationOpen(true); setDetailOpen(false); setModesOpen(false); }}>写入位置</Button>
    <div className="lighting-sync-actions">
      {active ? <Button variant="secondary" size="sm" icon={RefreshCw} disabled={!itemId} title="重新读取当前节目的控台时间线，并同步改动" onClick={refreshSelected}>刷新同步</Button>
        : once !== null ? <Button variant="secondary" size="sm" icon={CircleStop} title="停下这次同步，没写完的修改留在联动台" onClick={() => { setNotice(''); pauseMa2RealtimeSession(); }}>停止同步</Button>
        : <Button variant="secondary" size="sm" icon={RefreshCw} disabled={!itemId} title="按当前同步方式，将当前节目与控台同步一次" onClick={refreshSelected}>同步一次</Button>}
      <Button variant="secondary" size="sm" icon={Save} disabled={busy} title="保存工程并创建存档" onClick={() => void run(save)}>保存</Button>
      <Button variant="secondary" size="sm" icon={FolderArchive} disabled={busy} title="查看和恢复存档" onClick={() => archiveOpen ? setArchiveOpen(false) : void run(loadArchives)}>存档</Button>
    </div>
    {modesOpen ? <Popover anchor={modesAnchor} placement="right-end" label="同步方式" className="lighting-sync-details lighting-sync-modes-panel" onClose={closeModes}>
      <h3>同步方式：{WRITE_LABEL[writeMode]} · {CHANGES_LABEL[consoleChanges]}</h3>
      <h4>写入控台</h4>
      <ChoiceGroup label="写入控台" value={confirmOverwrite ? 'overwrite' : writeMode} choices={WRITE_MODES} disabled={working} onChange={chooseWriteMode} />
      {confirmOverwrite ? <Notice tone="warning" title="覆盖会删掉控台上的 Cue" actions={<>
        <Button variant="danger" size="sm" onClick={() => chooseWriteMode('overwrite')}>改成覆盖</Button>
        <Button variant="secondary" size="sm" onClick={() => setConfirmOverwrite(false)}>取消</Button>
      </>}>每首歌序列里时间线上没有的 Cue 都会删掉。写入前控台上会留一份备份。</Notice> : null}
      <p>只管联动台在按钮页建的歌。控台自己录的时间线只改时间线上的点，不删控台的序列。</p>
      <h4>控台上的改动</h4>
      <CueTrackingChoice label="新增素材默认复制范围" value={defaultTracking} onChange={setCueTrackingPreference} />
      <small>已有点位保留各自的选择。编辑组合时，每个素材都能单独设置。</small>
      <ChoiceGroup label="控台上的改动" value={consoleChanges} choices={CONSOLE_CHANGES} disabled={working} onChange={chooseConsoleChanges} />
      <p>{active ? '实时同步开着：改完自动同步。关掉后，只在点“同步一次”时写到控台。' : '实时同步关着：改动先留在联动台，点“同步一次”才写到控台。'}改了同步方式，每首歌下次同步时按新的方式重新检查一遍。</p>
    </Popover> : null}
    {detailOpen ? <Popover anchor={statusAnchor} placement="right-end" label="同步状态详情" className="lighting-sync-details" onClose={closeDetails}>
      <h3>{refreshItem ? `同步 · ${project.rundown.find(item => item.id === refreshItem)?.title ?? '当前节目'}` : status ? `全工程 · ${status}` : '全工程同步详情'}</h3>
      {recoveryError ? <p role="alert">{recoveryError}</p> : null}
      {archivingOff ? <p>已关闭存档，写入前不再备份。</p> : null}
      <p>同步方式：{WRITE_LABEL[writeMode]} · {CHANGES_LABEL[consoleChanges]}</p>
      {notice ? <p role="status">{notice}</p> : null}
      {refreshItem && !targetIds.has(refreshItem) && !unlinked.length ? <p>这个节目还没有控台时间线。</p> : null}
      {timelineRead || readingMaterials ? <p>{timelineRead ?? '正在读取灯光素材'}</p> : null}
      {session.status === 'blocked' ? <p role="alert">{session.message}</p> : manual ? <p>实时同步已关，修改先留在联动台。点“同步一次”写到控台。</p>
        : session.status === 'waiting' || !songs.length ? <p>{session.message}</p> : null}
      {unsettled.map(song => <UnsettledSong key={song.itemId} song={song} title={project.rundown.find(item => item.id === song.itemId)?.title ?? song.name}
        stopped={song.state === 'blocked' && imported(song.itemId)} disabled={busy || working || syncGate.kind === 'wait'} busy={busy} choose={side => run(async () => setNotice(side === 'console' ? await takeMa2SongFromConsole(song.itemId) : writeMa2SongFromSoftware(song.itemId)))} />)}
      <ConfirmedSongs songs={settled} total={refreshItem ? Number(targetIds.has(refreshItem)) : targetIds.size} itemId={refreshItem ?? itemId} rundown={project.rundown} />
      {syncGate.kind === 'wait' ? <p>{syncGate.message}</p> : null}
      {!refreshItem && <>{names.state !== 'idle' && names.state !== 'verified' && names.message ? <p role={names.state === 'blocked' ? 'alert' : 'status'}>改名：{names.message}</p> : null}
      {renames.map(change => <p key={ma2RenameKey(change)}>序列 {change.sequence}{change.kind === 'single' ? ` · Cue ${change.cue}` : ''}：{change.confirmedName} → {change.name}</p>)}
      {renames.length ? <Button variant="secondary" size="sm" disabled={busy || working} onClick={() => void run(() => writeMa2NamesNow(useDocumentStore.getState().documentId))}>同步名称</Button> : null}
      {legacy.count ? <><p>控台上有 {legacy.count} 个以前写入的中文名称，控台只能显示英文和数字。</p><Button variant="secondary" size="sm" disabled={busy || working || syncGate.kind === 'wait'} onClick={() => void run(async () => { const count = await convertMa2LegacyNames(useDocumentStore.getState().documentId); setNotice(`已把 ${count} 个名称改成拼音，歌曲名称会在下次同步时写入`); })}>改为拼音</Button></> : null}
      </>}
      {pending.filter(detailSong).map(item => <p key={`${item.itemId}:${item.bindingId}`}>{item.title} · Timecode {item.target}：{item.error ?? `${item.changes.length} 处修改`}</p>)}
      {unbound.filter(detailSong).map(item => <p key={item.itemId}>{item.title} · {item.count} 个 Cue → 按钮第 {item.page} 页的空格。</p>)}
      {unlinked.length ? <div className="lighting-sync-song" aria-label="待关联节目"><h4>待关联 · {unlinked.length} 个节目</h4><p>先选择或新建时间线，才能同步这些 Cue。</p>{unlinked.map(song => <div className="lighting-sync-song" key={song.itemId}><p>{song.title} · {song.count} 个 Cue · 尚未关联时间线</p><Button size="sm" variant="secondary" aria-label={`为「${song.title}」选择时间线`} onClick={() => { selectProgram(song.itemId); setDetailOpen(false); useMa2ReadStore.setState({ openWorkspace: true, browserOpen: true }); }}>选择时间线</Button></div>)}</div> : null}
      {!refreshItem && showless.length ? <><p>有 {showless.length} 首歌要同步到控台才能演出：{showless.map(item => item.title).join('、')}。同步会为每首歌在控台上建立自己的时间码节目。</p><Button variant="secondary" size="sm" disabled={busy || working} onClick={() => { setNotice(''); writeMissingConsoleShows(); }}>同步到控台</Button></> : null}
    </Popover> : null}
    {destinationOpen ? <Ma2SongDestinationDialog onClose={() => setDestinationOpen(false)} /> : null}
    {archiveOpen ? <Dialog title="灯光工程存档" description="保存整个工程和原始 XML，同步前会自动存一份。恢复时写回原工程位置，恢复前的工程也会另存一份。" onClose={() => setArchiveOpen(false)}
      actions={<Button variant="secondary" icon={FolderOpen} onClick={() => void run(() => revealArchives())}>打开存档位置</Button>}>
      {!archives.length ? <p>还没有存档，点“保存”创建。</p> : <ul className="lighting-sync-archives">{archives.slice(0, 100).map(entry => <li key={entry.name}>
        <span>{new Date(entry.createdAt).toLocaleString()} · {entry.reason === 'manual' ? '手动保存' : '同步前'}</span>
        <Button variant="ghost" size="sm" aria-label={`定位存档 ${entry.name}`} onClick={() => void run(() => revealArchives(entry.name))}>定位文件</Button>
        {confirmRestore === entry.name
          ? <Button variant="danger" size="sm" aria-label={`确认恢复存档 ${entry.name}`} disabled={busy || replaceGate.kind === 'wait'} onClick={() => void run(() => restore(entry.name))}>确认恢复</Button>
          : <Button variant="secondary" size="sm" aria-label={`恢复存档 ${entry.name}`} disabled={busy || replaceGate.kind === 'wait'} onClick={() => setConfirmRestore(entry.name)}>恢复</Button>}
      </li>)}</ul>}
    </Dialog> : null}
  </section>;
}
