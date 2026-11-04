import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { ma2NetworkStatusSchema, type Ma2NetworkTarget } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { LightingArrangementSettings } from './LightingArrangementSettings';
import { LightingFileActions } from './LightingFileActions';
import { Ma2ProgramSync } from './Ma2ProgramSync';
import { Dialog, IconButton } from '../ui';
import './lighting-tools.css';

export type LightingTool = 'tempo' | 'files' | 'sync';
const titles: Record<LightingTool, string> = { tempo: '节拍与循环', files: '导入与导出', sync: '节目同步' };
export function LightingTimelineTools(props: Pick<LightingTimelineProps, 'document' | 'onChange'> & { inline?: boolean; tool: LightingTool; programName: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onClose: () => void }): JSX.Element {
  const method = useMa2ModeStore((state) => state.method);
  const [busy, setBusy] = useState(false);
  const close = (): void => { if (!busy) props.onClose(); };
  const body = props.tool === 'sync'
    ? method === 'midi' ? <p className="lighting-tool-note">当前用 MIDI 时间码同步，不需要扫描或同步控台节目。音频和端口请在设备设置里配置。</p> : <EditorMa2Sync disabled={props.disabled} notify={props.notify} onBusy={setBusy} />
    : <fieldset disabled={props.disabled} className="lighting-tool-fields">{props.tool === 'tempo' ? <LightingArrangementSettings document={props.document} onChange={props.onChange} /> : <LightingFileActions document={props.document} onChange={props.onChange} notify={props.notify} />}</fieldset>;
  // In the lighting workbench the tool takes the library's place; in the editor it is a window.
  if (props.inline) return <section className="lighting-tool-panel" aria-label={titles[props.tool]}>
    <header><div><h2>{titles[props.tool]}</h2><p>{props.programName}</p></div><IconButton label="关闭灯光工具" icon={X} disabled={busy} onClick={props.onClose} /></header>
    <div className="lighting-tool-body">{body}</div>
  </section>;
  return <Dialog size="lg" title={titles[props.tool]} description={props.programName} closeLabel="关闭灯光工具" onClose={close}><div className="lighting-tool-body">{body}</div></Dialog>;
}

function EditorMa2Sync(props: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void }): JSX.Element {
  const [endpoint, setEndpoint] = useState<{ method: 'network' | 'local'; directory: string; network: Ma2NetworkTarget | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const directory = (await window.tbLink.getMa2DataDirectory()) ?? '';
        const savedMethod = localStorage.getItem('tblink.ma2-connection-method.v1');
        const method = savedMethod === 'local' || !savedMethod && directory ? 'local' : 'network';
        const status = ma2NetworkStatusSchema.parse(await window.tbLink.getMa2NetworkStatus());
        const settings = status.settings;
        const network = status.state === 'connected' && settings ? { host: settings.host, port: settings.port, monitorPort: settings.monitorPort, username: settings.username } : null;
        if (!alive) return;
        const next = { method, directory, network } as const;
        setEndpoint((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
        timer = setTimeout(() => void read(), 1000);
      } catch (failure) { if (alive) { setEndpoint(null); setError(failure instanceof Error ? failure.message : String(failure)); } }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, []);
  return endpoint ? <Ma2ProgramSync key={JSON.stringify(endpoint)} {...endpoint} {...props} /> : <p role="status">{error || '正在读取控台连接状态…'}</p>;
}
