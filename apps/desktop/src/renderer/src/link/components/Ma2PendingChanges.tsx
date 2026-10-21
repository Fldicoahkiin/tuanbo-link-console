import { useMa2SongSyncStore } from '../runtime/ma2-song-sync';
import { useMa2RealtimePreference } from '../runtime/ma2-realtime-preference';
import { pauseMa2RealtimeSession, pendingSongSummary, retryMa2RealtimeSession } from '../runtime/ma2-realtime-session';
import { useMemo, useState } from 'react';
import { Check, CircleAlert, FolderArchive, FolderOpen, Save, Undo2, Redo2 } from 'lucide-react';
import type { ProjectArchiveResult } from '@tb/schema';
import { ma2PendingChanges } from '../runtime/ma2-pending-changes';
import { enableMa2NameSync, useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { useDocumentStore } from '../stores/document-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { pendingMa2Renames, ma2RenameKey } from '@tb/core/link';
import { useMa2LocalSaveStore } from '../runtime/ma2-local-save';
import { Ma2SongConflicts } from './Ma2SongConflicts';
import { convertMa2LegacyNames, legacyMa2ConsoleNames } from '../runtime/ma2-legacy-names';

export function Ma2PendingChanges({ playing, notify }: { playing: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const canUndo = useDocumentStore(state => state.past.length > 0);
  const canRedo = useDocumentStore(state => state.future.length > 0);
  const pending = useMemo(() => ma2PendingChanges(project), [project]);
  const unbound = useMemo(() => pendingSongSummary(project), [project]);
  const renames = useMemo(() => pendingMa2Renames(project), [project]);
  const legacy = useMemo(() => legacyMa2ConsoleNames(project), [project]);
  const automatic = useMa2AutoSyncStore();
  const active = useMa2RealtimePreference(state => state.enabled);
  const localSaveError = useMa2LocalSaveStore(state => state.error);
  const songSync = useMa2SongSyncStore(state => state.songs);
  const songs = Object.values(songSync);
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<ProjectArchiveResult['entries']>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notice, setNotice] = useState('');
  if (!project) return null;
  const working = automatic.status === 'writing' || automatic.status === 'reading' || songs.some(song => song.state === 'syncing' || song.requestId);
  const count = pending.length + unbound.length + renames.length + songs.filter(song => song.state === 'pending' && !unbound.some(item => item.itemId === song.itemId)).length;
  const blocked = automatic.status === 'blocked' || songs.some(song => song.state === 'blocked');
  const status = localSaveError ? '本地保存需处理' : !active ? '已暂停同步' : blocked ? '有修改待核对' : working ? '同步中' : songs.some(song => song.waitingForConnection) ? '等待连接' : count ? `待同步 ${count}` : songs.length && songs.every(song => song.state === 'verified') ? '已回读确认' : automatic.status === 'verified' ? '已回读确认' : '同步已开启';
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
    const path = await linkDesktopViewModel.saveProject(state.path, state.project);
    if (!path) return;
    useDocumentStore.getState().markSaved(path, state.revision, state.documentId);
    const archived = await archiveMa2Project(state.documentId, state.project, 'manual');
    setNotice(`本地已保存并存档：${archived}`); notify('本地已保存并创建存档');
  };
  const loadArchives = async (): Promise<void> => {
    const path = useDocumentStore.getState().path;
    if (!path) throw new Error('请先保存工程');
    const result = await linkDesktopViewModel.projectArchives({ version: 1, action: 'list', projectPath: path });
    setArchives(result.entries); setArchiveOpen(true); setDetailOpen(false);
  };
  const reveal = async (name?: string): Promise<void> => {
    const path = useDocumentStore.getState().path;
    if (!path) throw new Error('请先保存工程');
    await linkDesktopViewModel.projectArchives({ version: 1, action: 'reveal', projectPath: path, ...(name ? { name } : {}) });
  };
  return <div className="ma2-sync-controls" aria-label="灯光同步操作">
    <button className="ma2-realtime-switch" role="switch" aria-label="实时同步" aria-checked={active} disabled={busy || (working && !active)} onClick={() => void run(toggle)} title="编辑结束后自动核对、存档、写回并确认；播放中暂存，停止后同步"><span className="ma2-switch-track" aria-hidden="true"><span /></span><span>实时同步</span></button>
    <button aria-label="同步状态详情" data-state={blocked ? 'blocked' : automatic.status} onClick={() => { setDetailOpen(value => !value); setArchiveOpen(false); }}>{blocked || count ? <CircleAlert /> : <Check />}<span>{status}</span></button>
    <button aria-label="撤销灯光修改" title="撤销上一次工程编辑；启用同步后会将撤销结果写回控台" disabled={!canUndo} onClick={() => useDocumentStore.getState().undo()}><Undo2 /></button>
    <button aria-label="重做灯光修改" title="重做上一次撤销" disabled={!canRedo} onClick={() => useDocumentStore.getState().redo()}><Redo2 /></button>
    <button disabled={busy} title="保存工程并创建存档" onClick={() => void run(save)}><Save /><span>保存</span></button>
    <button disabled={busy} onClick={() => archiveOpen ? setArchiveOpen(false) : void run(loadArchives)}><FolderArchive /><span>存档</span></button>
    {detailOpen ? <div className="ma2-sync-popover" role="region" aria-label="同步状态详情">
      <header><strong>{status}</strong><button onClick={() => setDetailOpen(false)}>关闭</button></header>
      {localSaveError ? <p role="alert">{localSaveError}</p> : null}
      <p role={automatic.status === 'blocked' ? 'alert' : 'status'}>{notice || (!active ? '已暂停，修改保留在本地。' : !useDocumentStore.getState().path ? '请先保存工程，保存后自动同步。' : automatic.request || automatic.status === 'blocked' || !songs.length ? automatic.message : '名称与 Cue 内容双向核对，控台位置如下。')}</p>
      {blocked ? <button disabled={busy || working} onClick={() => { setNotice(''); retryMa2RealtimeSession(); }}>重新核对并同步</button> : null}
      {songs.map(song => <section key={song.itemId}><p role={song.state === 'blocked' ? 'alert' : 'status'}>{song.message}</p><Ma2SongConflicts itemId={song.itemId}/></section>)}
      {playing ? <p>播放中暂存本地，停止后同步。</p> : null}
      {renames.map(change => <p key={ma2RenameKey(change)}>序列 {change.sequence}{change.kind === 'single' ? ` · Cue ${change.cue}` : ''}：{change.confirmedName} → {change.name}</p>)}
      {renames.length ? <button disabled={busy || working} onClick={() => void run(() => enableMa2NameSync(useDocumentStore.getState().documentId))}>同步名称</button> : null}
      {legacy.count ? <p>控台上有 {legacy.count} 个以前写入的中文名称，控台只能显示英文和数字。<button disabled={busy || working} onClick={() => void run(async () => { const count = await convertMa2LegacyNames(useDocumentStore.getState().documentId); setNotice(`已提交 ${count} 个名称改为拼音，歌曲名称在下一次同步时写入`); })}>改为拼音</button></p> : null}
      {pending.map(item => <p key={`${item.itemId}:${item.bindingId}`}>{item.title} · Timecode {item.target}：{item.error ?? `${item.changes.length} 处修改`}</p>)}
      {unbound.map(item => <p key={item.itemId}>{item.title} · {item.count} 个 Cue → 按钮第 {item.page} 页的空格。</p>)}
    </div> : null}
    {archiveOpen ? <div className="ma2-sync-popover" role="region" aria-label="灯光工程存档">
      <header><strong>工程存档 · {archives.length}</strong><button onClick={() => setArchiveOpen(false)}>关闭</button></header>
      <p>保存整个工程及原始 XML；同步前自动存一份。存档与工程同目录，共用原素材。</p>
      <button onClick={() => void run(() => reveal())}><FolderOpen />打开存档位置</button>
      {!archives.length ? <p>暂无存档，点击“保存”创建。</p> : <ul>{archives.slice(0,100).map(entry => <li key={entry.name}><span>{new Date(entry.createdAt).toLocaleString()} · {entry.reason === 'manual' ? '手动保存' : '同步前'}</span><button aria-label={`定位存档 ${entry.name}`} onClick={() => void run(() => reveal(entry.name))}>定位文件</button></li>)}</ul>}
    </div> : null}
  </div>;
}
