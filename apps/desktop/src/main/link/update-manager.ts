import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { LinkUpdateStatus } from '@tb/core/link';
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
  download: () => Promise<void>;
  install: () => void;
  dispose: () => void;
};

export type UpdateClientFactory = (feedUrl: string, handlers: UpdateClientHandlers) => UpdateClient;

export class LinkUpdateManager {
  private client: UpdateClient | null = null;
  private busy = false;
  private status: LinkUpdateStatus;

  constructor(
    currentVersion: string,
    private readonly packaged: boolean,
    private readonly emit: (status: LinkUpdateStatus) => void,
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
        progress: (info) => this.update({
          phase: 'downloading',
          progressPercent: clampPercent(info.percent),
          transferredBytes: info.transferred,
          totalBytes: info.total,
          message: `正在下载 ${clampPercent(info.percent).toFixed(1)}%`
        }),
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
        progressPercent: null,
        transferredBytes: null,
        totalBytes: null,
        message: '正在检查软件更新…'
      });
      await this.client.check();
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
    this.busy = true;
    this.update({
      phase: 'downloading',
      progressPercent: 0,
      transferredBytes: 0,
      totalBytes: null,
      message: '准备下载更新…'
    });
    try {
      await this.client.download();
    } catch (error) {
      this.update({ phase: 'error', message: normalizeUpdateError(error) });
    } finally {
      this.busy = false;
    }
    return this.getStatus();
  }

  install(): void {
    if (this.busy || !this.client || this.status.phase !== 'downloaded') {
      throw new Error('更新尚未下载完成');
    }
    this.client.install();
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
  const { NsisUpdater } = electronUpdater;
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
    download: async () => {
      await updater.downloadUpdate();
    },
    install: () => updater.quitAndInstall(false, true),
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
    message: packaged ? (feedConfigured ? '可以检查软件更新' : '发行方尚未配置有效的 HTTPS 更新地址') : '开发模式不执行安装更新，请使用 Windows 安装版验证'
  };
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
