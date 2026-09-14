import { useEffect, useState } from 'react';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';

export function ObsPreviewSetup({ disabled, notify }: {
  disabled: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ready: boolean; message: string } | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (): Promise<void> => {
      try {
        const value = await linkDesktopViewModel.getObsPreviewStatus();
        if (!disposed) setStatus(value);
      } catch (error) {
        if (!disposed) setStatus({ ready: false, message: error instanceof Error ? error.message : String(error) });
      } finally { if (!disposed) timer = setTimeout(() => void refresh(), 1_000); }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  const prepare = async (): Promise<void> => {
    setBusy(true);
    try { setPath(await linkDesktopViewModel.exportObsPreviewScript()); }
    catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  return <div className="settings-field">
    <button className="secondary-button" disabled={disabled || busy} onClick={() => void prepare()}>{busy ? '正在准备…' : '导出 OBS 预览脚本'}</button>
    {status ? <p className="settings-note" role="status">{status.message}</p> : null}
    {path ? <p className="settings-note">在本机 OBS 的“工具 → 脚本”中添加已打开文件夹里的 tblink_preview.lua（仅首次需要）。之后编辑器自动预览，播放时才切换正式画面。<br />{path}</p> : null}
  </div>;
}
