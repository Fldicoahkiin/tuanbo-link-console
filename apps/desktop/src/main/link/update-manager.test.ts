import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { LinkUpdateManager, type UpdateClient, type UpdateClientFactory, type UpdateClientHandlers } from './update-manager';

describe('LinkUpdateManager', () => {
  it('开发模式明确禁用安装更新', async () => {
    const emit = vi.fn();
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', false, emit, factory);

    expect(manager.getStatus()).toMatchObject({ phase: 'disabled', currentVersion: '0.2.0' });
    await expect(manager.check()).resolves.toMatchObject({ phase: 'disabled' });
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(['', 'http://updates.example.com/', 'https://user:secret@updates.example.com/', 'https://updates.example.com/?token=secret', 'https://updates.example.com/#fragment'])('无效更新地址不发起网络检查：%s', async (feedUrl) => {
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), factory, feedUrl);
    await expect(manager.check()).resolves.toMatchObject({ phase: 'notConfigured', feedConfigured: false });
    expect(factory).not.toHaveBeenCalled();
  });

  it('按检查、下载、安装顺序发布状态', async () => {
    const installed = vi.fn();
    const statuses: string[] = [];
    const factory: UpdateClientFactory = (_feedUrl, handlers) => fakeClient(handlers, installed);
    const manager = new LinkUpdateManager('0.2.0', true, (status) => statuses.push(status.phase), factory);

    await expect(manager.check()).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '0.2.1'
    });
    await expect(manager.download()).resolves.toMatchObject({ phase: 'downloaded', progressPercent: 100 });
    manager.install();

    expect(installed).toHaveBeenCalledOnce();
    expect(statuses).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']));
  });

  it('固定公司更新源且服务尚未发布时明确失败', async () => {
    const factory = vi.fn<UpdateClientFactory>(() => ({
      check: () => Promise.reject(new Error('404 Not found')),
      download: () => Promise.resolve(), install: vi.fn(), dispose: vi.fn()
    }));
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), factory);
    await expect(manager.check()).resolves.toMatchObject({ phase: 'error', message: '更新服务尚未发布可用的正式版本' });
    expect(factory).toHaveBeenCalledWith('https://updates.link.jinhefilm.com/windows/x64/', expect.any(Object));
    expect(() => manager.install()).toThrow('更新尚未下载完成');
    await expect(manager.download()).rejects.toThrow('当前没有可下载的更新');
  });

  it('检查与下载互斥，保留已下载版本等待安装', async () => {
    let completeCheck = (): void => { throw new Error('check not started'); };
    let completeDownload = (): void => { throw new Error('download not started'); };
    const factory = vi.fn<UpdateClientFactory>((_feedUrl, handlers) => ({
      check: () => new Promise<void>(resolve => { completeCheck = () => { handlers.available(updateInfo('0.2.1')); resolve(); }; }),
      download: () => new Promise<void>(resolve => { completeDownload = () => { handlers.downloaded(updateInfo('0.2.1')); resolve(); }; }),
      install: vi.fn(), dispose: vi.fn()
    }));
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), factory);
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

  it('下载失败可重新检查，错误不会被假装成功', async () => {
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), (_feedUrl, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: () => Promise.reject(new Error('checksum mismatch')),
      install: vi.fn(), dispose: vi.fn()
    }));
    await manager.check();
    await expect(manager.download()).resolves.toMatchObject({ phase: 'error', message: '更新失败：checksum mismatch' });
    expect(() => manager.install()).toThrow('更新尚未下载完成');
    await expect(manager.check()).resolves.toMatchObject({ phase: 'available' });
  });
});

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
      return Promise.resolve();
    },
    install: installed,
    dispose: vi.fn()
  };
}

function updateInfo(version: string): UpdateInfo {
  return {
    version,
    files: [{ url: 'Tuanbo-Link-Console.exe', sha512: 'sha512' }],
    path: 'Tuanbo-Link-Console.exe',
    sha512: 'sha512',
    releaseDate: '2026-08-27T00:00:00.000Z'
  };
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
