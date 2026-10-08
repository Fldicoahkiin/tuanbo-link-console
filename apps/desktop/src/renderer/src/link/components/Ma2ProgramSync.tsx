import { Button } from './Button';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ma2NetworkStatusSchema } from '@tb/schema';
import { alignMa2SnapshotToFrames, applyMa2ReadbackCommand, bindMa2TrackCommand, importMa2TimecodeCommand, matchMa2Readback, resolveMa2Readback, resolveMa2Sync, setLightingCommand, type Ma2SyncPreview } from '@tb/core/link';
import { type Ma2NetworkTarget, ma2ExecutorPreviewSchema, type Ma2ExecutorPreview, ma2ApplyResultSchema, ma2TimecodePreviewSchema, ma2SyncPreviewSchema, type LightingDocument, type LightingEvent, type Ma2TimecodePreview } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useSelectedProgram } from '../useSelectedProgram';
import { useLightingDocument } from './useCueWorkspaceSetup';
import { archiveMa2Project } from '../runtime/ma2-project-archive';
type Preview = { result: Ma2TimecodePreview; documentId: number; itemId: string | null };
async function archiveBeforeSync(destination: number, programId: string, source: LightingDocument): Promise<void> {
  const current = useDocumentStore.getState();
  if (current.documentId !== destination || !current.project) throw new Error('工程已切换');
  await archiveMa2Project(destination, current.project);
  const latest = useDocumentStore.getState();
  if (latest.documentId !== destination || latest.project?.rundown.find(entry => entry.id === programId)?.lighting !== source) throw new Error('存档期间工程发生修改，请重新核对');
}
export function Ma2ProgramSync({ disabled, notify, method, network, directory, onBusy, initialTarget = 1 }: { initialTarget?: number; onBusy: (busy: boolean) => void; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; method: 'local' | 'network'; network: Ma2NetworkTarget | null; directory: string }): JSX.Element {
  const [difference, setDifference] = useState<{ result: Ma2SyncPreview; source: LightingDocument; readback: Ma2TimecodePreview; identities: ReadonlyMap<string, string | null> } | null>(null);
  const [conflictChoices, setConflictChoices] = useState<ReadonlyMap<string, 'local' | 'remote'>>(new Map());
  const endpoint = async () => {
    if (method === 'network' && !network) {
      const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
      if (status.state !== 'connected' || !status.settings) throw new Error('请先保存并连接 MA2 控台');
      const { host, port, monitorPort, username } = status.settings; return { dataDirectory: '', network: { host, port, monitorPort, username } };
    }
    if (method === 'local' && !directory.trim()) throw new Error('请在维护页填写本机 onPC 数据目录');
    return method === 'network' && network ? { dataDirectory: '', network } : { dataDirectory: directory.trim() };
  };
  const [target, setTarget] = useState(initialTarget);
  const [busy, setWorking] = useState(false);
  const setBusy = (value: boolean): void => { setWorking(value); onBusy(value); };
  const [status, setStatus] = useState('尚未检查');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [identityChoices, setIdentityChoices] = useState<ReadonlyMap<string, string | null>>(new Map());
  const [page, setPage] = useState(0);
  const [mergePage, setMergePage] = useState(0);
  const project = useDocumentStore((state) => state.project);
  const documentId = useDocumentStore((state) => state.documentId);
  const [itemId] = useSelectedProgram(notify);
  const item = project?.rundown.find((entry) => entry.id === itemId);
  const initialLighting = useLightingDocument(item ?? null);
  useEffect(() => { setPreview(null); setDifference(null); setIdentityChoices(new Map()); setConflictChoices(new Map()); }, [itemId, documentId, method, directory, network]);
  const readPreview = async (): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true); setStatus('正在通信…'); setPreview(null); setPage(0); setIdentityChoices(new Map());
    try {
      const connection = await endpoint();
      if (!Number.isInteger(target) || target < 1 || target > 99999) throw new Error('Timecode 编号应为 1–99999');
      const result = ma2TimecodePreviewSchema.parse(await window.tbLink.previewMa2({ ...connection, target, timeOriginMs: item?.lighting?.ma2Bindings?.find(entry => entry.timecode === target)?.timeOriginMs }));
      setPreview({ result, documentId, itemId });
      setStatus(result.unconverted.length ? `已读取，${result.unconverted.length} 个事件暂不能转换` : `Timecode ${target} 已读取`);
    } catch (error) { const message = error instanceof Error ? error.message : String(error); setStatus('通信未完成'); notify(message, 'error'); }
    finally { setBusy(false); }
  };
  const stale = preview !== null && (preview.documentId !== documentId || preview.itemId !== itemId);
  const create = async (): Promise<void> => {
    if (!item || disabled || busy) return;
    const programId = item.id; const destination = documentId; const number = target;
    let created = false;
    setBusy(true); setPreview(null); setDifference(null); setStatus('正在创建 Timecode…');
    try {
      const connection = await endpoint();
      if (!Number.isInteger(number) || number < 1 || number > 99999) throw new Error('Timecode 编号应为 1–99999');
      if (item.lighting?.ma2Bindings?.some((entry) => entry.timecode === number)) throw new Error('当前节目已关联该 Timecode，请直接读取');
      const result = ma2TimecodePreviewSchema.parse(await window.tbLink.createMa2({ ...connection, target: number, name: item.title }));
      created = true;
      useDocumentStore.getState().executeForDocument(destination, importMa2TimecodeCommand(programId, result, initialLighting));
      setPreview({ result, documentId: destination, itemId: programId }); setIdentityChoices(new Map());
      setStatus(`Timecode ${number} 已创建并关联当前节目`);
    } catch (error) {
      setStatus(created ? `Timecode ${number} 已创建，节目关联未完成，请重新读取` : '创建未确认，请读取目标编号检查；不会自动重试');
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally { setBusy(false); }
  };
  const binding = preview ? item?.lighting?.ma2Bindings?.find((entry) => entry.timecode === preview.result.target) : undefined;
  const alreadyBound = Boolean(binding);
  const comparison = useMemo(() => {
    if (!preview || !binding || stale) return null;
    try {
      const initial = matchMa2Readback(binding, preview.result);
      const candidates = new Map(initial.ambiguous.flatMap((group) => group.remoteEventIds.map((id) => [id, group.baselineEventIds] as const)));
      const result = [...candidates.keys()].every((id) => identityChoices.has(id)) ? resolveMa2Readback(binding, preview.result, identityChoices) : initial;
      const baseline = new Map(binding.baselineTracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.map((event) => [event.id, `${((clip.start + event.at) / 1000).toFixed(3)} 秒 · ${event.kind === 'ma2' ? event.label : ma2EventLabel(event)}`] as const))));
      const labels = new Map<string, string>();
      for (const match of result.matches) labels.set(match.remoteEventId, '已对应');
      for (const id of result.added) labels.set(id, '控台新增');
      for (const group of result.ambiguous) for (const id of group.remoteEventIds) labels.set(id, '待确认');
      const deleted = new Set(result.deleted);
      const removed = binding.baselineTracks.flatMap((track) => track.clips.flatMap((clip) => clip.events.filter((event) => deleted.has(event.id)).map((event) => ({ event, time: clip.start + event.at }))));
      return { result, labels, removed, candidates, baseline, error: null };
    } catch (error) { return { result: null, labels: new Map<string, string>(), removed: [], candidates: new Map<string, string[]>(), baseline: new Map<string, string>(), error: error instanceof Error ? error.message : String(error) }; }
  }, [preview, binding, stale, identityChoices]);
  const activeDifference = difference && difference.source === item?.lighting && difference.readback === preview?.result && difference.identities === identityChoices && !stale ? difference.result : null;
  const resolution = useMemo(() => {
    if (!activeDifference || activeDifference.conflicts.some((entry) => !conflictChoices.has(entry.id))) return null;
    try { return { ...alignMa2SnapshotToFrames(resolveMa2Sync(activeDifference, conflictChoices), 30, preview?.result.timeOriginMs ?? 0), message: '合并检查通过 · 尚未应用' }; }
    catch (error) { return { snapshot: null, adjustments: [], message: `合并未完成：${error instanceof Error ? error.message : String(error)}` }; }
  }, [activeDifference, conflictChoices, preview?.result.timeOriginMs]);
  const mergedEvents = useMemo(() => resolution?.snapshot?.objects.filter((entry) => entry.kind === 'event').sort((a, b) => Number(a.properties.time) - Number(b.properties.time)) ?? [], [resolution]);
  const mergePageCount = Math.max(1, Math.ceil(mergedEvents.length / 100));
  const visibleMergePage = Math.min(mergePage, mergePageCount - 1);
  const synchronize = async (): Promise<void> => {
    if (!preview || !binding || !item?.lighting || !activeDifference || !resolution?.snapshot || stale || busy || disabled) return;
    const source = item.lighting; const destination = preview.documentId; const programId = item.id;
    let consoleConfirmed = false;
    setBusy(true); setStatus('正在复核、同步并回读…'); try {
      await archiveBeforeSync(destination, programId, source);
      const result = ma2ApplyResultSchema.parse(await window.tbLink.applyMa2({ ...await endpoint(), document: source, bindingId: binding.id, readback: preview.result, choices: [...identityChoices], conflicts: [...conflictChoices], timeAlignment: 'nearest-frame' }));
      if (result.status === 'incomplete') {
        setStatus(result.mayHaveWritten ? '同步未完成 · 控台可能已写入，请重新读取' : '同步未完成 · 未写入控台');
        notify(`${result.message}${result.backupFile ? `；备份：${result.backupFile}` : ''}`, 'error');
        setDifference(null); return;
      }
      consoleConfirmed = true;
      useDocumentStore.getState().executeForDocument(destination, applyMa2ReadbackCommand(programId, binding.id, source, result.confirmed));
      setStatus(`节目与 Timecode ${result.confirmed.target} 已同步并核对${result.backupFile ? ` · 备份 ${result.backupFile}` : ''}`);
      setPreview(null); setDifference(null);
    } catch (error) {
      setStatus(consoleConfirmed ? '控台已确认 · 节目更新未完成，请重新读取比较' : '同步未确认 · 请重新读取控台');
      notify(error instanceof Error ? error.message : String(error), 'error'); setDifference(null);
    } finally { setBusy(false); }
  };
  const compare = async (): Promise<void> => {
    if (!preview || !binding || !item?.lighting || stale || busy || disabled) return;
    const source = item.lighting; const readback = preview.result; const identities = identityChoices;
    setBusy(true); setDifference(null); setConflictChoices(new Map()); setMergePage(0);
    try {
      const result = ma2SyncPreviewSchema.parse(await window.tbLink.compareMa2({ document: source, bindingId: binding.id, readback, choices: [...identities] }));
      setDifference({ result, source, readback, identities });
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const apply = (): void => {
    if (!preview || !item || stale || disabled || busy) return;
    try {
      useDocumentStore.getState().executeForDocument(preview.documentId, importMa2TimecodeCommand(item.id, preview.result));
      setStatus(`已加入“${item.title}”`); setPreview(null);
    } catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const events = preview?.result.document.tracks.flatMap((track) => track.clips.flatMap((clip) => clip.events)).filter((event) => event.kind === 'ma2' || event.kind === 'ma2-fader') ?? [];
  return <section className="settings-section ma2-sync-section" aria-label="MA2 节目同步">
    <p className="sync-destination"><span>目标控台</span><strong>{method === 'network' ? network ? `${network.host} · ${network.username}` : '请先在设备连接中保存并连接控台' : `本机 onPC · ${directory || '未配置目录'}`}</strong></p>
    <div className="settings-header-actions ma2-connection-actions"><label>时间码编号<input aria-label="读取 MA2 Timecode 编号" type="number" min={1} max={99999} value={Number.isNaN(target) ? '' : target} disabled={busy || disabled} onChange={(event) => { setTarget(event.target.valueAsNumber); setPreview(null); setDifference(null); }} /></label><Button className="primary-button" disabled={busy || disabled || !item} onClick={() => void readPreview()}>读取灯光编排</Button>{status !== '尚未检查' ? <span className="ma2-connection-status" role="status">{status}</span> : null}</div>
    {item ? <div className="ma2-create-action"><Button className="secondary-button" title={`使用上方编号创建“${item.title}”，已有编号不会覆盖`} disabled={busy || disabled || item.lighting?.ma2Bindings?.some((entry) => entry.timecode === target)} onClick={() => void create()}>创建并关联当前节目</Button></div> : null}
    {preview ? <div className="ma2-read-preview" role="region" aria-label="MA2 灯光读取预览">
      <strong>{preview.result.name} · {events.length} 个灯光点</strong>
      {binding && item?.lighting && !stale ? <Ma2TrackBinding key={`${item.id}:${binding.id}:${directory}:${preview.result.readAt}`} directory={method === 'network' ? '' : directory} network={method === 'network' ? network ?? undefined : undefined} itemId={item.id} bindingId={binding.id} document={item.lighting} preview={preview.result} disabled={disabled || busy} notify={notify} /> : null}
      {comparison?.result ? <p className="settings-note" role="status">已对应 {comparison.result.matches.length} 个点 · 控台新增 {comparison.result.added.length} 个 · 控台删除 {comparison.result.deleted.length} 个 · 待确认 {comparison.result.ambiguous.reduce((count, group) => count + group.remoteEventIds.length, 0)} 个</p> : null}
      {comparison?.error ? <p role="alert">比较未完成：{comparison.error}</p> : null}
      {events.length ? <table className={comparison?.candidates.size ? 'ma2-match-table' : undefined}><thead><tr><th>时间（秒）</th><th>Cue / 动作</th><th>执行器</th><th>名称</th>{binding ? <th>对应情况</th> : null}</tr></thead><tbody>{events.slice(page * 100, (page + 1) * 100).map((event) => <tr key={event.id}><td>{(event.at / 1000).toFixed(3)}</td><td>{ma2EventLabel(event)}</td><td>{event.executor}</td><td title={event.label}>{event.label}</td>{binding ? <td>{comparison?.candidates.has(event.id) ? <select aria-label={`对应 ${ma2EventLabel(event, true)} · ${(event.at / 1000).toFixed(3)} 秒`} value={identityChoices.has(event.id) ? identityChoices.get(event.id) === null ? 'new' : `old:${identityChoices.get(event.id)}` : ''} onChange={(input) => {
        const value = input.currentTarget.value; const next = new Map(identityChoices);
        if (value === '') next.delete(event.id); else next.set(event.id, value === 'new' ? null : value.slice(4));
        setIdentityChoices(next);
      }}><option value="">请选择对应点</option><option value="new">控台新增点</option>{comparison.candidates.get(event.id)?.map((id) => <option key={id} value={`old:${id}`} disabled={[...identityChoices].some(([remote, selected]) => remote !== event.id && selected === id)}>{comparison.baseline.get(id)}</option>)}</select> : comparison?.labels.get(event.id) ?? '未比较'}</td> : null}</tr>)}</tbody></table> : null}
      {comparison?.removed.length ? <details open><summary>控台已删除的点（{comparison.removed.length}）</summary>{comparison.removed.map(({ event, time }) => <p key={event.id}>{(time / 1000).toFixed(3)} 秒 · {ma2EventLabel(event, true)}{event.kind === 'ma2' ? ` · ${event.label}` : ''}</p>)}</details> : null}
      {comparison?.result ? <p className="settings-note">仅回读 · 未应用到节目或控台</p> : null}
      {comparison?.result ? <Button className="secondary-button" disabled={busy || disabled || stale || comparison.result.ambiguous.length > 0} onClick={() => void compare()}>比较节目与控台修改</Button> : null}
      {activeDifference ? <div className="ma2-difference" role="region" aria-label="节目与控台差异">
        <strong>{activeDifference.conflicts.length ? `${activeDifference.conflicts.length} 处冲突，请选择保留内容` : '没有冲突'}</strong>
        {activeDifference.conflicts.length ? <table className="ma2-conflict-table"><thead><tr><th>原来</th><th>当前节目</th><th>控台回读</th><th>保留</th></tr></thead><tbody>{activeDifference.conflicts.map((entry, index) => <tr key={entry.id}>
          {[entry.base, entry.local, entry.remote].map((object, column) => <td key={column}>{object ? Object.entries(object.properties).filter(([key]) => key === 'name' || key === 'cue' || new Set([entry.base?.properties[key], entry.local?.properties[key], entry.remote?.properties[key]]).size > 1).map(([key, value]) => <div key={key}><span>{({ time: '时间', cue: 'Cue', name: '名称', sequence: '序列', executor: '执行器', action: '动作', muted: '静音', number: '编号', level: '推杆值', fader: '推杆类型' } as Record<string, string>)[key] ?? key}：</span>{key === 'level' ? `${Number((Number(value) * 100).toFixed(6))}%` : key === 'time' ? `${(Number(value) / 1000).toFixed(3)} 秒` : key === 'muted' ? value === 'true' ? '是' : '否' : key === 'action' ? ({ goto: '调用 Cue', go: '下一步', off: '关闭执行器', master: '主推杆' } as Record<string, string>)[value] ?? value : value}</div>) : '已删除'}</td>)}
          <td><select aria-label={`冲突 ${index + 1} 保留版本`} value={conflictChoices.get(entry.id) ?? ''} onChange={(input) => { const value = input.currentTarget.value; const next = new Map(conflictChoices); if (value === 'local' || value === 'remote') next.set(entry.id, value); else next.delete(entry.id); setConflictChoices(next); }}><option value="">请选择</option><option value="local">当前节目</option><option value="remote">控台回读</option></select></td>
        </tr>)}</tbody></table> : null}
        {resolution ? <p role="status">{resolution.message}</p> : null}
        {resolution?.snapshot ? <p className="settings-note">合并后 {resolution.snapshot.objects.filter((entry) => entry.kind === 'track').length} 条轨道 · {mergedEvents.length} 个灯光点</p> : null}
        {resolution?.adjustments.length ? <p className="settings-note">MA2 按 30 帧/秒保存，{resolution.adjustments.length} 个点将对齐到最近帧，最大偏移 {resolution.adjustments.reduce((maximum, entry) => Math.max(maximum, Math.abs(entry.toMs - entry.fromMs)), 0).toFixed(3)} 毫秒。合并结果显示对齐后的时间，确认同步后应用到节目。</p> : null}
        {resolution?.snapshot ? <details open><summary>核对合并结果（{mergedEvents.length} 个点）</summary><table><thead><tr><th>时间（秒）</th><th>Cue / 动作</th><th>执行器</th><th>名称</th></tr></thead><tbody>{mergedEvents.slice(visibleMergePage * 100, (visibleMergePage + 1) * 100).map((entry) => <tr key={entry.id}><td>{(Number(entry.properties.time) / 1000).toFixed(3)}</td><td>{entry.properties.action === 'master' ? `主推杆 ${Number((Number(entry.properties.level) * 100).toFixed(6))}%` : entry.properties.action === 'goto' ? entry.properties.cue : entry.properties.action === 'go' ? '下一步' : '关闭执行器'}</td><td>{entry.properties.executor}</td><td>{entry.properties.name}</td></tr>)}</tbody></table>{mergePageCount > 1 ? <div className="settings-header-actions"><button disabled={visibleMergePage === 0} onClick={() => setMergePage(visibleMergePage - 1)}>上一页</button><span>{visibleMergePage + 1} / {mergePageCount}</span><button disabled={visibleMergePage + 1 === mergePageCount} onClick={() => setMergePage(visibleMergePage + 1)}>下一页</button></div> : null}</details> : null}
        <Button className="secondary-button" disabled={busy || disabled || !resolution?.snapshot} onClick={() => void synchronize()}>同步节目与 MA2</Button>
      </div> : null}
      {events.length > 100 ? <div className="settings-header-actions"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(events.length / 100)}</span><button disabled={(page + 1) * 100 >= events.length} onClick={() => setPage(page + 1)}>下一页</button></div> : null}
      {preview.result.warnings.map((warning) => <p className="settings-note" key={warning}>{warning}</p>)}
      {preview.result.unconverted.length ? <details open><summary>未转换事件（{preview.result.unconverted.length}）</summary>{preview.result.unconverted.map((entry) => <p className="settings-note" key={entry.path}>{entry.path}：{entry.reason}</p>)}</details> : null}
      <div className="settings-header-actions"><Button className="secondary-button" disabled={disabled || busy || stale || !item || Boolean(alreadyBound)} onClick={apply}>加入当前节目</Button><span>{stale ? '节目已切换，请重新读取' : alreadyBound ? '此节目已关联该 Timecode' : item ? item.title : '请先选择节目'}</span><Button className="secondary-button" onClick={() => setPreview(null)}>关闭预览</Button></div>
    </div> : null}
  </section>;
}
function Ma2TrackBinding(props: { directory: string; network?: Ma2NetworkTarget | undefined; itemId: string; bindingId: string; document: LightingDocument; preview: Ma2TimecodePreview; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element | null {
  const [trackId, setTrackId] = useState('');
  const [executor, setExecutor] = useState('');
  const [address, setAddress] = useState('');
  const [reading, setReading] = useState(false);
  const [discovered, setDiscovered] = useState<Ma2ExecutorPreview | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const readExecutor = async (): Promise<void> => {
    if (reading || props.disabled) return;
    setReading(true); setDiscovered(null);
    try {
      const result = ma2ExecutorPreviewSchema.parse(await window.tbLink.readMa2Executor({ dataDirectory: props.directory, network: props.network, target: props.preview.target, executor: address.trim() }));
      if (result.target !== props.preview.target || result.executor !== address.trim()) throw new Error('执行器回读目标不一致，请重新读取');
      if (alive.current) { setDiscovered(result); setExecutor(result.executor); }
    } catch (error) { if (alive.current) props.notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { if (alive.current) setReading(false); }
  };
  const binding = props.document.ma2Bindings?.find((entry) => entry.id === props.bindingId);
  const bound = new Set(props.document.ma2Bindings?.flatMap((entry) => [...entry.baselineTracks.map((track) => track.id), ...(entry.pendingTracks ?? []).map((track) => track.trackId)]));
  const tracks = props.document.tracks.filter((track) => track.kind === 'ma2' && !bound.has(track.id));
  const executors = new Map((props.preview.trackMappings ?? []).map((mapping) => [mapping.executor, props.preview.document.tracks.find((track) => track.id === mapping.trackId)?.name ?? '']));
  if (discovered) executors.set(discovered.executor, discovered.executorName);
  if (!binding || (!tracks.length && !binding.pendingTracks?.length)) return null;
  const link = (): void => {
    try {
      if (!tracks.some((track) => track.id === trackId) || !executors.get(executor)) throw new Error('请选择灯光轨道和已读取的执行器');
      useDocumentStore.getState().execute(bindMa2TrackCommand(props.itemId, props.bindingId, trackId, executor, executors.get(executor)!, discovered?.executor === executor ? discovered : undefined));
      setTrackId(''); props.notify('轨道已关联，比较后同步到 MA2');
    } catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const cancel = (id: string): void => {
    try {
      useDocumentStore.getState().execute(setLightingCommand(props.itemId, { ...props.document, ma2Bindings: props.document.ma2Bindings?.map((entry) => entry.id === props.bindingId ? { ...entry, pendingTracks: entry.pendingTracks?.filter((track) => track.trackId !== id) } : entry) }, '取消待同步轨道关联'));
    } catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  return <details open className="ma2-track-binding"><summary>关联节目中的灯光轨道{binding.pendingTracks?.length ? ` · ${binding.pendingTracks.length} 条待同步` : ''}</summary>
    {tracks.length ? <div className="settings-header-actions ma2-executor-read"><label>其他执行器<input aria-label="读取执行器地址" placeholder="页.编号，例如 1.5" value={address} disabled={props.disabled || reading} onChange={(event) => { setAddress(event.currentTarget.value); setDiscovered(null); }} /></label><Button className="secondary-button" disabled={props.disabled || reading || !/^[1-9]\d{0,4}\.[1-9]\d{0,4}$/.test(address.trim())} onClick={() => void readExecutor()}>{reading ? '读取中…' : '读取执行器'}</Button></div> : null}
    {discovered ? <p role="status">{discovered.executorName} · 序列 {discovered.cueCatalog[0]?.sequence} · {discovered.cueCatalog[0]?.cues.length} 个 Cue</p> : null}
    {tracks.length ? <div className="ma2-track-binding-fields">
      <label>节目轨道<select aria-label="关联 MA2 的节目轨道" value={trackId} disabled={props.disabled || reading} onChange={(event) => setTrackId(event.currentTarget.value)}><option value="">选择轨道</option>{tracks.map((track) => <option key={track.id} value={track.id} disabled={track.locked}>{track.name}{track.locked ? '（已锁定）' : ''}</option>)}</select></label>
      <label>执行器<select aria-label="关联 MA2 的执行器" value={executor} disabled={props.disabled || reading} onChange={(event) => setExecutor(event.currentTarget.value)}><option value="">选择执行器</option>{[...executors].map(([address, name]) => <option key={address} value={address}>{address} · {name}</option>)}</select></label>
      <button disabled={props.disabled || reading || !tracks.some((track) => track.id === trackId) || !executors.has(executor)} onClick={link}>关联轨道</button>
    </div> : null}
    {binding.pendingTracks?.map((pending) => <div className="ma2-pending-track" key={pending.trackId}><span>{props.document.tracks.find((track) => track.id === pending.trackId)?.name ?? '已删除轨道'} → {pending.executor}</span><button disabled={props.disabled || reading} onClick={() => cancel(pending.trackId)}>取消关联</button></div>)}
  </details>;
}
function ma2EventLabel(event: LightingEvent, cuePrefix = false): string {
  if (event.kind === 'ma2-fader') return `主推杆 ${Number((event.level * 100).toFixed(6))}%`;
  if (event.kind !== 'ma2') return '灯光事件';
  return event.action === 'goto' ? `${cuePrefix ? 'Cue ' : ''}${event.cue ?? ''}` : event.action === 'go' ? '下一步' : '关闭执行器';
}
