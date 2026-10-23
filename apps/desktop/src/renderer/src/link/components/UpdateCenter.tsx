import { Button } from './Button';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LinkAppInfo, LinkReleaseChannel, LinkUpdateStatus } from '@tb/core/link';
import { CheckCircle2, CloudDownload, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';

const CHANNEL_LABEL: Record<LinkReleaseChannel, string> = { release: '正式版', test: '测试版', internal: '内测版', development: '开发版' };

type UpdateCenterProps = {
  inline?: boolean;
  runtimeActive?: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

export function UpdateCenter({ notify, inline = false, runtimeActive = false }: UpdateCenterProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<LinkUpdateStatus | null>(null);
  const [build, setBuild] = useState<LinkAppInfo | null>(null);
  const [buildFailure, setBuildFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void window.tbLink.getUpdateStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) { setFailure(errorMessage(error)); notify(errorMessage(error), 'error'); }
      });
    void window.tbLink.getAppInfo()
      .then((info) => { if (!cancelled) setBuild(info); })
      .catch((error: unknown) => { if (!cancelled) setBuildFailure(`版本信息读取失败：${errorMessage(error)}`); });
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
    setBusy(true); setFailure('');
    try {
      const next = await operation();
      setStatus(next);
      if (success) notify(success);
    } catch (error) {
      setFailure(errorMessage(error)); notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const install = async (): Promise<void> => {
    setBusy(true); setFailure('');
    try {
      await window.tbLink.installUpdate();
    } catch (error) {
      setFailure(errorMessage(error)); notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  const phase = status?.phase ?? 'idle';
  const working = busy || phase === 'checking' || phase === 'downloading';
  const icon = phase === 'downloaded' || phase === 'upToDate' ? <CheckCircle2 /> : working ? <LoaderCircle className="spin" /> : <CloudDownload />;

  const content = <>
        <div className={`update-summary phase-${phase}`}>
          <div className="update-summary-icon">{icon}</div>
          <div>
            <strong>{status?.message ?? '正在读取更新状态…'}</strong>
            <span>当前版本 {status?.currentVersion ?? '—'}{status?.availableVersion && (phase === 'available' || phase === 'downloading' || phase === 'downloaded') ? ` · 可用版本 ${status.availableVersion}` : ''}</span>
          </div>
        </div>

        {build ? <p className="update-build-identity" title={`${build.name} ${build.version} · 提交 ${build.gitSha ?? '未知'} · ${build.appId}`}>
          {build.name} · {CHANNEL_LABEL[build.channel]} · 提交 {build.gitSha ? shortRevision(build.gitSha) : '未知'} · {build.appId}
        </p> : buildFailure ? <p className="device-error" role="alert">{buildFailure}</p> : null}

        {phase === 'downloading' ? <div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status?.progressPercent ?? 0}>
          <div><span style={{ width: `${status?.progressPercent ?? 0}%` }} /></div>
          <small>{formatProgress(status)}</small>
        </div> : null}

        <p className="update-dev-note">{phase === 'disabled' ? '开发模式不会执行下载或安装，请使用 Windows 安装版验证更新。' : '更新由发行方提供。下载后需确认重启安装，请先停止联动并保存工程。'}</p>

        {status?.installBlockedReason && (phase === 'available' || phase === 'downloaded') ? <p className="settings-note" role="status">{status.installBlockedReason}</p> : null}
        {failure ? <p className="device-error" role="alert">{failure} 请检查网络后重新操作。</p> : null}
        {runtimeActive ? <p className="settings-note">播放中不下载、不安装更新；停止播放后再操作。</p> : null}
        <div className="modal-actions update-actions">
          {!inline ? <Button className="secondary-button" onClick={() => setOpen(false)}>关闭</Button> : null}
          {status?.feedConfigured && phase !== 'downloaded' && phase !== 'disabled' && (phase !== 'available' || status.installBlockedReason) ? <Button className="primary-button" disabled={working} onClick={() => void run(() => window.tbLink.checkForUpdates())}><RefreshCw />检查更新</Button> : null}
          {phase === 'available' && !status?.installBlockedReason ? <Button className="primary-button" disabled={working || runtimeActive} onClick={() => void run(() => window.tbLink.downloadUpdate())}><Download />下载更新</Button> : null}
          {phase === 'downloaded' ? <Button className="primary-button" disabled={busy || runtimeActive} onClick={() => void install()}><CloudDownload />重启并安装</Button> : null}
        </div>
  </>;
  if (inline) return <div className="update-center">{content}{!status && failure ? <Button onClick={() => void run(() => window.tbLink.getUpdateStatus())}>重新读取更新状态</Button> : null}</div>;

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

        {content}
      </section>
    </dialog>, document.body) : null}
  </>;
}

/** 12 characters identify a commit in this repository; a dirty marker stays visible. */
function shortRevision(revision: string): string {
  return revision.endsWith('-dirty') ? `${revision.slice(0, 12)}-dirty` : revision.slice(0, 12);
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
