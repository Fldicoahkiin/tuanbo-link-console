import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater';
import type { LinkUpdateStatus } from '@tb/core/link';
import type { LicenseStatus } from '@tb/schema';
import { dirname } from 'node:path';
import { fileSha512, verifySignedRelease, type SignedRelease } from './release-signature';

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
  /** Resolves with the downloaded installer's path; rejects once `signal` aborts. */
  download: (signal: AbortSignal) => Promise<string>;
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
  /** Public keys of the release signature by kid; more than one lets the key rotate. */
  releaseKeys: Readonly<Record<string, string>>;
  /** Rejections of a signature or a downloaded installer are written to the run log. */
  log: (level: 'warning' | 'error', message: string) => void;
};

/** The version the feed offers: its latest.yml, and the release-key signature over it once checked. */
type Offer = { info: UpdateInfo; signed: SignedRelease | null; signatureIssue: string | null; installer: string | null };

export class LinkUpdateManager {
  private client: UpdateClient | null = null;
  private busy = false;
  private backgroundCheck = false;
  private activeDownload: AbortController | null = null;
  private offer: Offer | null = null;
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

  /** `background` is the one check after startup: it never downloads, and a failure (often an offline
   * venue) leaves the panel ready for a manual retry instead of showing an update error. */
  async check(mode: 'manual' | 'background' = 'manual'): Promise<LinkUpdateStatus> {
    if (!this.packaged || !this.status.feedConfigured) return this.getStatus();
    if (this.busy || this.status.phase === 'downloaded') {
      if (mode === 'background') return this.getStatus();
      throw new Error('请先完成当前更新操作');
    }
    this.busy = true;
    this.backgroundCheck = mode === 'background';
    this.offer = null;
    this.client?.dispose();
    try {
      this.client = this.createClient(this.feedUrl, {
        checking: () => this.update({ phase: 'checking', message: '正在检查软件更新…' }),
        available: (info) => {
          this.offer = { info, signed: null, signatureIssue: null, installer: null };
          this.update({
            phase: 'available',
            availableVersion: info.version,
            // Shown once the release signature vouches for it.
            releaseDate: null,
            installBlockedReason: null,
            progressPercent: null,
            transferredBytes: null,
            totalBytes: null,
            message: `发现新版本 ${info.version}`
          });
        },
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
          progressPercent: 100,
          message: `版本 ${info.version} 已下载，确认后重启安装`
        }),
        error: (error) => { if (!this.backgroundCheck) this.update({ phase: 'error', message: normalizeUpdateError(error) }); }
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
      if (this.status.phase === 'available') {
        this.verifyOffer();
        await this.checkEntitlement();
      }
    } catch (error) {
      if (this.backgroundCheck) this.update({ phase: 'idle', message: `启动时未能检查更新（${normalizeUpdateError(error)}），可以在软件更新中重试` });
      else this.update({ phase: 'error', message: normalizeUpdateError(error) });
    } finally {
      this.backgroundCheck = false;
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
      const installer = await this.client.download(download.signal);
      const mismatch = await this.installerMismatch(installer);
      if (mismatch) this.rejectInstaller(mismatch);
      else if (this.offer) this.offer.installer = installer;
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
    const installer = this.offer?.installer;
    if (this.busy || !this.client || this.status.phase !== 'downloaded' || !installer) throw new Error('更新尚未下载完成');
    // The cached installer is checked again: it could have changed on disk since the download.
    const mismatch = await this.installerMismatch(installer);
    if (mismatch) {
      this.rejectInstaller(mismatch);
      throw new Error(this.status.message);
    }
    const blocked = await this.checkEntitlement();
    if (blocked) throw new Error(blocked);
  }

  /** Starts the installer; throws when it cannot start, and the app must then stay open. */
  install(): void {
    if (this.busy || !this.client || this.status.phase !== 'downloaded' || !this.offer?.installer) {
      throw new Error('更新尚未下载完成');
    }
    this.client.install();
  }

  private verifyOffer(): void {
    const offer = this.offer;
    if (!offer) return;
    try {
      offer.signed = verifySignedRelease(offer.info, this.rules.releaseKeys);
      this.update({ releaseDate: offer.signed.releaseDate });
    } catch (error) {
      offer.signatureIssue = error instanceof Error ? error.message : String(error);
      this.rules.log('error', `更新 ${offer.info.version} 的发布签名校验失败：${offer.signatureIssue}`);
    }
  }

  /** Why the downloaded installer is not the signed one, or null. */
  private async installerMismatch(installer: string): Promise<string | null> {
    const signed = this.offer?.signed;
    if (!signed) return '没有通过校验的发布签名';
    const actual = await fileSha512(installer);
    if (actual.sha512 !== signed.sha512 || actual.size !== signed.size) return `安装包摘要或大小与发布签名不一致（${installer}）`;
    return null;
  }

  private rejectInstaller(reason: string): void {
    if (this.offer) this.offer.installer = null;
    this.rules.log('error', `拒绝安装更新 ${this.status.availableVersion ?? ''}：${reason}`);
    this.update({ phase: 'error', message: `下载的更新与发布签名不一致，已拒绝安装；请联系发行方。${reason}` });
  }

  private async checkEntitlement(): Promise<string | null> {
    const offer = this.offer;
    const blocked = offer?.signatureIssue
      ? `更新签名校验失败（${offer.signatureIssue}），不能下载和安装；请联系发行方`
      : updateEntitlementIssue(await this.rules.license(), this.status.availableVersion, offer?.signed?.releaseDate ?? null);
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
  // Differential download: the installer copies itself to the updater cache on every install, so only changed
  // blocks are fetched (about 2 MB when the beauty and music assets are unchanged). The old blockmap comes from the
  // cache when this version was itself installed by an update, otherwise from the feed, which keeps only the
  // previous version's. Without one, or when the result's sha512 differs from latest.yml, the updater falls back to
  // the full installer; either way the file must then match the release signature before it is installed.
  updater.disableDifferentialDownload = false;
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
      const installer = (await updater.downloadUpdate(cancellation)).find(path => path.toLowerCase().endsWith('.exe'));
      if (!installer) throw new Error('更新下载没有返回安装包');
      return installer;
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

/** Why this machine may not install the release, or null. The release date is the one the release key signed;
 * the license is the signed claim on this machine. */
function updateEntitlementIssue(license: LicenseStatus, version: string | null, releaseDate: string | null): string | null {
  if (license.state !== 'active' || !license.claims) return `本机授权当前不可用（${license.message}），可以查看新版本，恢复授权后再安装`;
  const released = releaseDate === null ? Number.NaN : Date.parse(releaseDate);
  if (!Number.isFinite(released)) return '更新信息没有有效的发布日期，无法确认是否在升级服务期内，不能安装；请联系发行方';
  if (released <= Date.parse(license.claims.updatesUntil)) return null;
  return `新版本 ${version ?? ''} 发布于 ${chinaDate(released)}，晚于本机授权的升级服务期限 ${chinaDate(Date.parse(license.claims.updatesUntil))}；可以继续使用当前版本，续费延长升级服务后再安装`;
}

/** The comparison uses exact instants; dates are shown in Beijing time, as on the download page. */
function chinaDate(value: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
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
