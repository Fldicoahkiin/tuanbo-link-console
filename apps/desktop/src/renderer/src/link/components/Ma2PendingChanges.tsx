import { useMemo, useState } from 'react';
import { Check, CircleAlert, FolderArchive, FolderOpen, Pause, RefreshCw, Save, Undo2, Redo2 } from 'lucide-react';
import type { ProjectArchiveResult } from '@tb/schema';
import { ma2PendingChanges } from '../runtime/ma2-pending-changes';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
import { useDocumentStore } from '../stores/document-store';
import { ma2MaterialConnection } from '../stores/ma2-material-read-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function Ma2PendingChanges({ playing, notify }: { playing: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const project = useDocumentStore(state => state.project);
  const canUndo = useDocumentStore(state => state.past.length > 0);
  const canRedo = useDocumentStore(state => state.future.length > 0);
  const pending = useMemo(() => ma2PendingChanges(project), [project]);
  const automatic = useMa2AutoSyncStore();
  const [busy, setBusy] = useState(false);
  const [archives, setArchives] = useState<ProjectArchiveResult['entries']>([]);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [notice, setNotice] = useState('');
  if (!project) return null;
  const bound = project.rundown.some(item => item.lighting?.ma2Bindings?.length);
  const active = Boolean(automatic.request) && automatic.status !== 'blocked';
  const working = automatic.status === 'writing' || automatic.status === 'reading';
  const status = automatic.status === 'blocked' ? '同步中断' : working ? '同步中' : pending.length ? `待同步 ${pending.length}` : active ? '同步开启' : '仅本地';
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try { await action(); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); setNotice(message); setDetailOpen(true); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const toggle = async (): Promise<void> => {
    if (active) { useMa2AutoSyncStore.setState({ request: null }); return; }
    const state = useDocumentStore.getState();
    const cache = state.project?.ma2ReadState;
    if (!cache || !state.path) throw new Error('请先保存工程并读取控台');
    if (cache.catalog.incomplete || cache.catalog.sourceUnverified) throw new Error('读取结果尚未核对完整，请先更新控台读取');
    const connection = await ma2MaterialConnection();
    if (useDocumentStore.getState().documentId !== state.documentId) throw new Error('工程已切换');
    const source = connection.network ? `${connection.network.host}:${connection.network.port}` : '本机 onPC';
    if (source !== cache.source) throw new Error('当前连接与工程读取来源不同，请先核对控台');
    setNotice('');
    useMa2AutoSyncStore.setState({ request: { connection, catalog: cache.catalog } });
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
    <button disabled={busy || working || !bound} aria-pressed={active} onClick={() => void run(toggle)} title="启用后，停止播放时的修改自动核对、存档、写回；播放中的修改暂存本地">{active ? <Pause /> : <RefreshCw />}<span>{active ? '暂停同步' : '开始同步'}</span></button>
    <button aria-label="同步状态详情" data-state={automatic.status} onClick={() => { setDetailOpen(value => !value); setArchiveOpen(false); }}>{automatic.status === 'blocked' || pending.length ? <CircleAlert /> : <Check />}<span>{status}</span></button>
    <button aria-label="撤销灯光修改" title="撤销上一次工程编辑；启用同步后会将撤销结果写回控台" disabled={busy || working || !canUndo} onClick={() => useDocumentStore.getState().undo()}><Undo2 /></button>
    <button aria-label="重做灯光修改" title="重做上一次撤销" disabled={busy || working || !canRedo} onClick={() => useDocumentStore.getState().redo()}><Redo2 /></button>
    <button disabled={busy || working} title="保存工程并创建存档" onClick={() => void run(save)}><Save /><span>保存</span></button>
    <button disabled={busy} onClick={() => archiveOpen ? setArchiveOpen(false) : void run(loadArchives)}><FolderArchive /><span>存档</span></button>
    {detailOpen ? <div className="ma2-sync-popover" role="region" aria-label="同步状态详情">
      <header><strong>{status}</strong><button onClick={() => setDetailOpen(false)}>关闭</button></header>
      <p role={automatic.status === 'blocked' ? 'alert' : 'status'}>{notice || automatic.message}</p>
      {playing ? <p>播放中暂存本地，停止后同步。</p> : null}
      {pending.map(item => <p key={`${item.itemId}:${item.bindingId}`}>{item.title} · Timecode {item.target}：{item.error ?? `${item.changes.length} 处修改`}</p>)}
    </div> : null}
    {archiveOpen ? <div className="ma2-sync-popover" role="region" aria-label="灯光工程存档">
      <header><strong>工程存档 · {archives.length}</strong><button onClick={() => setArchiveOpen(false)}>关闭</button></header>
      <p>保存整个工程及原始 XML；同步前自动存一份。存档与工程同目录，共用原素材。</p>
      <button onClick={() => void run(() => reveal())}><FolderOpen />打开存档位置</button>
      {!archives.length ? <p>暂无存档，点击“保存”创建。</p> : <ul>{archives.slice(0,100).map(entry => <li key={entry.name}><span>{new Date(entry.createdAt).toLocaleString()} · {entry.reason === 'manual' ? '手动保存' : '同步前'}</span><button aria-label={`定位存档 ${entry.name}`} onClick={() => void run(() => reveal(entry.name))}>定位文件</button></li>)}</ul>}
    </div> : null}
  </div>;
}
