import { useMa2StatusForSong } from '../runtime/use-ma2-song-status';
import { CueTrackingChoice } from './CueTrackingChoice';
import { setCueTrackingPreference, useCueTrackingPreference, setMa2ConsoleChanges, setMa2WriteMode, useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { muteMa2SelectorTrack, pauseMa2RealtimeSession, pendingSongSummary, unlinkedSongSummary, recheckMa2Songs, songsWithoutConsoleShow, syncMa2Once, writeMissingConsoleShows } from '../runtime/ma2-realtime-session';
import { useCallback, useMemo, useState } from 'react';
import { ChevronRight, CircleStop, MapPin, RefreshCw, SlidersHorizontal } from 'lucide-react';
import type { LinkProject, Ma2ConsoleChanges, Ma2WriteMode } from '@tb/schema';
import { hasMa2SongSyncTarget, MA2_SONG_NATIVE_ACTION, ma2PendingChanges } from '@tb/core/link';
import { writeMa2NamesNow } from '../runtime/ma2-name-sync';
import { useMa2SyncStore, type SongSync } from '../stores/ma2-sync-store';
import { useShowGate } from '../stores/show-state-store';
import { chooseMa2ConflictingPoints, takeMa2SongFromConsole, writeMa2SongFromSoftware } from '../runtime/ma2-song-sync';
import { useSelectedProgram } from '../useSelectedProgram';
import { useMa2MaterialReadStore } from '../stores/ma2-material-read-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { pendingMa2Renames, ma2RenameKey } from '@tb/core/link';
import { useRecoveryCopyStore } from '../recovery-copy-writer';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from '../runtime/ma2-legacy-names';
import { Button, ChoiceGroup, Notice, Popover, type Choice } from '../ui';
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

function chooseMa2WriteMode(mode: Ma2WriteMode, confirmed: boolean, confirm: (value: boolean) => void): void {
  // Overwriting deletes Cues on the console, so it is confirmed once.
  if (mode === 'overwrite' && !confirmed) { confirm(true); return; }
  confirm(false); setMa2WriteMode(mode); recheckMa2Songs();
}

/**
 * A song that does not match the console yet. A stopped way-1 song has two ways out (2026-11-11): each
 * drops one side, so it is confirmed once.
 */
function UnsettledSong({ song, title, stopped, disabled, busy, choose }: { song: SongSync; title: string; stopped: boolean; disabled: boolean; busy: boolean; choose: (side: 'console' | 'software') => Promise<void> }): JSX.Element {
  const readNative = song.state === 'blocked' && song.needsSourceCheck && song.message.startsWith(MA2_SONG_NATIVE_ACTION);
  const [asking, setAsking] = useState<'console' | 'software' | null>(null);
  return <div className="lighting-sync-song">
    <p role={song.state === 'blocked' ? 'alert' : 'status'}>{title}：{song.state === 'blocked' ? song.message : song.progress?.detail ?? song.message}</p>
    {song.needsConflictChoice ? <div className="lighting-sync-song-actions">
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => { chooseMa2ConflictingPoints(song.itemId, 'remote'); syncMa2Once(song.itemId); }}>冲突点用控台的</Button>
      <Button variant="secondary" size="sm" disabled={disabled} onClick={() => { chooseMa2ConflictingPoints(song.itemId, 'local'); syncMa2Once(song.itemId); }}>冲突点用联动台的</Button>
    </div> : stopped || readNative ? <div className="lighting-sync-song-actions">
      <Button variant="secondary" size="sm" disabled={disabled} title="读控台上这首歌现在的时间线，换掉联动台里的；联动台没写到控台的改动先存档" onClick={() => setAsking('console')}>用控台上的</Button>
      {stopped && <Button variant="secondary" size="sm" disabled={disabled} title="按联动台的时间线写到控台，控台上的改动写回去；控台上的版本写入前会备份" onClick={() => setAsking('software')}>用联动台的</Button>}
    </div> : null}
    {(stopped || readNative && asking === 'console') && asking ? <Notice tone="warning" title={asking === 'console' ? `「${title}」换成控台上的版本？` : `「${title}」按联动台的写到控台？`} actions={<>
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
    {selected ? <p>当前节目 · {titles.get(selected.itemId) ?? selected.name}：{selected.message}
      {selected.playbackClockNote && <small className="lighting-sync-checked">{selected.playbackClockNote}</small>}
      {selected.checkedAt !== undefined ? <small className="lighting-sync-checked">控台确认于 {new Date(selected.checkedAt).toLocaleTimeString()}</small> : null}</p> : null}
    {others.length ? <details className="lighting-sync-confirmed"><summary>{others.length} 首歌已在控台确认</summary>
      {others.map(song => <p key={song.itemId}>{titles.get(song.itemId) ?? song.name}：{song.message}{song.playbackClockNote && <small className="lighting-sync-checked">{song.playbackClockNote}</small>}</p>)}
    </details> : null}
  </>;
}

export function Ma2PendingChanges({ notify }: { notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const syncGate = useShowGate('ma2.sync.write');
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
  const [detailOpen, setDetailOpen] = useState(false);
  const [refreshItem, setRefreshItem] = useState<string | null>(null);
  const [destinationOpen, setDestinationOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [archivingOff, setArchivingOff] = useState(false);
  const [statusAnchor, setStatusAnchor] = useState<HTMLButtonElement | null>(null);
  const closeDetails = useCallback(() => setDetailOpen(false), []);
  const working = names.state === 'syncing' || songs.some(song => song.state === 'syncing' || song.requestId);
  // One count per song, either way it was lit. A way 1 song keeps the baseline the console confirmed,
  // so its edits are counted from that: an undo back to it leaves nothing to sync, also while playing.
  const imported = (itemId: string): boolean => Boolean(project?.rundown.find(item => item.id === itemId)?.lighting?.ma2Bindings?.length);
  const pendingIds = new Set([...unbound, ...showless, ...pending, ...songs.filter(song => song.localEditedAt !== undefined)].map(song => song.itemId));
  const selectedSong = songs.find(song => song.itemId === itemId);
  const detailSong = (song: { itemId: string }): boolean => !refreshItem || song.itemId === refreshItem;
  const detailSongs = songs.filter(detailSong);
  const unlinked = allUnlinked.filter(detailSong);
  const unsettled = detailSongs.filter(song => song.state !== 'verified');
  const statusForSong = useMa2StatusForSong();
  const songStatus = (id: string | null, song: SongSync | undefined) =>
    statusForSong(id, Boolean(id && targetIds.has(id)), Boolean(id && pendingIds.has(id)), song);
  const settled = detailOpen ? detailSongs.filter(song => ['verified', 'warning'].includes(songStatus(song.itemId, song).tone)) : [];
  const manual = !active && once === null;
  const { label: status, tone } = songStatus(itemId, selectedSong);
  if (!project) return null;
  const run = async (action: () => Promise<void> | void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setNotice(message); setDetailOpen(true); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const chooseWriteMode = (mode: Ma2WriteMode): void => chooseMa2WriteMode(mode, confirmOverwrite, setConfirmOverwrite);
  const chooseConsoleChanges = (choice: Ma2ConsoleChanges): void => { setMa2ConsoleChanges(choice); recheckMa2Songs(); };
  const refreshSelected = (): void => {
    if (!itemId) return;
    setRefreshItem(itemId); setDetailOpen(true); setModesOpen(false); setNotice('');
    void linkDesktopViewModel.readProjectArchiveSettings().then(value => setArchivingOff(!value.enabled), (error: unknown) => setNotice(`存档设置读取失败：${error instanceof Error ? error.message : String(error)}`));
    // A cold console read can still be finding this song's Timecode. The existing
    // one-song pass waits for that read before it checks the binding.
    if (once === null && !working && (selectedSong?.state !== 'blocked' || selectedSong.needsSourceCheck)
      && (targetIds.has(itemId) || timelineRead || readingMaterials)) syncMa2Once(itemId);
  };
  return <section className="lighting-sync" aria-label="灯光同步操作">
    <header className="lighting-sync-heading"><h2>控台同步</h2>
      <Button ref={setModesAnchor} variant="secondary" size="sm" icon={SlidersHorizontal} aria-haspopup="dialog" aria-expanded={modesOpen} onClick={() => { setModesOpen(!modesOpen); setDetailOpen(false); setConfirmOverwrite(false); }}>同步设置</Button>
    </header>
    <Button ref={setStatusAnchor} variant="primary" className="lighting-sync-primary" icon={RefreshCw} aria-label="同步" aria-haspopup="dialog" aria-expanded={detailOpen} disabled={!itemId} title="同步当前节目并查看结果" onClick={refreshSelected}>
      <span>同步当前节目</span><ChevronRight aria-hidden="true" />
    </Button>
    <span className="lighting-sync-result" role="status" data-state={tone}>{status}</span>
    {modesOpen ? <Popover anchor={modesAnchor} placement="right-end" label="同步设置" className="lighting-sync-details lighting-sync-modes-panel" onClose={closeModes}>
      <h3>同步设置</h3>
      <Button variant="secondary" size="sm" icon={MapPin} onClick={() => { setModesOpen(false); setDestinationOpen(true); }}>写入位置</Button>
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
      <p>同一个点两边都改过时，默认保留较晚的修改。控台未提供修改时间且无法判断先后时，在同步详情里选择要保留的一边。</p>
    </Popover> : null}
    {detailOpen ? <Popover anchor={statusAnchor} placement="right-end" label="同步状态详情" className="lighting-sync-details" onClose={closeDetails}>
      <h3>{refreshItem ? `同步 · ${project.rundown.find(item => item.id === refreshItem)?.title ?? '当前节目'}` : '全工程同步详情'}</h3>
      {refreshItem && refreshItem === itemId && tone !== 'verified' && <p role="status">{status}</p>}
      {refreshItem && selectedSong?.itemId === refreshItem && selectedSong.state === 'blocked' && !selectedSong.needsConflictChoice
        ? <Button variant="secondary" size="sm" icon={RefreshCw} disabled={busy || working} onClick={() => syncMa2Once(refreshItem)}>重新核对当前节目</Button> : null}
      {refreshItem && selectedSong?.itemId === refreshItem && selectedSong.state === 'blocked' && selectedSong.selectorTrackRepair &&
        <Button variant="secondary" size="sm" disabled={busy || working || syncGate.kind === 'wait'} title="写入前备份这条时间线，关闭该轨的播放后读回核对" onClick={() => void run(() => muteMa2SelectorTrack(selectedSong))}>关闭 Timecode {selectedSong.selectorTrackRepair.target.timecode} 第 {selectedSong.selectorTrackRepair.target.track} 轨的播放</Button>}
      {once !== null ? <Button variant="secondary" size="sm" icon={CircleStop} onClick={() => { setNotice(''); pauseMa2RealtimeSession(); }}>停止同步</Button> : null}
      {refreshItem ? <Button variant="ghost" size="sm" onClick={() => setRefreshItem(null)}>查看全工程</Button> : null}
      {recoveryError ? <p role="alert">{recoveryError}</p> : null}
      {archivingOff ? <p>已关闭存档，写入前不再备份。</p> : null}
      <p>同步方式：{WRITE_LABEL[writeMode]} · {CHANGES_LABEL[consoleChanges]}</p>
      {notice ? <p role="status">{notice}</p> : null}
      {refreshItem && !targetIds.has(refreshItem) && !unlinked.length ? <p>这个节目还没有控台时间线。</p> : null}
      {timelineRead || readingMaterials ? <p>{timelineRead ?? '正在读取灯光素材'}</p> : null}
      {session.status === 'blocked' ? <p role="alert">{session.message}</p> : manual ? null
        : session.status === 'waiting' || !songs.length ? <p>{session.message}</p> : null}
      {unsettled.map(song => <UnsettledSong key={song.itemId} song={song} title={project.rundown.find(item => item.id === song.itemId)?.title ?? song.name}
        stopped={song.state === 'blocked' && !song.needsSourceCheck && imported(song.itemId)} disabled={busy || working || syncGate.kind === 'wait'} busy={busy} choose={side => run(async () => setNotice(side === 'console' ? await takeMa2SongFromConsole(song.itemId) : writeMa2SongFromSoftware(song.itemId)))} />)}
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
  </section>;
}
