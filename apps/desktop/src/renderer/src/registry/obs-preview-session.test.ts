import { expect, it, vi } from 'vitest';
import { ObsPreviewSession } from './obs-preview-session';

const frame = { width: 2, height: 2, sequence: 1, timestampNs: '1', rgba: new Uint8Array(16) };
function setup() {
  const api = { getObsLiveFrame: vi.fn(() => Promise.resolve(frame)), closeObsLivePreview: vi.fn(() => Promise.resolve()) };
  return { api, session: new ObsPreviewSession(api) };
}

it('检查与画布共用未完成帧，检查退出不关闭画布连接', async () => {
  const { api, session } = setup();
  let resolveFrame: (value: typeof frame) => void = () => { throw new Error('尚未开始读取'); };
  api.getObsLiveFrame.mockImplementationOnce(() => new Promise(resolve => { resolveFrame = resolve; }));
  const canvas = session.open(), check = session.open();
  const a = canvas.next(), b = check.next();
  await Promise.resolve();
  expect(api.getObsLiveFrame).toHaveBeenCalledTimes(1);
  resolveFrame(frame);
  expect(await a).toBe(frame); expect(await b).toBe(frame);
  await check.close();
  expect(api.closeObsLivePreview).not.toHaveBeenCalled();
  await canvas.next(); await canvas.close();
  expect(api.getObsLiveFrame).toHaveBeenCalledTimes(2);
  expect(api.closeObsLivePreview).toHaveBeenCalledTimes(1);
});

it('只读一帧的检查立即释放通道，下次显式检查重新使用连接', async () => {
  const { api, session } = setup();
  for (let i = 0; i < 2; i++) {
    const check = session.open();
    await check.next(); await check.close(); await check.close();
    expect(api.closeObsLivePreview).toHaveBeenCalledTimes(i + 1);
    await expect(check.next()).rejects.toThrow('已取消');
  }
});

it('退出等待当前帧完成，期间新画布接管时不关闭共享通道', async () => {
  const { api, session } = setup();
  let resolveFrame: (value: typeof frame) => void = () => { throw new Error('尚未开始读取'); };
  api.getObsLiveFrame.mockImplementationOnce(() => new Promise(resolve => { resolveFrame = resolve; }));
  const old = session.open(); const read = old.next();
  await Promise.resolve();
  const closing = old.close(); const next = session.open();
  resolveFrame(frame); await read; await closing;
  expect(api.closeObsLivePreview).not.toHaveBeenCalled();
  await next.next(); await next.close();
  expect(api.closeObsLivePreview).toHaveBeenCalledTimes(1);
});

it('真实读取失败返回给调用者，不自动重试，并释放通道', async () => {
  const { api, session } = setup();
  api.getObsLiveFrame.mockRejectedValueOnce(new Error('预览连接已断开'));
  const check = session.open();
  await expect(check.next()).rejects.toThrow('预览连接已断开');
  await check.close();
  expect(api.getObsLiveFrame).toHaveBeenCalledTimes(1);
  expect(api.closeObsLivePreview).toHaveBeenCalledTimes(1);
});
