import { useEffect } from 'react';
import { ma2NetworkStatusSchema, type Ma2CatalogRequest } from '@tb/schema';
import { Button } from './Button';
import { Ma2ReadProgress } from './Ma2ReadProgress';
import { useDocumentStore } from '../stores/document-store';
import { scanMa2, importCachedMa2, useMa2ReadStore } from '../stores/ma2-read-store';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { P1LightingImportReport } from './P1LightingImportReport';
import { Ma2ProgramSync } from './Ma2ProgramSync';
import { useMa2AutoSyncStore } from '../runtime/use-ma2-auto-sync';

export function Ma2CatalogSettings({ method, directory, disabled, notify, onBusy }: { onBusy: (busy: boolean) => void; method: 'local' | 'network'; directory: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const cached = project?.ma2ReadState;
  const job = useMa2ReadStore();
  const automatic = useMa2AutoSyncStore();
  useEffect(() => { onBusy(job.busy); return () => onBusy(false); }, [job.busy, onBusy]);
  const endpoint = async (): Promise<Ma2CatalogRequest> => {
    if (method === 'local') {
      if (!directory.trim()) throw new Error('请先连接本机 onPC 数据目录');
      return { dataDirectory: directory.trim() };
    }
    const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (status.state !== 'connected' || !status.settings) throw new Error('请先连接实体控台');
    const { host, port, monitorPort, username } = status.settings;
    return { dataDirectory: '', network: { host, port, monitorPort, username } };
  };
  const guard = (action: () => Promise<void>): void => { void action().catch(error => notify(error instanceof Error ? error.message : String(error), 'error')); };
  const read = async (retry = false): Promise<void> => {
    await scanMa2(await endpoint(), retry);
    if (!useDocumentStore.getState().project?.ma2ReadState?.catalog.incomplete) await importCachedMa2();
  };
  const exportSite = async (): Promise<void> => {
    if (!cached) return;
    const path = await window.tbLink.exportDiagnosticPackage({ ma2Site: {
      catalog: cached.catalog, raw: cached.catalog.entries.flatMap(entry => entry.sourceXml ? [{ target: entry.target, xml: entry.sourceXml }] : []),
      songs: project?.rundown.map(item => ({ id: item.id, title: item.title, p1Media: item.p1Media, referenceAudio: item.referenceAudio, playback: item.playback })) ?? [],
      source: cached.source, pairs: cached.pairs, failures: cached.failures
    } });
    if (path) notify(`现场核对包已导出：${path}`);
  };
  return <section className="settings-section ma2-catalog-settings" aria-label="MA2 现场节目导入">
    <section className="ma2-settings-group">
      <h3>控台灯光</h3>
      <p className="settings-note">读取一次后保存在联动工程。配对、查看和本地编辑在灯光工作台继续。</p>
      <div className="device-actions">
        <Button className="primary-button" disabled={disabled || job.busy || !project} onClick={() => guard(() => read())}>{cached ? '更新控台读取' : '读取控台灯光到现有歌曲'}</Button>
        {cached ? <><Button className="secondary-button" disabled={disabled || job.busy} onClick={() => guard(() => read(true))}>只补读未完成项</Button>
        <Button className="secondary-button" onClick={() => useMa2ReadStore.setState({ openWorkspace: true, browserOpen: true })}>配对与查看 Cue</Button></> : null}
      </div>
      {job.busy ? <><Ma2ReadProgress progress={job.progress} waiting="正在读取控台，切页后继续" /><Button className="secondary-button" onClick={() => guard(async () => { if (job.activeId) await window.tbLink.cancelMa2Read(job.activeId); })}>取消控台读取</Button></> : <p role="status">{cached?.message ?? job.message}</p>}
      {cached && project ? <><p className="settings-note">工程缓存 · {cached.source} · Show：{cached.catalog.directory.show} · {new Date(cached.catalog.readAt).toLocaleString()}（非实时状态）</p>
        {cached.catalog.incomplete ? <p role="alert">{cached.catalog.incomplete}</p> : null}
        <P1LightingImportReport project={project} catalog={cached.catalog} /></> : null}
      {!project?.p1Sync ? <P1ProjectSyncPanel purpose="migration" disabled={disabled || job.busy} notify={notify} afterImport={() => read()} /> : <p className="settings-note">P1 歌曲和原始时间码已保存在工程，无需重新选择 .hia。</p>}
    </section>
    <details className="ma2-advanced-settings"><summary>诊断与手动同步</summary>
      {cached ? <><Button className="secondary-button" disabled={job.busy} onClick={() => guard(exportSite)}>导出现场核对包</Button>
        {cached.catalog.metrics ? <p>本次读取 {(cached.catalog.metrics.elapsedMs / 1000).toFixed(1)} 秒 · {cached.catalog.metrics.requests} 次逻辑请求 · {(cached.catalog.metrics.bytes / 1024).toFixed(0)} KB 解码响应{cached.catalog.metrics.wireCommands !== undefined ? ` · ${cached.catalog.metrics.wireCommands} 条网络命令 · ${((cached.catalog.metrics.receivedBytes ?? 0) / 1024).toFixed(0)} KB 网络接收` : ''}。阶段耗时已保存到核对包。</p> : null}</> : null}
      <Ma2ProgramSync method={method} directory={directory} network={automatic.request?.connection.network ?? null} disabled={disabled || job.busy} notify={notify} onBusy={onBusy} />
      <Button className="secondary-button" disabled={!automatic.request && (disabled || job.busy || !cached)} onClick={() => guard(async () => {
        if (automatic.request) { useMa2AutoSyncStore.setState({ request: null }); return; }
        if (cached) useMa2AutoSyncStore.setState({ request: { catalog: cached.catalog, connection: await endpoint() } });
      })}>{automatic.request ? '关闭自动双向同步' : '启用编辑后自动双向同步'}</Button>
      <p role="status">{automatic.message}</p>
      <p className="settings-note">原生保留时间线不能写回。其他时间线写回前仍须重新读取并比较控台。</p>
    </details>
  </section>;
}
