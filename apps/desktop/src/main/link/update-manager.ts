import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { LinkUpdateStatus } from '@tb/core/link';
import type { LicenseStatus } from '@tb/schema';
import { dirname } from 'node:path';

import desktopPackage from '../../../package.json';

const UPDATE_FEED = desktopPackage.build.publish.url;

export type UpdateClientHandlers = {
  checking: () => void;
  available: (info: UpdateInfo) => void;
  notAvailable: (info: UpdateInfo) => void;
  progress: (info: ProgressInfo) => void;
  downloaded: (info: UpdateInfo) => void;
  error: (error: Error) => void;
};

export type UpdateClient = {
  check: () => Promise<void>;
  /** Rejects once `signal` aborts. */
  download: (signal: AbortSignal) => Promise<void>;
  install: () => void;
  dispose: () => void;
};

export type UpdateClientFactory = (feedUrl: string, handlers: UpdateClientHandlers) => UpdateClient;

/** Conditions owned by the rest of the app that decide what the updater may do. */
export type UpdateRules = {
  /** Playback owns the network and disk: no update download runs while it is active. */
  playbackActive: () => boolean;
  /** Read again before each download and install: the license can change while the app runs. */
  license: () => Promise<LicenseStatus>;
};

export class LinkUpdateManager {
  private client: UpdateClient | null = null;
  private busy = false;
  private activeDownload: AbortController | null = null;
  private status: LinkUpdateStatus;

  constructor(
    currentVersion: string,
    private readonly packaged: boolean,
    private readonly emit: (status: LinkUpdateStatus) => void,
    private readonly rules: UpdateRules,
    private readonly createClient: UpdateClientFactory = createElectronUpdateClient,
    private readonly feedUrl: string = UPDATE_FEED
  ) {
    this.status = initialStatus(currentVersion, packaged, feedUrl);
  }

  getStatus(): LinkUpdateStatus {
    return { ...this.status };
  }

  async check(): Promise<LinkUpdateStatus> {
    if (!this.packaged || !this.status.feedConfigured) return this.getStatus();
    if (this.busy || this.status.phase === 'downloaded') throw new Error('请先完成当前更新操作');
    this.busy = true;
    this.client?.dispose();
    try {
      this.client = this.createClient(this.feedUrl, {
        checking: () => this.update({ phase: 'checking', message: '正在检查软件更新…' }),
        available: (info) => this.update({
          phase: 'available',
          availableVersion: info.version,
          releaseDate: info.releaseDate ?? null,
          installBlockedReason: null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          message: `发现新版本 ${info.version}`
        }),
        notAvailable: (info) => this.update({
          phase: 'upToDate',
          availableVersion: info.version,
          releaseDate: info.releaseDate ?? null,
          progressPercent: null,
          transferredBytes: null,
          totalBytes: null,
          message: '当前已经是最新版本'
        }),
        progress: (info) => {
          if (this.activeDownload && this.rules.playbackActive()) { this.activeDownload.abort(); return; }
          this.update({
            phase: 'downloading',
            progressPercent: clampPercent(info.percent),
            transferredBytes: info.transferred,
            totalBytes: info.total,
            message: `正在下载 ${clampPercent(info.percent).toFixed(1)}%`
          });
        },
        downloaded: (info) => this.update({
          phase: 'downloaded',
          availableVersion: info.version,
          releaseDate: info.releaseDate ?? null,
          progressPercent: 100,
          message: `版本 ${info.version} 已下载，确认后重启安装`
        }),
        error: (error) => this.update({ phase: 'error', message: normalizeUpdateError(error) })
      });
      this.update({
        phase: 'checking',
        feedConfigured: true,
        availableVersion: null,
        releaseDate: null,
        installBlockedReason: null,
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        message: '正在检查软件更新…'
      });
      await this.client.check();
      if (this.status.phase === 'available') await this.checkEntitlement();
    } catch (error) {
      this.update({ phase: 'error', message: normalizeUpdateError(error) });
    } finally {
      this.busy = false;
    }
    return this.getStatus();
  }

  async download(): Promise<LinkUpdateStatus> {
    if (this.busy || !this.client || this.status.phase !== 'available') {
      throw new Error('当前没有可下载的更新');
    }
    if (this.rules.playbackActive()) throw new Error('播放中不下载更新，停止播放后再下载');
    this.busy = true;
    try {
      const blocked = await this.checkEntitlement();
      if (blocked) throw new Error(blocked);
    } catch (error) {
      this.busy = false;
      throw error;
    }
    const download = new AbortController();
    this.activeDownload = download;
    this.update({
      phase: 'downloading',
      progressPercent: 0,
      transferredBytes: 0,
      totalBytes: null,
      message: '准备下载更新…'
    });
    try {
      await this.client.download(download.signal);
    } catch (error) {
      if (download.signal.aborted) {
        this.update({ phase: 'available', progressPercent: null, transferredBytes: null, totalBytes: null,
          message: '播放已开始，更新下载已停止；停止播放后可重新下载' });
      } else this.update({ phase: 'error', message: normalizeUpdateError(error) });
    } finally {
      this.activeDownload = null;
      this.busy = false;
    }
    return this.getStatus();
  }

  /** Confirms a downloaded update may be installed; run before the quit flow starts. */
  async prepareInstall(): Promise<void> {
    if (this.busy || !this.client || this.status.phase !== 'downloaded') throw new Error('更新尚未下载完成');
    const blocked = await this.checkEntitlement();
    if (blocked) throw new Error(blocked);
  }

  /** Starts the installer; throws when it cannot start, and the app must then stay open. */
  install(): void {
    if (this.busy || !this.client || this.status.phase !== 'downloaded') {
      throw new Error('更新尚未下载完成');
    }
    this.client.install();
  }

  private async checkEntitlement(): Promise<string | null> {
    const blocked = updateEntitlementIssue(await this.rules.license(), this.status.availableVersion, this.status.releaseDate);
    if (blocked !== this.status.installBlockedReason) this.update({ installBlockedReason: blocked });
    return blocked;
  }

  private update(update: Partial<LinkUpdateStatus>): LinkUpdateStatus {
    this.status = { ...this.status, ...update };
    return this.publish();
  }

  private publish(): LinkUpdateStatus {
    const snapshot = this.getStatus();
    this.emit(snapshot);
    return snapshot;
  }
}

function createElectronUpdateClient(feedUrl: string, handlers: UpdateClientHandlers): UpdateClient {
  const { NsisUpdater, CancellationToken } = electronUpdater;
  const updater = new NsisUpdater({
    provider: 'generic',
    url: feedUrl
  });
  // NSIS 的 /D 参数用于覆盖默认目录。显式沿用当前可执行文件目录，
  // 防止自动更新把用户选择的安装位置迁移到默认目录。
  updater.installDirectory = dirname(process.execPath);
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  // 保留完整安装包更新路径；差分下载需另行完成 Windows 验收后启用。
  updater.disableDifferentialDownload = true;
  updater.logger = null;

  updater.on('checking-for-update', handlers.checking);
  updater.on('update-available', handlers.available);
  updater.on('update-not-available', handlers.notAvailable);
  updater.on('download-progress', handlers.progress);
  updater.on('update-downloaded', handlers.downloaded);
  updater.on('error', handlers.error);

  return {
    check: async () => {
      await updater.checkForUpdates();
    },
    download: async (signal) => {
      const cancellation = new CancellationToken();
      signal.addEventListener('abort', () => cancellation.cancel(), { once: true });
      await updater.downloadUpdate(cancellation);
    },
    install: () => {
      // quitAndInstall reports a failure to start the installer only through a synchronous
      // 'error' event; it quits the app on its own once the installer started.
      const started: { failure: Error | null } = { failure: null };
      const capture = (error: Error): void => { started.failure = error; };
      updater.once('error', capture);
      try {
        updater.quitAndInstall(false, true);
      } finally {
        updater.removeListener('error', capture);
      }
      if (started.failure) throw started.failure;
    },
    dispose: () => {
      updater.removeListener('checking-for-update', handlers.checking);
      updater.removeListener('update-available', handlers.available);
      updater.removeListener('update-not-available', handlers.notAvailable);
      updater.removeListener('download-progress', handlers.progress);
      updater.removeListener('update-downloaded', handlers.downloaded);
      updater.removeListener('error', handlers.error);
    }
  };
}

function initialStatus(currentVersion: string, packaged: boolean, feedUrl: string): LinkUpdateStatus {
  const feedConfigured = validFeedUrl(feedUrl);
  return {
    phase: packaged ? (feedConfigured ? 'idle' : 'notConfigured') : 'disabled',
    currentVersion,
    availableVersion: null,
    releaseDate: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    feedConfigured,
    installBlockedReason: null,
    message: packaged ? (feedConfigured ? '可以检查软件更新' : '发行方尚未配置有效的 HTTPS 更新地址') : '开发模式不执行安装更新，请使用 Windows 安装版验证'
  };
}

/** Why this machine may not install the release, or null. The release date comes from latest.yml,
 * whose digest the release manifest records; the license is the signed claim on this machine. */
function updateEntitlementIssue(license: LicenseStatus, version: string | null, releaseDate: string | null): string | null {
  if (license.state !== 'active' || !license.claims) return `本机授权当前不可用（${license.message}），可以查看新版本，恢复授权后再安装`;
  const released = releaseDate === null ? Number.NaN : Date.parse(releaseDate);
  if (!Number.isFinite(released)) return '更新信息没有有效的发布日期，无法确认是否在升级服务期内，不能安装；请联系发行方';
  if (released <= Date.parse(license.claims.updatesUntil)) return null;
  return `新版本 ${version ?? ''} 发布于 ${utcDate(released)}，晚于本机授权的升级服务期限 ${utcDate(Date.parse(license.claims.updatesUntil))}；可以继续使用当前版本，续费延长升级服务后再安装`;
}

function utcDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function validFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith('/');
  } catch {
    return false;
  }
}

function normalizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403/i.test(message)) return '更新服务拒绝访问，请联系发行方';
  if (/404|not found|latest version/i.test(message)) return '更新服务尚未发布可用的正式版本';
  return `更新失败：${message}`;
}
