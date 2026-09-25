import { Button } from './Button';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { ma2CatalogSchema, ma2NetworkStatusSchema, ma2TimecodePreviewSchema, type Ma2Catalog, type Ma2CatalogRequest, type Ma2ReadProgress as Ma2ReadProgressState, type Ma2TimecodePreview } from '@tb/schema';
import { Ma2ReadProgress } from './Ma2ReadProgress';
import { importMa2ProgramsCommand, matchMa2Programs } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useSelectedProgram } from '../useSelectedProgram';
import { Ma2ProgramSync } from './Ma2ProgramSync';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { P1LightingImportReport } from './P1LightingImportReport';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';

function cancelCatalogRead(epoch: MutableRefObject<number>, activeRead: MutableRefObject<string | null>, notify: (message: string, tone?: 'info' | 'error') => void): void {
  epoch.current += 1;
  const id = activeRead.current;
  if (id) void window.tbLink.cancelMa2Read(id).catch(error => notify(String(error), 'error'));
}

export function Ma2CatalogSettings({ method, directory, disabled, notify, onBusy }: { onBusy: (busy: boolean) => void; method: 'local' | 'network'; directory: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const automatic = useMa2AutoSyncStore();
  const documentId = useDocumentStore(state => state.documentId);
  const [itemId, selectItem] = useSelectedProgram(notify);
  const [catalog, setCatalog] = useState<Ma2Catalog | null>(null);
  const [connection, setConnection] = useState<Ma2CatalogRequest | null>(null);
  const [busy, setWorking] = useState(false);
  const setBusy = (value: boolean): void => { setWorking(value); onBusy(value); };
  const [message, setMessage] = useState('连接控台后扫描当前 Show 的全部时间线。');
  const [progress, setProgress] = useState<Ma2ReadProgressState | null>(null);
  const activeRead = useRef<string | null>(null);
  const [pairs, setPairs] = useState<Record<number, string>>({});
  const [target, setTarget] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const alive = useRef(true);
  const epoch = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current += 1; if (activeRead.current) void window.tbLink.cancelMa2Read(activeRead.current).catch(error => console.error(error)); }; }, []);
  useEffect(() => { epoch.current += 1; if (activeRead.current) void window.tbLink.cancelMa2Read(activeRead.current).catch(error => console.error(error)); setCatalog(null); setConnection(null); setPairs({}); setTarget(null); }, [method, directory, documentId]);
  const endpoint = async (): Promise<Ma2CatalogRequest> => {
    if (method === 'local') {
      if (!directory.trim()) throw new Error('请先填写并连接本机 onPC 数据目录');
      return { dataDirectory: directory.trim() };
    }
    const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (status.state !== 'connected' || !status.settings) throw new Error('请先连接实体控台');
    const { host, port, monitorPort, username } = status.settings;
    return { dataDirectory: '', network: { host, port, monitorPort, username } };
  };
  const readWithProgress = async (source: Ma2CatalogRequest, run: number): Promise<Ma2Catalog> => {
    const id = crypto.randomUUID(); activeRead.current = id; setProgress(null);
    try { return ma2CatalogSchema.parse(await window.tbLink.readMa2Catalog({ ...source, progressId: id }, update => { if (alive.current && epoch.current === run && activeRead.current === id) setProgress(update); })); }
    finally { if (activeRead.current === id) activeRead.current = null; }
  };
  const scan = async (): Promise<void> => {
    if (busy || disabled) return;
    const run = ++epoch.current;
    setBusy(true); setProgress(null); setCatalog(null); setTarget(null); setPairs({}); setMessage('正在只读扫描时间线与 Cue 引用…');
    try {
      const source = await endpoint();
      if (!alive.current || epoch.current !== run) return;
      const result = await readWithProgress(source, run);
      if (!alive.current || epoch.current !== run) return;
      setConnection(source); setCatalog(result); setPage(0);
      const currentProject = useDocumentStore.getState().project;
      if (currentProject) setPairs(matchMa2Programs(currentProject, result).pairs);
      const errors = result.entries.filter(entry => entry.error).length;
      setMessage(`${result.entries.length} 条时间线 · ${result.entries.filter(entry => (entry.eventCount ?? 0) > 0).length} 条已录制 · ${errors} 条读取异常`);
    } catch (error) { if (alive.current && epoch.current === run) { setMessage('扫描未完成'); notify(String(error), 'error'); } }
    finally { activeRead.current = null; if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const importPairs = async (): Promise<void> => {
    if (disabled || busy || !catalog || !connection) return;
    const selected = Object.entries(pairs).filter(([, id]) => id);
    if (!selected.length) return;
    const run = ++epoch.current;
    const before = useDocumentStore.getState();
    setBusy(true); setMessage('正在重新核对控台并读取已配对灯光…');
    try {
      if (JSON.stringify(await endpoint()) !== JSON.stringify(connection)) throw new Error('控台连接已变化，请重新扫描');
      const current = await readWithProgress(connection, run);
      if (JSON.stringify(current.directory) !== JSON.stringify(catalog.directory)) throw new Error('Show 或时间线目录已变化，请重新扫描');
      const selections: { itemId: string; preview: Ma2TimecodePreview }[] = [];
      if (selected.length) setProgress({ id: crypto.randomUUID(), phase: 'previews', completed: 0, total: selected.length, detail: '读取已配对时间线' });
      for (const [number, id] of selected) {
        if (!alive.current || epoch.current !== run) throw new Error('导入会话已改变');
        const entry = current.entries.find(value => value.target === Number(number));
        if (!entry || entry.error) throw new Error(entry?.error ?? '所选时间线已不存在');
        selections.push({ itemId: id, preview: ma2TimecodePreviewSchema.parse(await window.tbLink.previewMa2({ ...connection, target: Number(number) })) });
        setProgress({ id: crypto.randomUUID(), phase: 'previews', completed: selections.length, total: selected.length, detail: `已读取 Timecode ${number}` });
      }
      if (!alive.current || epoch.current !== run || useDocumentStore.getState().project !== before.project) throw new Error('读取期间工程已变化，请重新导入');
      useDocumentStore.getState().executeForDocument(before.documentId, importMa2ProgramsCommand(selections));
      setPairs({}); setMessage(`已导入 ${selections.length} 条灯光时间线，可一次撤销；现场原始时间码未重新分配。`);
    } catch (error) { if (alive.current) { setMessage('导入未完成，工程未应用本次批量导入'); notify(String(error), 'error'); } }
    finally { if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const exportSite = async (): Promise<void> => {
    if (busy || disabled || !catalog || !connection) return;
    const run = ++epoch.current;
    setBusy(true); setMessage('正在收集原始时间线核对数据…'); setProgress({ id: crypto.randomUUID(), phase: 'raw', completed: 0, total: catalog.entries.length, detail: '收集原始时间线' });
    try {
      if (JSON.stringify(await endpoint()) !== JSON.stringify(connection)) throw new Error('控台连接已变化，请重新扫描');
      const raw: { target: number; xml: string }[] = [];
      let size = 0;
      for (const entry of catalog.entries) {
        if (!alive.current || epoch.current !== run) throw new Error('核对包导出会话已改变');
        const xml = await window.tbLink.exchangeMa2({ ...connection, target: entry.target, operation: 'READ', expected: '', desired: '' });
        size += new TextEncoder().encode(xml).length;
        if (size > 32 * 1024 * 1024) throw new Error('原始时间线超过 32 MB，核对包未导出');
        raw.push({ target: entry.target, xml });
        setProgress({ id: crypto.randomUUID(), phase: 'raw', completed: raw.length, total: catalog.entries.length, detail: `已读取 Timecode ${entry.target}` });
      }
      const current = await readWithProgress(connection, run);
      if (JSON.stringify(current.directory) !== JSON.stringify(catalog.directory)) throw new Error('Show 或目录已变化，请重新扫描');
      if (!alive.current || epoch.current !== run) throw new Error('核对包导出会话已改变');
      const path = await window.tbLink.exportDiagnosticPackage({ ma2Site: { catalog: current, raw, songs: project?.rundown.map(item => ({ id: item.id, title: item.title, p1Media: item.p1Media, referenceAudio: item.referenceAudio })) ?? [] } });
      if (alive.current) setMessage(path ? `现场核对包已导出：${path}（不含音频文件）` : '已取消导出核对包');
    } catch (error) { if (alive.current) { setMessage('现场核对包未完成'); notify(String(error), 'error'); } }
    finally { if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const importCurrent = async (): Promise<void> => {
    const before = useDocumentStore.getState();
    if (!before.project) throw new Error('P1 音频尚未导入');
    const run = ++epoch.current;
    setBusy(true); setProgress(null);
    try {
      const source = await endpoint();
      const result = await readWithProgress(source, run);
      if (!alive.current || epoch.current !== run || useDocumentStore.getState().documentId !== before.documentId) throw new Error('工程已切换或已取消，灯光未导入');
      setCatalog(result); setConnection(source); setPage(0);
      const matched = matchMa2Programs(before.project, result);
      setPairs(matched.pairs);
      const selections: { itemId: string; preview: Ma2TimecodePreview }[] = [];
      const matches = Object.entries(matched.pairs);
      if (matches.length) setProgress({ id: crypto.randomUUID(), phase: 'previews', completed: 0, total: matches.length, detail: '读取已配对时间线' });
      for (const [target, itemId] of matches) {
        if (!alive.current || epoch.current !== run) throw new Error('已取消读取，灯光未导入');
        selections.push({ itemId, preview: ma2TimecodePreviewSchema.parse(await window.tbLink.previewMa2({ ...source, target: Number(target) })) });
        if (!alive.current || epoch.current !== run) throw new Error('已取消读取，灯光未导入');
        setProgress({ id: crypto.randomUUID(), phase: 'previews', completed: selections.length, total: matches.length, detail: `已读取 Timecode ${target}` });
      }
      const checked = await readWithProgress(source, run);
      if (JSON.stringify(checked.directory) !== JSON.stringify(result.directory) || useDocumentStore.getState().project !== before.project || !alive.current || epoch.current !== run) throw new Error('读取期间工程或 Show 已变化，或已取消读取；灯光未导入');
      if (selections.length) useDocumentStore.getState().executeForDocument(before.documentId, importMa2ProgramsCommand(selections));
      setPairs({}); setMessage(`音频读取完成，${selections.length} 条灯光已导入，${matched.unresolved.length} 条需核对配对；已绑定节目保留原有修改，请使用双向同步更新。`);
    } catch (error) { setMessage('音频已读取，灯光导入未完成'); throw error; }
    finally { if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const rows = catalog?.entries.filter(entry => (entry.error || entry.eventCount !== 0) && `${entry.target} ${entry.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? [];
  return <section className="settings-section ma2-catalog-settings" aria-label="MA2 现场节目导入"><section className="ma2-settings-group">
    <h3>导入 P1 音乐与灯光</h3>
    <p className="settings-note">选择 P1 工程，读取音乐并配对当前 Show 中的灯光。</p><details className="ma2-operation-help"><summary>操作说明</summary><p>导入后使用本软件播放，编辑器切换歌曲即可查看对应 Cue。同名、重叠区间或跨歌时间线会明确列出，需要核对配对。</p></details>
    <P1ProjectSyncPanel purpose="migration" disabled={disabled || busy} notify={notify} afterImport={importCurrent} />
    {busy ? <><Ma2ReadProgress progress={progress} waiting="正在读取控台时间线" /><Button className="secondary-button" onClick={() => { cancelCatalogRead(epoch, activeRead, notify); setMessage('正在取消控台读取…'); }}>取消控台读取</Button></> : <p role="status">{message}</p>}
    {project && catalog ? <P1LightingImportReport project={project} catalog={catalog} /> : null}
    </section><details className="ma2-advanced-settings"><summary>手动核对时间线与双向同步</summary><section className="ma2-settings-group"><h3>扫描与配对控台时间线</h3>
    <div className="device-actions"><Button className="primary-button" disabled={disabled || busy} onClick={() => void scan()}>扫描控台全部时间线</Button><Button className="secondary-button" disabled={disabled || busy || !Object.values(pairs).some(Boolean)} onClick={() => void importPairs()}>导入已配对灯光</Button></div>
    {catalog ? <Button className="secondary-button" disabled={disabled || busy} onClick={() => void exportSite()}>导出现场核对包</Button> : null}
    {catalog ? <><p className="settings-note">Show：{catalog.directory.show} · {catalog.directory.version} · {new Date(catalog.readAt).toLocaleString()}</p>
      <label className="settings-row">筛选时间线<input aria-label="筛选控台时间线" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="Timecode 编号或名称" /></label>
      {rows.slice(page * 25, (page + 1) * 25).map(entry => <details key={entry.target}>
        <summary>Timecode {entry.target} · {entry.name} · {entry.eventCount ?? '未知'} 个事件{entry.error ? ' · 读取异常' : ''}</summary>
        <p>{entry.frameFormat ?? '帧率未知'} · 偏移 {entry.offset ?? '未知'} · {entry.slot ?? '时间码槽未知'}</p>
        {entry.error ? <p role="alert">{entry.error}</p> : null}
        {entry.warnings.map(warning => <p key={warning}>{warning}</p>)}
        <label>对应歌曲<select aria-label={`Timecode ${entry.target} 对应歌曲`} value={pairs[entry.target] ?? ''} disabled={disabled || busy} onChange={event => setPairs({ ...pairs, [entry.target]: event.target.value })}><option value="">请核对并选择歌曲</option>{project?.rundown.map(item => <option key={item.id} value={item.id} disabled={item.lighting?.ma2Bindings?.some(binding => binding.timecode === entry.target)}>{item.title}{item.p1Media ? ` · P1 起始 ${item.p1Media.midiStartTime}` : ''}{item.lighting?.ma2Bindings?.some(binding => binding.timecode === entry.target) ? ' · 已关联' : ''}</option>)}</select></label>
        <Button className="secondary-button" disabled={disabled || busy || !project?.rundown.length} onClick={() => { const paired = pairs[entry.target]; if (paired) selectItem(paired); setTarget(entry.target); }}>查看与同步此时间线</Button>
        <div className="ma2-read-preview"><table><thead><tr><th>原始时间</th><th>执行器</th><th>序列 / Cue</th><th>动作 / 名称</th></tr></thead><tbody>{entry.events.slice(0, 100).map(event => <tr key={event.path}><td title={event.time}>{event.time}</td><td title={event.executor}>{event.executor}</td><td title={event.cue ?? '无 Cue 引用'}>{event.cue ?? '无 Cue 引用'}</td><td title={`${event.action} · ${event.name ?? ''}`}>{event.action} · {event.name}</td></tr>)}</tbody></table></div>
        {entry.events.length > 100 ? <p>此处预览前 100 个事件；完整数据已扫描，进入时间线后查看全部。</p> : null}
      </details>)}
      {rows.length > 25 ? <div className="device-actions"><button disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(rows.length / 25)}</span><button disabled={(page + 1) * 25 >= rows.length || busy} onClick={() => setPage(page + 1)}>下一页</button></div> : null}
    </> : null}
    {target && connection ? <><label>同步目标歌曲<select aria-label="控台同步目标歌曲" value={itemId ?? ''} disabled={busy || disabled} onChange={event => selectItem(event.target.value)}>{project?.rundown.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><Ma2ProgramSync key={`${target}:${itemId}`} initialTarget={target} method={method} directory={connection.dataDirectory} network={connection.network ?? null} disabled={disabled || busy} notify={notify} onBusy={setBusy} /></> : null}
  </section><section className="ma2-settings-group"><h3>自动双向同步</h3>
    <div className="device-actions"><Button className="secondary-button" disabled={!automatic.request && (disabled || busy || !catalog || !connection)} onClick={() => useMa2AutoSyncStore.setState({ request: automatic.request ? null : catalog && connection ? { catalog, connection } : null })}>{automatic.request ? '关闭自动双向同步' : '启用编辑后自动双向同步'}</Button><span role="status">{automatic.message}</span></div>
    <p className="settings-note">开启后在停止播放时自动比较已绑定节目与控台，连续编辑结束后同步；冲突或通信失败会停止，需要手动处理后重新启用。关闭设置页后继续工作。</p>
</section></details></section>;
}
