import type { ProgressInfo, UpdateInfo } from 'electron-updater';
import { describe, expect, it, vi } from 'vitest';
import { LinkUpdateManager, type UpdateClient, type UpdateClientFactory, type UpdateClientHandlers } from './update-manager';

describe('LinkUpdateManager', () => {
  it('开发模式明确禁用安装更新', async () => {
    const emit = vi.fn();
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', false, emit, factory);

    expect(manager.getStatus()).toMatchObject({ phase: 'disabled', currentVersion: '0.2.0' });
    await expect(manager.check('read_only_update_token_123')).resolves.toMatchObject({ phase: 'disabled' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('私有仓库 Token 缺失时不发起网络检查', async () => {
    const factory = vi.fn<UpdateClientFactory>();
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), factory);

    await expect(manager.check(null)).resolves.toMatchObject({ phase: 'notConfigured', tokenConfigured: false });
    expect(factory).not.toHaveBeenCalled();
  });

  it('按检查、下载、安装顺序发布状态', async () => {
    const installed = vi.fn();
    const statuses: string[] = [];
    const factory: UpdateClientFactory = (_token, handlers) => fakeClient(handlers, installed);
    const manager = new LinkUpdateManager('0.2.0', true, (status) => statuses.push(status.phase), factory);

    await expect(manager.check('read_only_update_token_123')).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '0.2.1'
    });
    await expect(manager.download()).resolves.toMatchObject({ phase: 'downloaded', progressPercent: 100 });
    manager.install();

    expect(installed).toHaveBeenCalledOnce();
    expect(statuses).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'downloaded']));
  });

  it('下载前拒绝安装且鉴权错误不泄露 Token', async () => {
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), (_token, handlers) => ({
      check: () => {
        handlers.error(new Error('401 Bad credentials'));
        return Promise.resolve();
      },
      download: () => Promise.resolve(),
      install: vi.fn(),
      dispose: vi.fn()
    }));

    await expect(manager.check('secret_update_token_value')).resolves.toMatchObject({
      phase: 'error',
      message: 'GitHub Token 无效或没有读取此私有仓库的权限'
    });
    expect(manager.getStatus().message).not.toContain('secret_update_token_value');
    expect(() => manager.install()).toThrow('更新尚未下载完成');
  });

  it('未知检查和下载错误也不会把 Token 显示到界面', async () => {
    const token = 'secret_update_token_value';
    const manager = new LinkUpdateManager('0.2.0', true, vi.fn(), () => ({
      check: () => Promise.reject(new Error(`network request included Bearer ${token}`)),
      download: () => Promise.resolve(),
      install: vi.fn(),
      dispose: vi.fn()
    }));

    await expect(manager.check(token)).resolves.toMatchObject({
      phase: 'error',
      message: '更新失败：network request included Bearer [REDACTED]'
    });
    expect(manager.getStatus().message).not.toContain(token);

    const downloadManager = new LinkUpdateManager('0.2.0', true, vi.fn(), (_token, handlers) => ({
      check: () => { handlers.available(updateInfo('0.2.1')); return Promise.resolve(); },
      download: () => Promise.reject(new Error(`download URL leaked ${token}`)),
      install: vi.fn(),
      dispose: vi.fn()
    }));
    await downloadManager.check(token);
    await expect(downloadManager.download()).resolves.toMatchObject({
      phase: 'error',
      message: '更新失败：download URL leaked [REDACTED]'
    });
    expect(downloadManager.getStatus().message).not.toContain(token);
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
