import { useMa2ModeStore } from '../stores/ma2-mode-store';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { ma2NetworkStatusSchema, type Ma2NetworkTarget } from '@tb/schema';
import type { LightingTimelineProps } from './LightingTimeline';
import { LightingArrangementSettings } from './LightingArrangementSettings';
import { LightingFileActions } from './LightingFileActions';
import { Ma2ProgramSync } from './Ma2ProgramSync';

export type LightingTool = 'tempo' | 'files' | 'sync';
const titles: Record<LightingTool, string> = { tempo: '节拍与循环', files: '导入与导出', sync: '节目同步' };
export function LightingTimelineTools(props: Pick<LightingTimelineProps, 'document' | 'onChange'> & { inline?: boolean; tool: LightingTool; programName: string; disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onClose: () => void }): JSX.Element {
  const method = useMa2ModeStore((state) => state.method);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (props.inline) return; const node = dialog.current; node?.showModal(); return () => node?.close(); }, [props.inline]);
  const content = <section className={props.inline ? "lighting-tools-dialog" : "lighting-tools-dialog settings-inline integration-workspace"}><div className="settings-detail">{!props.inline ? <header><div><h2>{titles[props.tool]}</h2><p>{props.programName}</p></div><button autoFocus disabled={busy} aria-label="关闭灯光工具" onClick={props.onClose}>关闭</button></header> : null}
    <div className="settings-lighting">{props.tool === 'sync' ? method === 'midi' ? <p>当前使用 MIDI 时间码同步，无需扫描或同步控台节目。音频与端口请在设备设置中配置。</p> : <EditorMa2Sync disabled={props.disabled} notify={props.notify} onBusy={setBusy} /> : <fieldset disabled={props.disabled} className="lighting-settings">{props.tool === 'tempo' ? <LightingArrangementSettings document={props.document} onChange={props.onChange} /> : <div className="lighting-tools"><LightingFileActions document={props.document} onChange={props.onChange} notify={props.notify} /></div>}</fieldset>}
  </div></div></section>;
  if (props.inline) return content;
  return createPortal(<dialog ref={dialog} aria-label={titles[props.tool]} className="lighting-tools-backdrop" onCancel={(event) => { event.preventDefault(); if (!busy) props.onClose(); }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) props.onClose(); }}>{content}</dialog>, window.document.body);
}

function EditorMa2Sync(props: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void; onBusy: (busy: boolean) => void }): JSX.Element {
  const [endpoint, setEndpoint] = useState<{ method: 'network' | 'local'; directory: string; network: Ma2NetworkTarget | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async (): Promise<void> => {
      try {
        const directory = localStorage.getItem('tblink.ma2-onpc-data-directory.v1') ?? '';
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
  return endpoint ? <Ma2ProgramSync key={JSON.stringify(endpoint)} {...endpoint} {...props} /> : <p role="status">{error || '读取控台连接状态…'}</p>;
}
