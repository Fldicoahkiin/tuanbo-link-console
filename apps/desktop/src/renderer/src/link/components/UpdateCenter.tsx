import { useEffect, useState } from 'react';
import { CloudDownload, Download, RefreshCw } from 'lucide-react';
import type { LinkAppInfo, LinkReleaseChannel, LinkUpdatePhase, LinkUpdateStatus } from '@tb/core/link';
import { bundledReleaseNotes } from '../release-notes';
import { Button, Card, Notice, Progress, StatusBadge } from '../ui';
import type { ConnectionStatus } from '../view-models/connection-status';
import { ReleaseNotes } from './ReleaseNotes';

const CHANNEL_LABEL: Record<LinkReleaseChannel, string> = { release: '正式版', development: '开发版' };

type UpdateCenterProps = {
  runtimeActive?: boolean;
  notify: (message: string, tone?: 'info' | 'error') => void;
};

/** What the badge next to the update message says for each phase. */
function phaseStatus(phase: LinkUpdatePhase): ConnectionStatus {
  switch (phase) {
    case 'upToDate': return { state: 'ready', value: '已是最新', detail: '当前已经是最新版本' };
    case 'downloaded': return { state: 'ready', value: '可以安装', detail: '新版本已下载，重启后安装' };
    case 'available': return { state: 'warning', value: '有新版本', detail: '可以下载新版本' };
    case 'checking': return { state: 'checking', value: '检查中', detail: '正在检查更新' };
    case 'downloading': return { state: 'checking', value: '下载中', detail: '正在下载更新' };
    case 'error': return { state: 'error', value: '出错', detail: '更新出错了' };
    case 'disabled': return { state: 'skipped', value: '开发模式', detail: '开发模式不下载更新' };
    case 'notConfigured': return { state: 'skipped', value: '未配置', detail: '没有配置更新源' };
    case 'idle': return { state: 'idle', value: '未检查', detail: '还没检查更新' };
  }
}

/** 软件更新: the installed version, checking, downloading and installing updates, and the release notes. */
export function UpdateCenter({ notify, runtimeActive = false }: UpdateCenterProps): JSX.Element {
  const [status, setStatus] = useState<LinkUpdateStatus | null>(null);
  const [build, setBuild] = useState<LinkAppInfo | null>(null);
  const [buildFailure, setBuildFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.tbLink.getUpdateStatus()
      .then((next) => { if (!cancelled) setStatus(next); })
      .catch((error: unknown) => { if (!cancelled) { setFailure(errorMessage(error)); notify(errorMessage(error), 'error'); } });
    void window.tbLink.getAppInfo()
      .then((info) => { if (!cancelled) setBuild(info); })
      .catch((error: unknown) => { if (!cancelled) setBuildFailure(`版本信息读取失败：${errorMessage(error)}`); });
    const unsubscribe = window.tbLink.onUpdateStatus((next) => { if (!cancelled) setStatus(next); });
    return () => { cancelled = true; unsubscribe(); };
  }, [notify]);

  const run = async (operation: () => Promise<LinkUpdateStatus>): Promise<void> => {
    setBusy(true); setFailure('');
    try { setStatus(await operation()); }
    catch (error) { setFailure(errorMessage(error)); notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  };
  const install = async (): Promise<void> => {
    setBusy(true); setFailure('');
    try { await window.tbLink.installUpdate(); }
    catch (error) { setFailure(errorMessage(error)); notify(errorMessage(error), 'error'); }
    finally { setBusy(false); }
  };

  const phase = status?.phase ?? 'idle';
  const working = busy || phase === 'checking' || phase === 'downloading';
  const offered = phase === 'available' || phase === 'downloading' || phase === 'downloaded';
  const canCheck = status?.feedConfigured && phase !== 'downloaded' && phase !== 'disabled' && (phase !== 'available' || status.installBlockedReason);
  return <div className="settings-stack update-center">
    <Card title={status?.message ?? '正在读取更新状态…'} description={`当前版本 ${status?.currentVersion ?? '—'}${status?.availableVersion && offered ? ` · 可用版本 ${status.availableVersion}` : ''}`}
      actions={status ? <StatusBadge name="软件更新" status={phaseStatus(phase)} /> : null}>
      {build ? <p className="update-build-identity" title={`${build.name} ${build.version} · 提交 ${build.gitSha ?? '未知'} · ${build.appId}`}>
        {build.name} · {CHANNEL_LABEL[build.channel]} · 提交 {build.gitSha ? shortRevision(build.gitSha) : '未知'} · {build.appId}
      </p> : buildFailure ? <Notice tone="error">{buildFailure}</Notice> : null}
      {phase === 'downloading' ? <Progress label="更新下载进度" title="正在下载更新" status={formatProgress(status)} value={status?.progressPercent ?? 0} max={100} /> : null}
      <p>{phase === 'disabled' ? '开发模式不会下载或安装更新，请用 Windows 安装版测试更新。' : '下载完成后要重启软件来安装，请先停止联动并保存工程。'}</p>
      {status?.installBlockedReason && (phase === 'available' || phase === 'downloaded') ? <Notice tone="warning">{status.installBlockedReason}</Notice> : null}
      {failure ? <Notice tone="error" title={failure}>请检查网络后再试一次。</Notice> : null}
      {runtimeActive ? <Notice>播放时不会下载或安装更新，停止播放后再操作。</Notice> : null}
      <div className="settings-actions-row">
        {canCheck ? <Button variant="primary" icon={RefreshCw} loading={working} disabled={working} onClick={() => void run(() => window.tbLink.checkForUpdates())}>检查更新</Button> : null}
        {phase === 'available' && !status?.installBlockedReason ? <Button variant="primary" icon={Download} disabled={working || runtimeActive} onClick={() => void run(() => window.tbLink.downloadUpdate())}>下载更新</Button> : null}
        {phase === 'downloaded' ? <Button variant="primary" icon={CloudDownload} disabled={busy || runtimeActive} onClick={() => void install()}>重启并安装</Button> : null}
        {!status && failure ? <Button variant="secondary" onClick={() => void run(() => window.tbLink.getUpdateStatus())}>重新读取更新状态</Button> : null}
      </div>
    </Card>
    <ReleaseNotes notes={bundledReleaseNotes} currentVersion={status?.currentVersion ?? null} availableVersion={offered ? status?.availableVersion ?? null : null} />
  </div>;
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
