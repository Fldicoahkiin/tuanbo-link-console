import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { toUserErrorMessage } from '@tb/core/link';
import { ObsNativeSeek } from './obs-native-seek';
import { ObsLivePreview } from './obs-live-preview';
import { beautyPipeAccessDeniedMessage } from './obs-bridge-access';

// Windows ERROR_ACCESS_DENIED on a named pipe reaches Node as EPERM.
vi.mock('node:net', () => ({
  createConnection: vi.fn((path: string) => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: vi.fn() });
    queueMicrotask(() => socket.emit('error', Object.assign(new Error(`connect EPERM ${path}`), { code: 'EPERM' })));
    return socket;
  })
}));

describe('OBS 内置组件通道被 Windows 拒绝访问', () => {
  it('视频定位说明是 OBS 以管理员身份运行，界面不再改写成笼统的安全软件提示', async () => {
    const seek = new ObsNativeSeek(() => Promise.resolve(20980));
    const failure = seek.seek('ws://127.0.0.1:4455', '团播联动台·素材·测试', 0);
    await expect(failure).rejects.toThrow('OBS 以管理员身份运行');
    const message = await failure.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message).not.toContain('EPERM');
    expect(toUserErrorMessage(message)).toBe(message);
  });

  it('实时预览给出同样的原因和改法：升级组件，或核对 Windows 账户', async () => {
    const preview = new ObsLivePreview(() => Promise.resolve(20980));
    const failure = preview.next('ws://127.0.0.1:4455');
    await expect(failure).rejects.toThrow('检查并修复组件');
    const message = await failure.catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message).toContain('同一个 Windows 账户');
    expect(toUserErrorMessage(message)).toBe(message);
    preview.close();
  });

  it('美颜组件尚未升级，说明美颜暂不支持管理员身份的 OBS，界面原样显示', () => {
    expect(beautyPipeAccessDeniedMessage).toContain('以管理员身份运行');
    expect(toUserErrorMessage(beautyPipeAccessDeniedMessage)).toBe(beautyPipeAccessDeniedMessage);
  });
});
