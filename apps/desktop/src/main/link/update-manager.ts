import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { LinkUpdateStatus } from '@tb/core/link';
import { dirname } from 'node:path';

const UPDATE_OWNER = 'JinHe9527';
const UPDATE_REPOSITORY = 'tuanbo-yijianchufa';

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

export type UpdateClientFactory = (token: string, handlers: UpdateClientHandlers) => UpdateClient;

export class LinkUpdateManager {
  private client: UpdateClient | null = null;
  private tokenForRedaction: string | null = null;
  private status: LinkUpdateStatus;

  constructor(
    currentVersion: string,
    private readonly packaged: boolean,
    private readonly emit: (status: LinkUpdateStatus) => void,
    private readonly createClient: UpdateClientFactory = createElectronUpdateClient
  ) {
    this.status = initialStatus(currentVersion, packaged);
  }

  getStatus(): LinkUpdateStatus {
    return { ...this.status };
  }

  setTokenConfigured(configured: boolean): LinkUpdateStatus {
    this.client?.dispose();
    this.client = null;
    this.tokenForRedaction = null;
    this.status = {
      ...this.status,
      phase: this.packaged ? (configured ? 'idle' : 'notConfigured') : 'disabled',
      availableVersion: null,
      releaseDate: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      tokenConfigured: configured,
      message: this.packaged
        ? configured
          ? '可以检查 GitHub 私有发布更新'
          : '请先配置只读 GitHub Token'
        : '开发模式不执行安装更新，请使用 Windows 安装版验证'
    };
    return this.publish();
  }

  async check(token: string | null): Promise<LinkUpdateStatus> {
    if (!this.packaged) return this.setTokenConfigured(token !== null);
    if (token === null) return this.setTokenConfigured(false);

    this.client?.dispose();
    this.tokenForRedaction = token;
    this.client = this.createClient(token, {
      checking: () => this.update({ phase: 'checking', message: '正在检查 GitHub Release…' }),
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
      error: (error) => this.update({ phase: 'error', message: normalizeUpdateError(error, token) })
    });
    this.update({
      phase: 'checking',
      tokenConfigured: true,
      availableVersion: null,
      releaseDate: null,
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: '正在检查 GitHub Release…'
    });
    try {
      await this.client.check();
    } catch (error) {
      this.update({ phase: 'error', message: normalizeUpdateError(error, token) });
    }
    return this.getStatus();
  }

  async download(): Promise<LinkUpdateStatus> {
    if (!this.client || this.status.phase !== 'available') {
      throw new Error('当前没有可下载的更新');
    }
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
      this.update({ phase: 'error', message: normalizeUpdateError(error, this.tokenForRedaction) });
    }
    return this.getStatus();
  }

  install(): void {
    if (!this.client || this.status.phase !== 'downloaded') {
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

function createElectronUpdateClient(token: string, handlers: UpdateClientHandlers): UpdateClient {
  const { NsisUpdater } = electronUpdater;
  const updater = new NsisUpdater({
    provider: 'github',
    owner: UPDATE_OWNER,
    repo: UPDATE_REPOSITORY,
    private: true,
    token
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
  // PrivateGitHubProvider exposes assets through numeric API URLs, so its generic
  // blockmap URL derivation cannot address the separately uploaded blockmap asset.
  // Use the checksum-verified full NSIS package as the single update path.
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

function initialStatus(currentVersion: string, packaged: boolean): LinkUpdateStatus {
  return {
    phase: packaged ? 'notConfigured' : 'disabled',
    currentVersion,
    availableVersion: null,
    releaseDate: null,
    progressPercent: null,
    transferredBytes: null,
    totalBytes: null,
    tokenConfigured: false,
    message: packaged ? '请先配置只读 GitHub Token' : '开发模式不执行安装更新，请使用 Windows 安装版验证'
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function normalizeUpdateError(error: unknown, token: string | null): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = token ? rawMessage.replaceAll(token, '[REDACTED]') : rawMessage;
  if (/401|bad credentials|requires authentication/i.test(message)) return 'GitHub Token 无效或没有读取此私有仓库的权限';
  if (/404|not found|latest version/i.test(message)) return '尚未找到可用的正式 GitHub Release';
  return `更新失败：${message}`;
}
