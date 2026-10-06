import { useDocumentStore } from '../stores/document-store';
import { readMa2Method } from '../stores/ma2-mode-store';
import { toUserErrorMessage } from '@tb/core/link';
import { useEffect, useState } from 'react';
import { Download, Search, X, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { ma2NetworkStatusSchema, lightingTemplateTrackSchema, type LightingDocument, type Ma2CatalogRequest, type Ma2EffectLibrary } from '@tb/schema';
import { connectDiscoveredMa2, useLocalMa2Store } from '../stores/ma2-connection-store';
import { FIXTURE_CATEGORIES, LightingFixtureMapping } from './LightingFixtureMapping';
import { loadMa2MaterialCache } from './ma2-material-cache';
import { scanMa2Materials, useMa2MaterialReadStore } from '../stores/ma2-material-read-store';

type Row = { key: string; name: string; sequence: number; cue: string; executor: string; categories: string[]; fixtureIds: number[]; selected: boolean };
function rowsForSequence(sequence: Ma2EffectLibrary['sequences'][number], document: LightingDocument, savedMappings: Record<string, number[]>, usage: Ma2EffectLibrary['fixtureUsage']): Row[] {
  return sequence.cues.map(cue => {
    const candidates = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === sequence.sequence).map(mapping => mapping.executor)) ?? [])];
    const fixtureIds = usage.find(value => value.sequence === sequence.sequence && value.cueIndex === cue.index)?.fixtureIds ?? [];
    const categories = [...new Set([...Object.entries(savedMappings).filter(([, ids]) => ids.some(id => fixtureIds.includes(id))).map(([category]) => category), ...FIXTURE_CATEGORIES.filter(category => `${sequence.name ?? ''} ${cue.name ?? ''}`.includes(category))])];
    return { key: `${sequence.sequence}/${cue.number}`, name: sequence.name ? `${sequence.name} · ${cue.name ?? `Cue ${cue.number}`}` : cue.name ?? `Cue ${cue.number}`, sequence: sequence.sequence, cue: cue.number, executor: candidates.length === 1 ? candidates[0]! : '', categories, fixtureIds, selected: false };
  });
}
async function connection(): Promise<Ma2CatalogRequest> {
  const method = readMa2Method();
  if (method === 'midi') throw new Error('当前为仅 MIDI 时间码模式，不读取控台灯光库');
  const local = useLocalMa2Store.getState();
  if (method === 'local' || (!method && local.status === 'ready')) {
    if (local.status !== 'ready') throw new Error('请先在设备设置连接本机 onPC');
    return { dataDirectory: local.directory };
  }
  const network = ma2NetworkStatusSchema.parse(await connectDiscoveredMa2());
  if (network.state !== 'connected' || !network.settings) throw new Error('请先在设备设置连接 MA2 控台');
  const { host, port, monitorPort, username } = network.settings;
  return { dataDirectory: '', network: { host, port, monitorPort, username } };
}
export function Ma2EffectImport({ document, disabled, onChange, onClose }: { document: LightingDocument; disabled: boolean; onChange: (document: LightingDocument, label: string) => boolean | void; onClose: () => void }): JSX.Element {
  const projectId = useDocumentStore(state => state.project?.projectId ?? '');
  const documentId = useDocumentStore(state => state.documentId);
  useDocumentStore(state => state.project?.ma2MaterialLibrary);
  const cached = loadMa2MaterialCache(projectId);
  const catalog = cached?.library ?? null;
  const task = useMa2MaterialReadStore();
  const busy = task.busy;
  const progress = task.documentId === documentId ? task.progress : null;
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [sequenceFilter, setSequenceFilter] = useState('');
  const [page, setPage] = useState(0);
  const [mappings, setMappings] = useState<Record<string, number[]>>({});
  const partialSequences = catalog?.sequences ?? [];
  const close = (): void => onClose();
  useEffect(() => {
    if (!catalog) { setRows([]); return; }
    const saved = Object.fromEntries(document.fixtureCategories?.filter(value => value.show === catalog.directory.show).map(value => [value.category, value.fixtureIds]) ?? []);
    setMappings(saved);
    setRows(current => catalog.sequences.flatMap(sequence => rowsForSequence(sequence, document, saved, catalog.fixtureUsage)).map(row => ({ ...row, selected: current.some(old => old.key === row.key && old.selected) })));
  }, [catalog, document]);
  const scan = async (retry = false): Promise<void> => {
    setError('');
    try { await scanMa2Materials(await connection(), retry); }
    catch (cause) { setError(toUserErrorMessage(cause)); }
  };
  const patch = (key: string, value: Partial<Row>): void => setRows(current => current.map(row => row.key === key ? { ...row, ...value } : row));
  const visible = rows.filter(row => (!sequenceFilter || String(row.sequence) === sequenceFilter) && `${row.name} ${row.sequence} ${row.cue}`.toLowerCase().includes(query.toLowerCase()));
  const selected = rows.filter(row => row.selected);
  const save = (): void => {
    if (!catalog || !selected.length) return;
    if (catalog.sourceUnverified) { setError('目录来源尚未完成核对，请补读未完成项后使用；缓存保留'); return; }
    setError('');
    try {
      if (selected.some(row => row.executor && !/^[1-9]\d*\.[1-9]\d*$/.test(row.executor))) throw new Error('执行器格式应为页号.编号，例如 1.101；留空即可按序列池引用');
      const additions = selected.map(row => ({ id: crypto.randomUUID(), name: row.name, sourceShow: catalog.directory.show, categories: row.categories, track: lightingTemplateTrackSchema.parse({ id: crypto.randomUUID(), name: row.name, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: row.sequence, cue: row.cue, executor: row.executor } }) }));
      const unique = additions.filter(addition => !document.templates.some(old => old.sourceShow === addition.sourceShow && old.track.cueStamp?.mode === 'fixed' && addition.track.cueStamp?.mode === 'fixed' && old.track.cueStamp.sequence === addition.track.cueStamp.sequence && Number(old.track.cueStamp.cue) === Number(addition.track.cueStamp.cue) && old.track.cueStamp.executor === addition.track.cueStamp.executor));
      const applied = onChange({ ...document, ma2Library: { show: catalog.directory.show, readAt: catalog.readAt, sequences: catalog.sequences }, templates: [...document.templates, ...unique], fixtureCategories: [...document.fixtureCategories?.filter(value => value.show !== catalog.directory.show) ?? [], ...Object.entries(mappings).map(([category, fixtureIds]) => ({ show: catalog.directory.show, category, fixtureIds }))] }, '导入控台效果库');
      if (applied === false) throw new Error('工程保存失败，请查看页面提示后再试');
      close();
    } catch (cause) { setError(`未导入：${toUserErrorMessage(cause)}`); }
  };
  return <div className="effect-inline-panel ma2-material-inline" role="region" aria-label="读取控台效果库"><section className="effect-import-dialog">
    <div className="ma2-material-toolbar"><label className="effect-search"><Search /><input aria-label="搜索控台 Cue" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索名称、序列或 Cue" /></label><select aria-label="按序列分组" value={sequenceFilter} onChange={event => { setSequenceFilter(event.target.value); setPage(0); }}><option value="">全部序列</option>{partialSequences.map(sequence => <option key={sequence.sequence} value={sequence.sequence}>{sequence.sequence} · {sequence.name}</option>)}</select><button disabled={busy || disabled} onClick={() => void scan()}><RefreshCw />{busy ? '读取中…' : catalog ? '重新读取' : '读取控台素材'}</button>{catalog?.sourceUnverified || catalog?.errors.length ? <button disabled={busy || disabled} onClick={() => void scan(true)}>补读未完成项</button> : null}{busy && task.activeId ? <button onClick={() => void window.tbLink.cancelMa2Read(task.activeId!).catch(cause => setError(toUserErrorMessage(cause)))}>取消读取</button> : null}<button className="ma2-material-close" title="返回素材库" aria-label="关闭素材窗口" onClick={close}><X /></button></div>
    {busy ? <progress className="ma2-material-progress" aria-label="控台读取进度" {...progress && progress.total > 0 ? { value: progress.completed, max: progress.total } : {}} /> : null}
    {catalog && catalog.fixtureDetails !== 'unavailable' ? <LightingFixtureMapping key={catalog?.readAt ?? "empty"} mappings={mappings} disabled={busy || !catalog} onApply={value => { setMappings(value); setRows(current => current.map(row => ({ ...row, categories: Object.entries(value).filter(([, ids]) => ids.some(id => row.fixtureIds.includes(id))).map(([category]) => category) }))); }} /> : null}
    <div className="effect-import-rows"><table><thead><tr><th><input type="checkbox" aria-label="全选筛选结果" disabled={!catalog || busy} checked={visible.length > 0 && visible.every(row => row.selected)} onChange={event => { const checked = event.target.checked; setRows(current => current.map(row => visible.some(value => value.key === row.key) ? { ...row, selected: checked } : row)); }} /></th><th>素材名称</th><th>序列 / Cue</th><th>执行器（可选）</th><th>分类</th></tr></thead><tbody>{visible.slice(page * 100, page * 100 + 100).map(row => <tr key={row.key} data-selected={row.selected}><td><input type="checkbox" aria-label={`选择 ${row.key}`} disabled={!catalog || busy} checked={row.selected} onChange={event => patch(row.key, { selected: event.target.checked })} /></td><td>{row.name}</td><td>{row.sequence} / {row.cue}</td><td><input aria-label={`执行器 ${row.key}`} value={row.executor} placeholder="序列池" disabled={!catalog || busy} onChange={event => patch(row.key, { executor: event.target.value })} /></td><td><select aria-label={`分类 ${row.key}`} value={row.categories[0] ?? ""} disabled={!catalog || busy} onChange={event => patch(row.key, { categories: event.target.value ? [event.target.value] : [] })}><option value="">待分类</option>{FIXTURE_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select>{row.categories.length > 1 ? <small>{row.categories.join(" / ")}</small> : null}</td></tr>)}</tbody></table>{!rows.length ? <div className="ma2-material-empty"><Download /><strong>{busy ? '正在读取控台素材' : error ? '素材读取未完成' : '控台暂无素材'}</strong><span>{busy ? '读到的序列会立即显示在这里' : error ? '已显示的内容尚未通过最终核对，请重新读取' : '保存控台序列后，可重新读取'}</span></div> : !visible.length ? <div className="ma2-material-empty">没有匹配的素材</div> : null}</div>
    {catalog?.errors.map(value => <p role="alert" key={value.sequence}>序列 {value.sequence}：{toUserErrorMessage(value.message)}</p>)}{error || task.documentId === documentId && task.error ? <p role="alert">{error || task.error}</p> : null}{catalog?.incomplete ? <p role="status">{catalog.incomplete}；完成核对后可加入编排。</p> : null}
    <footer className="ma2-material-footer"><span role="status">{busy ? `${progress?.detail || '正在连接控台'}${progress && progress.total > 0 ? ` · ${progress.completed}/${progress.total}` : ''}` : `${cached ? `工程缓存 · ${cached.source} · 非实时 · ` : ''}${catalog?.directory.show || '未读取'} · ${visible.length} 项${selected.length ? ` · 已选 ${selected.length}` : ''}`}</span><div className="ma2-material-pagination"><button aria-label="上一页" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronLeft /></button><span>{page + 1} / {Math.max(1, Math.ceil(visible.length / 100))}</span><button aria-label="下一页" disabled={(page + 1) * 100 >= visible.length} onClick={() => setPage(page + 1)}><ChevronRight /></button></div><button className="primary-button" disabled={busy || disabled || !catalog || catalog.sourceUnverified || !selected.length} onClick={save}>加入素材库{selected.length ? ` · ${selected.length}` : ''}</button></footer>
  </section></div>;
}
