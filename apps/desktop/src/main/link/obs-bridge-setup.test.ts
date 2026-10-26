import { expect, it, vi } from 'vitest';
import { ObsBridgeSetup, type ObsBridgeSetupTools } from './obs-bridge-setup';
import { ObsPluginInstallError } from './obs-live-install';

function fixture() {
  const calls: string[] = [];
  const tools = {
    install: vi.fn((elevated: boolean) => { calls.push(`install:${elevated}`); return Promise.resolve(false); }),
    process: vi.fn(() => Promise.resolve({ pid: null as number | null, owned: false })),
    confirm: vi.fn<ObsBridgeSetupTools['confirm']>().mockResolvedValue(true),
    stop: vi.fn(() => { calls.push('stop'); return Promise.resolve(); }),
    start: vi.fn(() => { calls.push('start'); return Promise.resolve(); }),
    connect: vi.fn(() => { calls.push('connect'); return Promise.resolve(); }),
    verify: vi.fn(() => { calls.push('verify'); return Promise.resolve(); })
  } satisfies ObsBridgeSetupTools;
  return { tools, calls, setup: new ObsBridgeSetup(tools) };
}

it('认证失败不是插件故障，不提示重启或关闭 OBS', async () => {
  const { setup, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: false });
  tools.connect.mockRejectedValue(new Error('Authentication failed'));
  await expect(setup.repair()).rejects.toThrow('Authentication failed');
  expect(tools.verify).not.toHaveBeenCalled();
  expect(tools.confirm).not.toHaveBeenCalled();
  expect(tools.stop).not.toHaveBeenCalled();
});

it('新电脑：部署完成后启动、连接并读取真实帧', async () => {
  const { setup, calls } = fixture();
  await setup.repair();
  expect(calls).toEqual(['install:true', 'start', 'connect', 'verify']);
});
it('当前版本已加载：核验真实帧，不关闭或重启', async () => {
  const { setup, calls, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: false });
  await setup.repair();
  expect(calls).toEqual(['install:false', 'connect', 'verify']);
  expect(tools.confirm).not.toHaveBeenCalled();
});
it('已占用的自有 OBS：确认后正常关闭、升级、重连和验帧', async () => {
  const { setup, calls, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: true });
  tools.install.mockRejectedValueOnce(new ObsPluginInstallError('blocked', new Error('busy')));
  await setup.repair();
  expect(tools.confirm).toHaveBeenCalledWith('restart', expect.any(String));
  expect(calls).toEqual(['stop', 'install:true', 'start', 'connect', 'verify']);
});
it('外部 OBS 仍在运行时保留原进程，用户退出后才部署', async () => {
  const { setup, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: false });
  tools.verify.mockRejectedValue(new Error('插件尚未加载'));
  await expect(setup.repair()).rejects.toThrow('OBS 还在运行');
  expect(tools.stop).not.toHaveBeenCalled();
  expect(tools.start).not.toHaveBeenCalled();
  tools.process.mockResolvedValueOnce({ pid: 1, owned: false }).mockResolvedValueOnce({ pid: null, owned: false });
  tools.verify.mockRejectedValueOnce(new Error('插件尚未加载')).mockResolvedValue(undefined);
  await setup.repair();
  expect(tools.stop).not.toHaveBeenCalled();
  expect(tools.start).toHaveBeenCalledOnce();
});
it('取消维护和推流/录像保护均阻断后续写入和启动', async () => {
  const { setup, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: true });
  tools.install.mockRejectedValue(new ObsPluginInstallError('blocked', null));
  tools.confirm.mockResolvedValueOnce(false);
  await expect(setup.repair()).rejects.toThrow('取消');
  expect(tools.stop).not.toHaveBeenCalled();
  tools.stop.mockRejectedValueOnce(new Error('OBS 正在推流或录像，联动台不会关闭它'));
  await expect(setup.repair()).rejects.toThrow('联动台不会关闭它');
  expect(tools.start).not.toHaveBeenCalled();
  expect(tools.install.mock.calls.every(([elevated]) => !elevated)).toBe(true);
});
it('授权取消不会启动 OBS；再次手动操作可继续', async () => {
  const { setup, tools } = fixture();
  tools.install.mockRejectedValueOnce(new ObsPluginInstallError('permission', null)).mockRejectedValueOnce(new Error('取消 UAC'));
  await expect(setup.prepare()).rejects.toThrow('取消 UAC');
  expect(tools.start).not.toHaveBeenCalled();
  await setup.prepare();
});
it('进程身份变化不允许关闭新进程', async () => {
  const { setup, tools } = fixture();
  tools.process.mockResolvedValueOnce({ pid: 1, owned: true }).mockResolvedValueOnce({ pid: 2, owned: true });
  tools.install.mockRejectedValueOnce(new ObsPluginInstallError('blocked', null));
  await expect(setup.repair()).rejects.toThrow('进程已变化');
  expect(tools.stop).not.toHaveBeenCalled();
});
it('维修后仍无帧则明确失败，不自动重试', async () => {
  const { setup, tools } = fixture();
  tools.verify.mockRejectedValue(new Error('无帧'));
  await expect(setup.repair()).rejects.toThrow('无帧');
  expect(tools.verify).toHaveBeenCalledOnce();
});
it('并发维护被拒绝，避免重复授权和重启', async () => {
  const { setup, tools } = fixture();
  let finish: () => void = () => { throw new Error('not initialized'); };
  tools.install.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finish = () => resolve(false); }));
  const pending = setup.prepare();
  await expect(setup.repair()).rejects.toThrow('正在修复 OBS 组件');
  finish();
  await pending;
});

it('文件替换成功也必须重启运行中的旧模块，不能只看旧模块仍能出帧', async () => {
  const { setup, tools } = fixture();
  tools.process.mockResolvedValue({ pid: 1, owned: true });
  tools.install.mockResolvedValueOnce(true);
  await setup.repair();
  expect(tools.confirm).toHaveBeenCalledWith('restart', expect.stringContaining('文件已更新'));
  expect(tools.stop).toHaveBeenCalledOnce();
  expect(tools.verify).toHaveBeenCalledOnce();
});
