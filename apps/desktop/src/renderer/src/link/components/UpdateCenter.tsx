import { Button } from './Button';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinkUpdateStatus } from '@tb/core/link';
import { CheckCircle2, CloudDownload, Download, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';

type UpdateCenterProps = {
  notify: (message: string, tone?: 'info' | 'error') => void;
};

export function UpdateCenter({ notify }: UpdateCenterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LinkUpdateStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.tbLink.getUpdateStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) notify(errorMessage(error), 'error');
      });
    const unsubscribe = window.tbLink.onUpdateStatus((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [notify]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const appShell = document.querySelector<HTMLElement>('.app-shell');
    const previousInert = appShell?.inert ?? false;
    if (appShell) appShell.inert = true;
    if (!dialog.open) dialog.showModal();
    closeButtonRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      if (dialog.open) dialog.close();
      if (appShell) appShell.inert = previousInert;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const run = async (operation: () => Promise<LinkUpdateStatus>, success?: string): Promise<void> => {
    setBusy(true);
    try {
      const next = await operation();
      setStatus(next);
      if (success) notify(success);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const saveToken = async (): Promise<void> => {
    const trimmed = token.trim();
    if (!trimmed) {
      notify('请输入 GitHub 只读 Token', 'error');
      return;
    }
    await run(() => window.tbLink.saveUpdateToken(trimmed), '更新凭证已使用 Windows 加密存储');
    setToken('');
  };

  const clearToken = async (): Promise<void> => {
    await run(() => window.tbLink.clearUpdateToken(), '更新凭证已清除');
    setToken('');
  };

  const install = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.tbLink.installUpdate();
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const phase = status?.phase ?? 'idle';
  const working = busy || phase === 'checking' || phase === 'downloading';
  const icon = phase === 'downloaded' || phase === 'upToDate' ? <CheckCircle2 /> : working ? <LoaderCircle className="spin" /> : <CloudDownload />;

  return <>
    <div className="update-installed-version" aria-live="polite">
      <span>当前安装版本</span>
      <strong>{status?.currentVersion ? `v${status.currentVersion}` : '正在读取…'}</strong>
    </div>
    <Button className="secondary-button update-trigger" title="软件更新" aria-label="软件更新" onClick={() => setOpen(true)}>
      {icon}
      打开软件更新
      {phase === 'available' || phase === 'downloaded' ? <span className="update-badge" /> : null}
    </Button>
    {open ? createPortal(<dialog
      ref={dialogRef}
      className="update-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-center-title"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setOpen(false);
      }}
    >
      <section className="modal-card update-center">
        <header className="update-center-header">
          <div><span className="eyebrow">SOFTWARE UPDATE</span><h2 id="update-center-title">软件更新</h2></div>
          <Button ref={closeButtonRef} className="icon-button" aria-label="关闭软件更新" onClick={() => setOpen(false)}><X /></Button>
        </header>

        <div className={`update-summary phase-${phase}`}>
          <div className="update-summary-icon">{icon}</div>
          <div>
            <strong>{status?.message ?? '正在读取更新状态…'}</strong>
            <span>当前版本 {status?.currentVersion ?? '—'}{status?.availableVersion && status.availableVersion !== status.currentVersion ? ` · 可用版本 ${status.availableVersion}` : ''}</span>
          </div>
        </div>

        {phase === 'downloading' ? <div className="update-progress" aria-label="更新下载进度">
          <div><span style={{ width: `${status?.progressPercent ?? 0}%` }} /></div>
          <small>{formatProgress(status)}</small>
        </div> : null}

        {phase !== 'disabled' ? <div className="update-credential">
          <div className="update-credential-title"><ShieldCheck /><div><strong>私有仓库读取凭证</strong><span>{status?.tokenConfigured ? '已加密保存在本机，不会写入工程或日志' : '仅需配置一次，只授予仓库 Contents 读取权限'}</span></div></div>
          {!status?.tokenConfigured ? <label className="field"><span>GitHub 只读 Token</span><input type="password" autoComplete="off" spellCheck={false} value={token} onChange={(event) => setToken(event.currentTarget.value)} placeholder="github_pat_…" /></label> : null}
          <div className="inline-actions">
            {!status?.tokenConfigured ? <Button className="secondary-button" disabled={working || token.trim().length < 20} onClick={() => void saveToken()}><KeyRound />保存凭证</Button> : <Button className="secondary-button" disabled={working} onClick={() => void clearToken()}><Trash2 />清除凭证</Button>}
          </div>
        </div> : <p className="update-dev-note">开发模式不会执行下载或安装。正式安装包中会启用 GitHub Release 更新。</p>}

        <div className="modal-actions update-actions">
          <Button className="secondary-button" onClick={() => setOpen(false)}>关闭</Button>
          {status?.tokenConfigured && phase !== 'downloaded' && phase !== 'available' && phase !== 'disabled' ? <Button className="primary-button" disabled={working} onClick={() => void run(() => window.tbLink.checkForUpdates())}><RefreshCw />检查更新</Button> : null}
          {phase === 'available' ? <Button className="primary-button" disabled={working} onClick={() => void run(() => window.tbLink.downloadUpdate())}><Download />下载更新</Button> : null}
          {phase === 'downloaded' ? <Button className="primary-button" disabled={busy} onClick={() => void install()}><CloudDownload />重启并安装</Button> : null}
        </div>
      </section>
    </dialog>, document.body) : null}
  </>;
}

function formatProgress(status: LinkUpdateStatus | null): string {
  if (!status) return '0%';
  const percent = status.progressPercent?.toFixed(1) ?? '0.0';
  if (status.transferredBytes === null || status.totalBytes === null) return `${percent}%`;
  return `${percent}% · ${formatBytes(status.transferredBytes)} / ${formatBytes(status.totalBytes)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
