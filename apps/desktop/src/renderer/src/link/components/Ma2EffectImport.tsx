import { readMa2Method } from '../stores/ma2-mode-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { ma2EffectLibrarySchema, ma2NetworkStatusSchema, lightingTrackSchema, type LightingDocument, type Ma2CatalogRequest, type Ma2EffectLibrary } from '@tb/schema';
import { useLocalMa2Store } from '../stores/ma2-connection-store';
import { FIXTURE_CATEGORIES, LightingFixtureMapping } from './LightingFixtureMapping';

type Row = { key: string; name: string; sequence: number; cue: string; executor: string; categories: string[]; fixtureIds: number[]; selected: boolean };
async function connection(): Promise<Ma2CatalogRequest> {
  const method = readMa2Method();
  if (method === 'midi') throw new Error('当前为仅 MIDI 时间码模式，不读取控台灯光库');
  const local = useLocalMa2Store.getState();
  if (method === 'local' || (!method && local.status === 'ready')) {
    if (local.status !== 'ready') throw new Error('请先在设备设置连接本机 onPC');
    return { dataDirectory: local.directory };
  }
  const network = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
  if (network.state !== 'connected' || !network.settings) throw new Error('请先在设备设置连接 MA2 控台');
  const { host, port, monitorPort, username } = network.settings;
  return { dataDirectory: '', network: { host, port, monitorPort, username } };
}
export function Ma2EffectImport({ document, disabled, onChange, onClose }: { document: LightingDocument; disabled: boolean; onChange: (document: LightingDocument, label: string) => void; onClose: () => void }): JSX.Element {
  const [catalog, setCatalog] = useState<Ma2EffectLibrary | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [mappings, setMappings] = useState<Record<string, number[]>>({});
  const source = useRef<Ma2CatalogRequest | null>(null);
  const latest = useRef(document); latest.current = document;
  const mounted = useRef(true);
  const started = useRef(false);
  const scan = useCallback(async (): Promise<void> => {
    setBusy(true); setError(''); setCatalog(null); setRows([]); setPage(0);
    try {
      const endpoint = await connection();
      const result = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary(endpoint));
      if (!mounted.current) return;
      source.current = endpoint; setCatalog(result);
      const savedMappings = Object.fromEntries(document.fixtureCategories?.filter(value => value.show === result.directory.show).map(value => [value.category, value.fixtureIds]) ?? []);
      setMappings(savedMappings);
      setRows(result.sequences.flatMap(sequence => sequence.cues.map(cue => {
        const candidates = [...new Set(document.ma2Bindings?.flatMap(binding => binding.mappings.filter(mapping => mapping.sequence === sequence.sequence).map(mapping => mapping.executor)) ?? [])];
        const fixtureIds = result.fixtureUsage.find(value => value.sequence === sequence.sequence && value.cueIndex === cue.index)?.fixtureIds ?? [];
        const categories = Object.entries(savedMappings).filter(([, ids]) => ids.some(id => fixtureIds.includes(id))).map(([category]) => category);
        return { key: `${sequence.sequence}/${cue.number}`, name: cue.name ?? sequence.name ?? `Cue ${cue.number}`, sequence: sequence.sequence, cue: cue.number, executor: candidates.length === 1 ? candidates[0]! : '', categories, fixtureIds, selected: false };
      })));
    } catch (cause) { setError(`${String(cause)}。完整效果库读取需要新版 MA2 配套插件。`); }
    finally { setBusy(false); }
  }, [document]);
  useEffect(() => { mounted.current = true; if (!started.current) { started.current = true; void scan(); } return () => { mounted.current = false; }; }, [scan]);
  const patch = (key: string, value: Partial<Row>): void => setRows(current => current.map(row => row.key === key ? { ...row, ...value } : row));
  const visible = rows.filter(row => `${row.name} ${row.sequence} ${row.cue}`.toLowerCase().includes(query.toLowerCase()));
  const selected = rows.filter(row => row.selected);
  const save = async (): Promise<void> => {
    if (!catalog || !selected.length) return;
    setBusy(true); setError('');
    try {
      const before = latest.current;
      if (JSON.stringify(source.current) !== JSON.stringify(await connection())) throw new Error('连接已变化，请重新读取');
      const fresh = ma2EffectLibrarySchema.parse(await window.tbLink.readMa2EffectLibrary(source.current!));
      if (!mounted.current || latest.current !== before) throw new Error('读取期间工程已变化，请重新导入');
      if (JSON.stringify(fresh.directory) !== JSON.stringify(catalog.directory) || JSON.stringify(fresh.sequences) !== JSON.stringify(catalog.sequences) || JSON.stringify(fresh.fixtureUsage) !== JSON.stringify(catalog.fixtureUsage)) throw new Error('控台内容已变化，请重新读取');
      const additions = selected.map(row => ({ id: crypto.randomUUID(), name: row.name, sourceShow: catalog.directory.show, categories: row.categories, track: lightingTrackSchema.parse({ id: crypto.randomUUID(), name: row.name, kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: row.sequence, cue: row.cue, executor: row.executor } }) }));
      const unique = additions.filter(addition => !document.templates.some(old => old.sourceShow === addition.sourceShow && old.track.cueStamp?.mode === 'fixed' && addition.track.cueStamp?.mode === 'fixed' && old.track.cueStamp.sequence === addition.track.cueStamp.sequence && Number(old.track.cueStamp.cue) === Number(addition.track.cueStamp.cue) && old.track.cueStamp.executor === addition.track.cueStamp.executor));
      onChange({ ...document, templates: [...document.templates, ...unique], fixtureCategories: [...document.fixtureCategories?.filter(value => value.show !== catalog.directory.show) ?? [], ...Object.entries(mappings).map(([category, fixtureIds]) => ({ show: catalog.directory.show, category, fixtureIds }))] }, '导入控台效果库'); onClose();
    } catch (cause) { setError(`未导入：${String(cause)}。每条效果需要有效的执行器，例如 1.101。`); }
    finally { setBusy(false); }
  };
  return <div className="effect-binding-backdrop"><section className="effect-import-dialog" aria-label="读取控台效果库"><header><button disabled={busy || disabled} onClick={() => void scan()}><Download />{busy ? '正在读取…' : '读取当前控台'}</button></header>
    <p>{catalog ? `${catalog.directory.show} · ${rows.length} 个 Cue · ${catalog.errors.length} 条序列读取异常` : '读取当前 Show 的全部 Sequence / Cue，勾选后加入效果库。'}</p>
    <p>按 Cue 内记录的灯具编号分类；前序 Cue 追踪继承的灯具需要核对。空白执行器需要填写。</p>
    <LightingFixtureMapping key={catalog?.readAt ?? "empty"} mappings={mappings} disabled={busy || !catalog} onApply={value => { setMappings(value); setRows(current => current.map(row => ({ ...row, categories: Object.entries(value).filter(([, ids]) => ids.some(id => row.fixtureIds.includes(id))).map(([category]) => category) }))); }} /><label className="effect-search"><Search /><input aria-label="搜索控台 Cue" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="搜索名称、序列、Cue" /></label>
    <div className="effect-import-rows"><table><thead><tr><th><input type="checkbox" aria-label="全选筛选结果" checked={visible.length > 0 && visible.every(row => row.selected)} onChange={event => { const checked = event.target.checked; setRows(current => current.map(row => visible.some(value => value.key === row.key) ? { ...row, selected: checked } : row)); }} /></th><th>名称</th><th>Sequence / Cue</th><th>执行器</th><th>灯具</th></tr></thead><tbody>{visible.slice(page * 100, page * 100 + 100).map(row => <tr key={row.key}><td><input type="checkbox" aria-label={`选择 ${row.key}`} checked={row.selected} onChange={event => patch(row.key, { selected: event.target.checked })} /></td><td>{row.name}</td><td>{row.sequence} / {row.cue}</td><td><input aria-label={`执行器 ${row.key}`} value={row.executor} placeholder="1.101" onChange={event => patch(row.key, { executor: event.target.value })} /></td><td><select aria-label={`分类 ${row.key}`} value={row.categories[0] ?? ""} onChange={event => patch(row.key, { categories: event.target.value ? [event.target.value] : [] })}><option value="">待分类</option>{FIXTURE_CATEGORIES.map(value => <option key={value}>{value}</option>)}</select>{row.categories.length > 1 ? <small>{row.categories.join(" / ")}</small> : null}</td></tr>)}</tbody></table></div>
    {catalog?.errors.map(value => <p role="alert" key={value.sequence}>Sequence {value.sequence}：{value.message}</p>)}{error ? <p role="alert">{error}</p> : null}
    <footer><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.max(1, Math.ceil(visible.length / 100))}</span><button disabled={(page + 1) * 100 >= visible.length} onClick={() => setPage(page + 1)}>下一页</button><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy || disabled || !selected.length} onClick={() => void save()}>加入效果库 · {selected.length}</button></footer>
  </section></div>;
}
