import { beforeEach, expect, it, vi } from 'vitest';
import type { LinkDesktopApi } from '@tb/core/link';
import { obsPreviewSession } from './obs-preview-session';
import { useConnectionCheckStore } from '../stores/connection-check-store';

const api = vi.hoisted(() => ({
  getObsLiveFrame: vi.fn<LinkDesktopApi['getObsLiveFrame']>(),
  closeObsLivePreview: vi.fn<LinkDesktopApi['closeObsLivePreview']>()
}));
vi.mock('./link-desktop-view-model', () => ({ linkDesktopViewModel: api }));
beforeEach(() => {
  vi.resetAllMocks();
  api.getObsLiveFrame.mockResolvedValue({ width: 2, height: 2, sequence: 1, timestampNs: '1', rgba: new Uint8Array(16) });
  api.closeObsLivePreview.mockResolvedValue();
  useConnectionCheckStore.setState({ running: false, checks: {}, pending: [], completed: 0, total: 0 });
});

it('真实画面恢复时清除顶部旧错误，后续逐帧读取不重复刷新状态', async () => {
  useConnectionCheckStore.getState().finish('preview', 'error', '旧连接中断');
  const changed = vi.fn();
  const unsubscribe = useConnectionCheckStore.subscribe(changed);
  const canvas = obsPreviewSession.open();
  try {
    await canvas.next(); await canvas.next();
    expect(useConnectionCheckStore.getState().checks.preview?.state).toBe('ready');
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { await canvas.close(); unsubscribe(); }
});

it('损坏帧不能把顶部错误伪装成已就绪', async () => {
  api.getObsLiveFrame.mockResolvedValue({ width: 2, height: 2, sequence: 1, timestampNs: '1', rgba: new Uint8Array(0) });
  const check = obsPreviewSession.open();
  try {
    await expect(check.next()).rejects.toThrow('画面数据不完整');
    expect(useConnectionCheckStore.getState().checks.preview?.state).toBe('error');
  } finally { await check.close(); }
});
