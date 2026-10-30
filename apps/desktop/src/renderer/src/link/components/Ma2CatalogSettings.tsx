import { SettingsDisclosure } from './SettingsControls';
import { useEffect } from 'react';
import { ma2NetworkStatusSchema, type Ma2CatalogRequest } from '@tb/schema';
import { Button } from '../ui/Button';
import { Ma2ReadProgress } from './Ma2ReadProgress';
import { useDocumentStore } from '../stores/document-store';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { prepareMa2Editing } from '../runtime/ma2-editing-session';
import { P1ProjectSyncPanel } from './P1ProjectSyncPanel';
import { P1LightingImportReport } from './P1LightingImportReport';
import { Ma2ProgramSync } from './Ma2ProgramSync';
import { useMa2SyncStore } from '../stores/ma2-sync-store';

export function Ma2CatalogSettings({ method, directory, disabled, notify, onBusy, connected }: { connected: boolean; onBusy: (busy: boolean) => void; method: 'local' | 'network'; directory: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const cached = project?.ma2ReadState;
  const job = useMa2ReadStore();
  const session = useMa2SyncStore(state => state.session);
  useEffect(() => { onBusy(job.busy); return () => onBusy(false); }, [job.busy, onBusy]);
  const endpoint = async (): Promise<Ma2CatalogRequest> => {
    if (method === 'local') {
      if (!directory.trim()) throw new Error('请先选择本机 onPC 的数据目录');
      return { dataDirectory: directory.trim() };
    }
    const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
    if (status.state !== 'connected' || !status.settings) throw new Error('请先连接实体控台');
    const { host, port, monitorPort, username } = status.settings;
    return { dataDirectory: '', network: { host, port, monitorPort, username } };
  };
  const guard = (action: () => Promise<void>): void => { void action().catch(error => notify(error instanceof Error ? error.message : String(error), 'error')); };
  const read = async (retry = false): Promise<void> => {
    const documentId = useDocumentStore.getState().documentId;
    notify(await prepareMa2Editing(await endpoint(), documentId, true, retry));
  };
  const exportSite = async (): Promise<void> => {
    if (!cached) throw new Error('这个工程还没有从控台读取过数据。连接控台读取一次后就能导出。');
    const path = await window.tbLink.exportDiagnosticPackage({ ma2Site: {
      catalog: cached.catalog, raw: cached.catalog.entries.flatMap(entry => entry.sourceXml ? [{ target: entry.target, xml: entry.sourceXml }] : []),
      songs: project?.rundown.map(item => ({ id: item.id, title: item.title, p1Media: item.p1Media, referenceAudio: item.referenceAudio, playback: item.playback })) ?? [],
      source: cached.source, pairs: cached.pairs, pairings: cached.pairings, failures: cached.failures,
      materialLibrary: project?.ma2MaterialLibrary, readInProgress: job.busy
    } });
    if (path) notify(`控台数据包已导出：${path}`);
  };
  return <section className="settings-section ma2-catalog-settings" aria-label="MA2 现场节目导入">
    <section className="ma2-settings-group">
      <h3>控台灯光</h3>
      <p className="settings-note">{!project ? '打开工程后，可以把控台 Cue 读到歌曲里。' : !connected ? '连接控台后，可读取节目 Cue。' : '读取结果保存在工程中，歌曲按 MTC 起始码自动对上控台时间线，可到灯光工作台编辑。'}</p>
      <p role={session.status === 'blocked' ? 'alert' : 'status'}>{session.message}</p>
      <div className="device-actions">
        <Button className={connected ? "primary-button" : "secondary-button"} disabled={disabled || job.busy || !project || !connected} onClick={() => guard(() => read())}>{cached ? '更新控台读取' : '读取控台灯光到现有歌曲'}</Button>
        {cached ? <><Button className="secondary-button" disabled={disabled || job.busy} onClick={() => guard(() => read(true))}>只补读未完成项</Button>
        <Button className="secondary-button" onClick={() => useMa2ReadStore.setState({ openWorkspace: true, browserOpen: true })}>查看控台时间线</Button></> : null}
        <Button className="secondary-button" disabled={!cached} onClick={() => guard(exportSite)}>导出控台数据包</Button>
      </div>
      <p className="settings-note">数据包里有已读取的原始 XML、歌曲时间码、配对和读取记录，不需要再扫描一次。{!cached ? '读取一条后即可导出。' : job.busy ? '读取过程中可以导出已经完成的部分。' : ''}</p>
      {job.busy ? <><Ma2ReadProgress progress={job.progress} waiting="正在读取控台，切换页面不会中断" /><Button className="secondary-button" onClick={() => guard(async () => { if (job.activeId) await window.tbLink.cancelMa2Read(job.activeId); })}>取消控台读取</Button></> : <p role="status">{cached?.message ?? job.message}</p>}
      {cached && project ? <><p className="settings-note">工程缓存 · {cached.source} · Show：{cached.catalog.directory.show} · {new Date(cached.catalog.readAt).toLocaleString()}（非实时状态）</p>
        {cached.catalog.incomplete ? <p role="alert">{cached.catalog.incomplete}</p> : null}
        <P1LightingImportReport project={project} catalog={cached.catalog} /></> : null}
      {!project?.p1Sync ? <SettingsDisclosure title="从 P1 工程导入歌曲" description="已有 P1 歌曲时，导入歌曲和原始时间码"><P1ProjectSyncPanel purpose="migration" disabled={disabled || job.busy} notify={notify} afterImport={() => read()} /></SettingsDisclosure> : <p className="settings-note">P1 歌曲和原始时间码已保存在工程，无需重新选择 .hia。</p>}
    </section>
    <details className="ma2-advanced-settings"><summary>诊断与手动同步</summary>
      {cached?.catalog.metrics ? <p>本次读取 {(cached.catalog.metrics.elapsedMs / 1000).toFixed(1)} 秒 · {cached.catalog.metrics.requests} 次请求 · {(cached.catalog.metrics.bytes / 1024).toFixed(0)} KB 数据{cached.catalog.metrics.wireCommands !== undefined ? ` · ${cached.catalog.metrics.wireCommands} 条网络命令 · ${((cached.catalog.metrics.receivedBytes ?? 0) / 1024).toFixed(0)} KB 网络接收` : ''}。各阶段耗时已保存到数据包。</p> : null}
      <Ma2ProgramSync method={method} directory={directory} network={null} disabled={disabled || job.busy} notify={notify} onBusy={onBusy} />
      <p className="settings-note">联动台不转换的控台动作，写回时保持控台原样。写回前仍要先重新读取并和控台比对。</p>
    </details>
  </section>;
}
