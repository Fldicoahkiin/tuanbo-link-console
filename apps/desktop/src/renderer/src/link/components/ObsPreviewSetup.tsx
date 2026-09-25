import { Button } from './Button';
import { useState } from 'react';
import { Wrench } from 'lucide-react';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { useConnectionCheckStore } from '../stores/connection-check-store';

export function ObsPreviewSetup({ disabled, notify, beforeRepair }: {
  disabled: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
  beforeRepair: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ready: boolean; message: string } | null>(null);
  const prepare = async (): Promise<void> => {
    if (busy || disabled) return;
    setBusy(true); setStatus(null);
    try {
      await beforeRepair();
      await linkDesktopViewModel.repairObsBridge();
      setStatus({ ready: true, message: '组件已就绪，真实画面检查通过。' });
      useConnectionCheckStore.getState().finish('preview', 'ready', '组件已就绪，真实画面检查通过');
      notify('OBS 内置组件检查完成。');
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus({ ready: false, message }); notify(message, 'error');
      useConnectionCheckStore.getState().finish('preview', 'error', message);
    }
    finally { setBusy(false); }
  };
  return <div className="settings-field">
    <h3>内置预览组件</h3>
    <p className="settings-note">随联动台提供，自动安装与升级。需要 Windows 授权或重启 OBS 时，软件会引导完成。</p>
    <Button className="secondary-button" disabled={disabled || busy} onClick={() => void prepare()}><Wrench />{busy ? '正在检查组件…' : '检查并修复组件'}</Button>
    {status ? <p className={status.ready ? 'settings-note' : 'device-error'} role={status.ready ? 'status' : 'alert'}>{status.message}</p> : null}
  </div>;
}
