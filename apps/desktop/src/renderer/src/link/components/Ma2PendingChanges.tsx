import { useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { pauseMa2RealtimeSession, pendingSongSummary, refreshMa2RealtimeSession, retryMa2RealtimeSession, songsWithoutConsoleShow, writeMissingConsoleShows } from '../runtime/ma2-realtime-session';
import { useCallback, useMemo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, FolderArchive, FolderOpen, RefreshCw, Save } from 'lucide-react';
import type { ProjectArchiveResult } from '@tb/schema';
import { ma2PendingChanges } from '@tb/core/link';
import { enableMa2NameSync } from '../runtime/ma2-name-sync';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { pendingMa2Renames, ma2RenameKey } from '@tb/core/link';
import { useRecoveryCopyStore } from '../recovery-copy-writer';
import { confirmReplaceDocument, saveDocument } from '../project-document';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from '../runtime/ma2-legacy-names';
import { Button, Dialog, Popover, Switch } from '../ui';
import './lighting-sync.css';

export function Ma2PendingChanges({ playing, notify }: { playing: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const pending = useMemo(() => ma2PendingChanges(project), [project]);
  const unbound = useMemo(() => pendingSongSummary(project), [project]);
  const showless = useMemo(() => songsWithoutConsoleShow(project), [project]);
  const renames = useMemo(() => pendingMa2Renames(project), [project]);
  const legacy = useMemo(() => legacyMa2ConsoleNames(project), [project]);
  const session = useMa2SyncStore(state => state.session);
  const names = useMa2SyncStore(state => state.names);
  const active = useMa2RealtimePreference(state => state.enabled);
  const recoveryError = useRecoveryCopyStore(state => state.error);
  const songSync = useMa2SyncStore(state => state.songs);
  const songs = Object.values(songSync);
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<ProjectArchiveResult['entries']>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [archivingOff, setArchivingOff] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [statusAnchor, setStatusAnchor] = useState<HTMLButtonElement | null>(null);
  const closeDetails = useCallback(() => setDetailOpen(false), []);
  if (!project) return null;
  const working = names.state === 'syncing' || songs.some(song => song.state === 'syncing' || song.requestId);
  // One count per song, either way it was lit; edits of a song whose sync has not started yet count once too.
  const jobs = new Set(songs.map(song => song.itemId));
  const count = unbound.length + renames.length + showless.length + songs.filter(song => song.state === 'pending' && !unbound.some(item => item.itemId === song.itemId)).length
    + new Set(pending.filter(change => !jobs.has(change.itemId)).map(change => change.itemId)).size;
  const failed = names.state === 'blocked' || songs.some(song => song.state === 'blocked');
  const blocked = session.status === 'blocked' || failed;
  const moving = songs.find(song => song.requestId && song.progress?.total);
  const confirmed = songs.length ? songs.every(song => song.state === 'verified') : names.state === 'verified';
  const status = recoveryError ? '恢复副本需要处理' : !active ? '已暂停同步' : failed ? '同步失败' : blocked ? '控台需要核对' : moving?.progress ? `同步中 ${Math.floor(moving.progress.completed / moving.progress.total * 100)}%` : working ? '同步中' : songs.some(song => song.waitingForConnection) ? '等待连接' : count ? `待同步 ${count}` : confirmed ? '已同步' : '同步已开启';
  const state = blocked ? 'blocked' : working ? 'writing' : count ? 'staged' : confirmed ? 'verified' : 'waiting';
  const run = async (action: () => Promise<void> | void): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setNotice(message); setDetailOpen(true); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const toggle = (): void => {
    setNotice('');
    if (active) pauseMa2RealtimeSession();
    else retryMa2RealtimeSession();
  };
  const save = async (): Promise<void> => {
    const state = useDocumentStore.getState();
    if (!state.project) return;
    const outcome = await saveDocument();
    if (outcome.status === 'failed') throw new Error(outcome.message);
    if (outcome.status === 'canceled') return;
    const archived = await archiveMa2Project(state.documentId, state.project, 'manual');
    setNotice(`本地已保存并存档：${archived ?? ''}`); notify('本地已保存并创建存档');
  };
  const loadArchives = async (): Promise<void> => {
    const path = useDocumentStore.getState().path;
    if (!path) throw new Error('请先保存工程');
    const result = await linkDesktopViewModel.projectArchives({ version: 1, action: 'list', projectPath: path });
    setArchives(result.entries); setArchiveOpen(true); setDetailOpen(false);
  };
  const restore = async (name: string): Promise<void> => {
    const state = useDocumentStore.getState();
    if (!state.path || !state.project) throw new Error('请先保存工程');
    if (playing) throw new Error('播放中不能恢复存档，请停止后再恢复');
    // 保存 puts the latest edits into the "恢复前" archive the restore makes; 不保存 drops them.
    const replaced = await confirmReplaceDocument('restore-archive');
    if (!replaced) return;
    const projectPath = useDocumentStore.getState().path;
    if (!projectPath) throw new Error('请先保存工程');
    await linkDesktopViewModel.projectArchives({ version: 1, action: 'restore', projectPath, name });
    const reopened = await linkDesktopViewModel.openProject(projectPath);
    useDocumentStore.getState().setProject(reopened.project, reopened.path, { upgraded: reopened.upgraded });
    await replaced();
    setConfirmRestore(null); setArchiveOpen(false); notify('已恢复存档；恢复前的工程另存为“恢复前”存档');
  };
  const reveal = async (name?: string): Promise<void> => {
    const path = useDocumentStore.getState().path;
    if (!path) throw new Error('请先保存工程');
    await linkDesktopViewModel.projectArchives({ version: 1, action: 'reveal', projectPath: path, ...(name ? { name } : {}) });
  };
  const openDetails = (): void => {
    if (!detailOpen) void linkDesktopViewModel.projectArchiveSettings({ action: 'status' }).then(value => setArchivingOff(!value.settings.enabled), (error: unknown) => setNotice(`存档设置读取失败：${error instanceof Error ? error.message : String(error)}`));
    setDetailOpen(value => !value); setArchiveOpen(false);
  };
  return <section className="lighting-sync" aria-label="灯光同步操作">
    <header className="lighting-sync-heading">
      <h2>控台同步</h2>
      <Switch className="lighting-sync-switch" label="实时同步" aria-label="实时同步" aria-checked={active} checked={active} disabled={busy || (working && !active)}
        title="编辑完成后自动检查、存档、写入控台并确认；播放时先暂存，停止后再同步" onChange={() => void run(toggle)} />
    </header>
    <Button ref={setStatusAnchor} variant="ghost" className="lighting-sync-status" icon={blocked || count ? CircleAlert : Check} aria-label="同步状态详情" aria-expanded={detailOpen} aria-haspopup="dialog" data-state={state} onClick={openDetails}>
      <span>{status}</span><ChevronRight aria-hidden="true" />
    </Button>
    <div className="lighting-sync-actions">
      <Button variant="secondary" size="sm" icon={RefreshCw} title="立即读取控台，把和时间线不一致的地方写回控台（包括在控台上删掉的 Cue 或序列）；如果同步已暂停，会重新打开" onClick={() => { setNotice(''); refreshMa2RealtimeSession(); }}>刷新同步</Button>
      <Button variant="secondary" size="sm" icon={Save} disabled={busy} title="保存工程并创建存档" onClick={() => void run(save)}>保存</Button>
      <Button variant="secondary" size="sm" icon={FolderArchive} disabled={busy} title="查看和恢复存档" onClick={() => archiveOpen ? setArchiveOpen(false) : void run(loadArchives)}>存档</Button>
    </div>
    {detailOpen ? <Popover anchor={statusAnchor} placement="right-end" label="同步状态详情" className="lighting-sync-details" onClose={closeDetails}>
      <h3>{status}</h3>
      {recoveryError ? <p role="alert">{recoveryError}</p> : null}
      {archivingOff ? <p>已关闭存档，写入前不再备份。</p> : null}
      <p role={session.status === 'blocked' ? 'alert' : 'status'}>{notice || (!active ? '已暂停，修改保留在本地。' : !useDocumentStore.getState().path ? '请先保存工程，保存后自动同步。' : session.status !== 'ready' || !songs.length ? session.message : '名称和 Cue 内容会双向比对，控台位置如下。')}</p>
      {songs.map(song => <p key={song.itemId} role={song.state === 'blocked' ? 'alert' : 'status'}>{project.rundown.find(item => item.id === song.itemId)?.title ?? song.name}：{song.progress?.detail ?? song.message}</p>)}
      {playing ? <p>播放时先暂存在本地，停止后再同步。</p> : null}
      {names.state !== 'idle' && names.message ? <p role={names.state === 'blocked' ? 'alert' : 'status'}>改名：{names.message}</p> : null}
      {renames.map(change => <p key={ma2RenameKey(change)}>序列 {change.sequence}{change.kind === 'single' ? ` · Cue ${change.cue}` : ''}：{change.confirmedName} → {change.name}</p>)}
      {renames.length ? <Button variant="secondary" size="sm" disabled={busy || working} onClick={() => void run(() => enableMa2NameSync(useDocumentStore.getState().documentId))}>同步名称</Button> : null}
      {legacy.count ? <><p>控台上有 {legacy.count} 个以前写入的中文名称，控台只能显示英文和数字。</p><Button variant="secondary" size="sm" disabled={busy || working} onClick={() => void run(async () => { const count = await convertMa2LegacyNames(useDocumentStore.getState().documentId); setNotice(`已把 ${count} 个名称改成拼音，歌曲名称会在下次同步时写入`); })}>改为拼音</Button></> : null}
      {pending.map(item => <p key={`${item.itemId}:${item.bindingId}`}>{item.title} · Timecode {item.target}：{item.error ?? `${item.changes.length} 处修改`}</p>)}
      {unbound.map(item => <p key={item.itemId}>{item.title} · {item.count} 个 Cue → 按钮第 {item.page} 页的空格。</p>)}
      {showless.length ? <><p>有 {showless.length} 首歌要同步到控台才能演出：{showless.map(item => item.title).join('、')}。同步会为每首歌在控台上建立自己的时间码节目。</p><Button variant="secondary" size="sm" disabled={busy || working} onClick={() => { setNotice(''); writeMissingConsoleShows(); }}>同步到控台</Button></> : null}
    </Popover> : null}
    {archiveOpen ? <Dialog title="灯光工程存档" description="保存整个工程和原始 XML，同步前会自动存一份。恢复时写回原工程位置，恢复前的工程也会另存一份。" onClose={() => setArchiveOpen(false)}
      actions={<Button variant="secondary" icon={FolderOpen} onClick={() => void run(() => reveal())}>打开存档位置</Button>}>
      {!archives.length ? <p>还没有存档，点“保存”创建。</p> : <ul className="lighting-sync-archives">{archives.slice(0, 100).map(entry => <li key={entry.name}>
        <span>{new Date(entry.createdAt).toLocaleString()} · {entry.reason === 'manual' ? '手动保存' : '同步前'}</span>
        <Button variant="ghost" size="sm" aria-label={`定位存档 ${entry.name}`} onClick={() => void run(() => reveal(entry.name))}>定位文件</Button>
        {confirmRestore === entry.name
          ? <Button variant="danger" size="sm" aria-label={`确认恢复存档 ${entry.name}`} disabled={busy || playing} onClick={() => void run(() => restore(entry.name))}>确认恢复</Button>
          : <Button variant="secondary" size="sm" aria-label={`恢复存档 ${entry.name}`} disabled={busy || playing} onClick={() => setConfirmRestore(entry.name)}>恢复</Button>}
      </li>)}</ul>}
    </Dialog> : null}
  </section>;
}
