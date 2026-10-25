import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import type { LicenseStatus } from '@tb/schema';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { LinkUpdateManager, type UpdateClient, type UpdateClientFactory, type UpdateClientHandlers, type UpdateRules } from './update-manager';

const releaseKey = generateKeyPairSync('ed25519');
const releaseKeys = { 'release-test-a': releaseKey.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const installerBytes = Buffer.from('signed installer');
const installerName = 'Tuanbo-Link-Console-0.2.1-x64.exe';
let installer = '';
beforeAll(async () => {
  installer = join(await mkdtemp(join(tmpdir(), 'tblink-update-')), installerName);
  await writeFile(installer, installerBytes);
});

describe('LinkUpdateManager', () => {
  it('开发模式明确禁用安装更新', async () => {
    const emit = vi.fn();
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', false, emit, rules(), factory);

    expect(manager.getStatus()).toMatchObject({ phase: 'disabled', currentVersion: '0.2.0' });
    await expect(manager.check()).resolves.toMatchObject({ phase: 'disabled' });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['', 'http://updates.example.com/', 'https://user:secret@updates.example.com/', 'https://updates.example.com/?token=secret', 'https://updates.example.com/#fragment'])('无效更新地址不发起网络检查：%s', async (feedUrl) => {
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(), factory, feedUrl);
    await expect(manager.check()).resolves.toMatchObject({ phase: 'notConfigured', feedConfigured: false });
    expect(factory).not.toHaveBeenCalled();
  });

  it('按检查、下载、安装顺序发布状态', async () => {
    const installed = vi.fn();
    const statuses: string[] = [];
    const factory: UpdateClientFactory = (_feedUrl, handlers) => fakeClient(handlers, installed);
    const manager = new LinkUpdateManager('0.2.0', true, (status) => statuses.push(status.phase), rules(), factory);

    await expect(manager.check()).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '0.2.1'
    });
    await expect(manager.download()).resolves.toMatchObject({ phase: 'downloaded', progressPercent: 100 });
    await manager.prepareInstall();
    manager.install();

    expect(installed).toHaveBeenCalledOnce();
    expect(statuses).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']));
  });

  it('固定公司更新源且服务尚未发布时明确失败', async () => {
    const factory = vi.fn<UpdateClientFactory>(() => ({
      check: () => Promise.reject(new Error('404 Not found')),
      download: () => Promise.resolve(installer), install: vi.fn(), dispose: vi.fn()
    }));
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(), factory);
    await expect(manager.check()).resolves.toMatchObject({ phase: 'error', message: '更新服务尚未发布可用的正式版本' });
    expect(factory).toHaveBeenCalledWith('https://updates.tuanbo-link.jinhefilm.com/windows/x64/', expect.any(Object));
    expect(() => manager.install()).toThrow('更新尚未下载完成');
    await expect(manager.download()).rejects.toThrow('当前没有可下载的更新');
  });

  it('检查与下载互斥，保留已下载版本等待安装', async () => {
    let completeCheck = (): void => { throw new Error('check not started'); };
    let completeDownload = (): void => { throw new Error('download not started'); };
    const factory = vi.fn<UpdateClientFactory>((_feedUrl, handlers) => ({
      check: () => new Promise<void>(resolve => { completeCheck = () => { handlers.available(updateInfo('0.2.1')); resolve(); }; }),
      download: () => new Promise<string>(resolve => { completeDownload = () => { handlers.downloaded(updateInfo('0.2.1')); resolve(installer); }; }),
      install: vi.fn(), dispose: vi.fn()
    }));
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(), factory);
    const checking = manager.check();
    await expect(manager.check()).rejects.toThrow('请先完成当前更新操作');
    completeCheck(); await checking;
    const downloading = manager.download();
    await expect(manager.check()).rejects.toThrow('请先完成当前更新操作');
    await expect(manager.download()).rejects.toThrow('当前没有可下载的更新');
    completeDownload(); await downloading;
    await expect(manager.check()).rejects.toThrow('请先完成当前更新操作');
    expect(factory).toHaveBeenCalledOnce();
    expect(manager.getStatus().phase).toBe('downloaded');
  });

  it('播放中拒绝开始下载', async () => {
    let playing = true;
    const download = vi.fn();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => playing), (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: () => { download(); handlers.downloaded(updateInfo('0.2.1')); return Promise.resolve(installer); },
      install: vi.fn(), dispose: vi.fn()
    }));
    await manager.check();
    await expect(manager.download()).rejects.toThrow('播放中不下载更新');
    expect(download).not.toHaveBeenCalled();
    expect(manager.getStatus().phase).toBe('available');
    playing = false;
    await expect(manager.download()).resolves.toMatchObject({ phase: 'downloaded' });
    expect(download).toHaveBeenCalledOnce();
  });

  it('下载过程中开始播放即停止下载，可在停止后重新下载', async () => {
    let playing = false;
    let signal: AbortSignal | undefined;
    let progress = (): void => { throw new Error('download not started'); };
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => playing), (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: (abort) => new Promise<string>((_resolve, reject) => {
        signal = abort;
        progress = () => handlers.progress(progressInfo(30));
        abort.addEventListener('abort', () => reject(new Error('cancelled')));
      }),
      install: vi.fn(), dispose: vi.fn()
    }));
    await manager.check();
    const downloading = manager.download();
    await vi.waitFor(() => expect(signal).toBeDefined());
    progress();
    expect(signal?.aborted).toBe(false);
    playing = true;
    progress();
    const stopped = await downloading;
    expect(stopped).toMatchObject({ phase: 'available', progressPercent: null });
    expect(stopped.message).toContain('更新下载已停止');
    expect(signal?.aborted).toBe(true);
  });

  it('发布日期在升级服务期限内才可下载和安装', async () => {
    const install = vi.fn();
    let license = licensed('2026-08-28T00:00:00.000Z');
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => false, () => license), (_feedUrl, handlers) => fakeClient(handlers, install));
    await expect(manager.check()).resolves.toMatchObject({ phase: 'available', installBlockedReason: null });
    await manager.download();
    license = licensed('2026-08-26T00:00:00.000Z');
    await expect(manager.prepareInstall()).rejects.toThrow('晚于本机授权的升级服务期限 2026-08-26');
    expect(manager.getStatus().installBlockedReason).toContain('续费');
    expect(install).not.toHaveBeenCalled();
  });

  it('超出升级服务期限：可以看到新版本，但不能下载，并说明原因', async () => {
    const download = vi.fn();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => false, () => licensed('2026-08-26T00:00:00.000Z')), (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download, install: vi.fn(), dispose: vi.fn()
    }));
    const status = await manager.check();
    expect(status).toMatchObject({ phase: 'available', availableVersion: '0.2.1' });
    expect(status.installBlockedReason).toBe('新版本 0.2.1 发布于 2026-08-27，晚于本机授权的升级服务期限 2026-08-26；可以继续使用当前版本，续费延长升级服务后再安装');
    await expect(manager.download()).rejects.toThrow('晚于本机授权的升级服务期限');
    expect(download).not.toHaveBeenCalled();
  });

  it('提示中的日期按北京时间显示，与官网下载页一致', async () => {
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => false, () => licensed('2026-08-26T00:00:00.000Z')), (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1', '2026-08-26T18:00:00.000Z')); return Promise.resolve(); },
      download: vi.fn(), install: vi.fn(), dispose: vi.fn()
    }));
    const status = await manager.check();
    expect(status.installBlockedReason).toContain('发布于 2026-08-27，晚于本机授权的升级服务期限 2026-08-26');
  });

  it('授权不可用时仍可检查更新，只是不能安装', async () => {
    const expired: LicenseStatus = { ...licensed('2027-01-01T00:00:00.000Z'), state: 'expired', message: '使用期限已结束；工程文件保持不变' };
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), rules(() => false, () => expired), (_feedUrl, handlers) => fakeClient(handlers, vi.fn()));
    const status = await manager.check();
    expect(status.phase).toBe('available');
    expect(status.installBlockedReason).toBe('本机授权当前不可用（使用期限已结束；工程文件保持不变），可以查看新版本，恢复授权后再安装');
  });

  it('没有发布签名或 latest.yml 被改成别的安装包：可以看到版本，不能下载，写日志', async () => {
    const log = vi.fn();
    const unsigned: UpdateInfo = { version: '0.2.1', path: installerName, sha512: 'x', releaseDate: '2026-08-27T00:00:00.000Z', files: [{ url: installerName, sha512: 'x' }] };
    const forgedSha512 = createHash('sha512').update('forged installer').digest('base64');
    const forged = { ...updateInfo('0.2.1'), sha512: forgedSha512, files: [{ url: installerName, sha512: forgedSha512, size: installerBytes.length }] };
    for (const [info, reason] of [[unsigned, '没有发布签名'], [forged, '摘要或大小与更新信息不一致']] as const) {
      const download = vi.fn();
      const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), { ...rules(), log }, (_feedUrl, handlers) => ({
        check: () => { handlers.available(info); return Promise.resolve(); },
        download, install: vi.fn(), dispose: vi.fn()
      }));
      const status = await manager.check();
      expect(status).toMatchObject({ phase: 'available', availableVersion: '0.2.1', releaseDate: null });
      expect(status.installBlockedReason).toContain(`更新签名校验失败（`);
      expect(status.installBlockedReason).toContain(reason);
      await expect(manager.download()).rejects.toThrow('更新签名校验失败');
      expect(download).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining(reason));
    }
  });

  it('下载到的安装包与签名不符时拒绝安装；下载后被改动的安装包在安装前被发现', async () => {
    const log = vi.fn();
    const other = join(installer, '..', 'other.exe');
    await writeFile(other, 'another installer');
    let delivered = other;
    const install = vi.fn();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), { ...rules(), log }, (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: () => { handlers.downloaded(updateInfo('0.2.1')); return Promise.resolve(delivered); },
      install, dispose: vi.fn()
    }));
    await manager.check();
    const rejected = await manager.download();
    expect(rejected.phase).toBe('error');
    expect(rejected.message).toContain('下载的更新与发布签名不一致，已拒绝安装');
    expect(log).toHaveBeenLastCalledWith('error', expect.stringContaining('拒绝安装更新 0.2.1'));
    expect(log).toHaveBeenCalledWith('info', '开始下载更新 0.2.1');
    await expect(manager.prepareInstall()).rejects.toThrow('更新尚未下载完成');

    delivered = installer;
    await manager.check();
    await expect(manager.download()).resolves.toMatchObject({ phase: 'downloaded' });
    await writeFile(installer, 'changed after the download');
    await expect(manager.prepareInstall()).rejects.toThrow('下载的更新与发布签名不一致');
    expect(() => manager.install()).toThrow('更新尚未下载完成');
    expect(install).not.toHaveBeenCalled();
    await writeFile(installer, installerBytes);
  });

  it('启动后台检查只检查不下载；失败回到可手动重试，不显示为更新错误', async () => {
    const phases: string[] = [];
    const download = vi.fn();
    let online = false;
    const manager = new LinkUpdateManager('0.2.0', true, (status) => phases.push(status.phase), rules(), (_feedUrl, handlers) => ({
      check: () => {
        if (online) { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); }
        const error = new Error('net::ERR_INTERNET_DISCONNECTED');
        handlers.error(error);
        return Promise.reject(error);
      },
      download, install: vi.fn(), dispose: vi.fn()
    }));
    const offline = await manager.check('background');
    expect(offline.phase).toBe('idle');
    expect(offline.message).toBe('启动时未能检查更新（更新失败：net::ERR_INTERNET_DISCONNECTED），可以在软件更新中重试');
    expect(phases).not.toContain('error');
    online = true;
    await expect(manager.check('background')).resolves.toMatchObject({ phase: 'available', availableVersion: '0.2.1' });
    expect(download).not.toHaveBeenCalled();
    await expect(manager.check('background')).resolves.toMatchObject({ phase: 'available' });
  });

  it('下载失败可重新检查，错误不会被假装成功；检查和下载结果都写日志', async () => {
    const log = vi.fn();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), { ...rules(), log }, (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: () => Promise.reject(new Error('checksum mismatch')),
      install: vi.fn(), dispose: vi.fn()
    }));
    await manager.check();
    await expect(manager.download()).resolves.toMatchObject({ phase: 'error', message: '更新失败：checksum mismatch' });
    expect(log).toHaveBeenCalledWith('info', '检查更新：发现新版本 0.2.1');
    expect(log).toHaveBeenLastCalledWith('error', '下载更新 0.2.1 失败：更新失败：checksum mismatch');
    expect(() => manager.install()).toThrow('更新尚未下载完成');
    await expect(manager.check()).resolves.toMatchObject({ phase: 'available' });
  });
});

function rules(playbackActive: () => boolean = () => false, license: () => LicenseStatus = () => licensed('2099-12-31T23:59:59.000Z')): UpdateRules {
  return { playbackActive, license: () => Promise.resolve(license()), releaseKeys, log: vi.fn() };
}

function licensed(updatesUntil: string): LicenseStatus {
  const machineCode = `TB1-${'A'.repeat(64)}`;
  return { machineCode, state: 'active', message: '本机授权有效', enforcement: 'required', onlineAvailable: true,
    claims: { version: 1, product: 'tuanbo-link-console', licenseId: '9d53530a-6712-423e-985e-e69beb9ec1c6', customer: '测试客户', machineCode,
      kind: 'subscription', issuedAt: '2026-01-01T00:00:00.000Z', useUntil: '2027-12-31T00:00:00.000Z', updatesUntil } };
}

function fakeClient(handlers: UpdateClientHandlers, installed: () => void): UpdateClient {
  return {
    check: () => {
      handlers.checking();
      handlers.available(updateInfo('0.2.1'));
      return Promise.resolve();
    },
    download: () => {
      handlers.progress(progressInfo(52));
      handlers.downloaded(updateInfo('0.2.1'));
      return Promise.resolve(installer);
    },
    install: installed,
    dispose: vi.fn()
  };
}

/** latest.yml as scripts/sign-release.mjs leaves it: electron-builder's fields plus the release signature. */
function updateInfo(version: string, releaseDate = '2026-08-27T00:00:00.000Z'): UpdateInfo {
  const sha512 = createHash('sha512').update(installerBytes).digest('base64');
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'tuanbo-link-console', channel: 'release', version, releaseDate,
    file: installerName, size: installerBytes.length, sha512 }));
  const info: UpdateInfo & { tblinkRelease: unknown } = {
    version, path: installerName, sha512, releaseDate,
    files: [{ url: installerName, sha512, size: installerBytes.length }],
    tblinkRelease: { kid: 'release-test-a', payload: payload.toString('base64url'), signature: sign(null, payload, releaseKey.privateKey).toString('base64url') }
  };
  return info;
}

function progressInfo(percent: number): ProgressInfo {
  return {
    percent,
    bytesPerSecond: 1_000,
    transferred: 520,
    total: 1_000,
    delta: 120
  };
}
