import { Button, Notice } from '../ui';
import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useConnectionCheckStore } from '../stores/connection-check-store';
import { useLiveConnectionChecks } from '../useStatusCenter';

export function ObsPreviewSetup({ disabled, notify, beforeRepair }: {
  disabled: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
  beforeRepair: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const status = useLiveConnectionChecks().preview;
  const prepare = async (): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true); useConnectionCheckStore.getState().checking('preview');
    try {
      await beforeRepair();
      await linkDesktopViewModel.repairObsBridge();
      useConnectionCheckStore.getState().finish('preview', 'ready', '组件已就绪，画面检查通过');
      notify('OBS 内置组件检查完成。');
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(message, 'error');
      useConnectionCheckStore.getState().finish('preview', 'error', message);
    }
    finally { setBusy(false); }
  };
  return <>
    <p>检查联动台的预览组件，自动安装或修复。需要 Windows 授权或重启 OBS 时，会一步步带你完成。</p>
    <div className="settings-actions-row"><Button variant="secondary" icon={Wrench} loading={busy} disabled={disabled || busy} onClick={() => void prepare()}>{busy ? '正在检查组件…' : '检查并修复组件'}</Button></div>
    {status ? <Notice tone={status.state === 'error' ? 'error' : status.state === 'ready' ? 'success' : status.state === 'checking' ? 'busy' : 'info'}>{status.detail}</Notice> : null}
  </>;
}
