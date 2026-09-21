import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installObsLiveBridge } from './obs-live-install';
import { obsPluginFingerprint } from './obs-plugin-fingerprint';

const files = vi.hoisted(() => ({ readFile: vi.fn(), mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), unlink: vi.fn() }));
vi.mock('node:fs/promises', () => files);

function dll(): Buffer {
  const data = Buffer.alloc(640);
  data.writeUInt16LE(0x5a4d, 0); data.writeUInt32LE(64, 60); data.writeUInt32LE(0x4550, 64);
  data.writeUInt16LE(0x8664, 68); data.writeUInt16LE(1, 70); data.writeUInt16LE(240, 84);
  data.writeUInt16LE(0x20b, 88); data.writeUInt32LE(16, 196);
  data.writeUInt32LE(1000, 248); data.writeUInt32LE(28, 252);
  data.writeUInt32LE(1000, 340); data.writeUInt32LE(240, 344); data.writeUInt32LE(400, 348);
  data.writeUInt32LE(2, 412); data.writeUInt32LE(24, 416); data.writeUInt32LE(440, 424);
  data.write('RSDS', 440); data.writeUInt32LE(1, 460); data[500] = 123;
  return data;
}
beforeEach(() => {
  vi.stubEnv('ProgramData', 'C:/fixture');
  files.mkdir.mockResolvedValue(undefined); files.writeFile.mockResolvedValue(undefined);
  files.rename.mockResolvedValue(undefined); files.unlink.mockResolvedValue(undefined);
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

it('相同代码只有编译时间与 CodeView 标识不同，不覆盖已加载的 DLL', async () => {
  const source = dll(), installed = dll();
  installed.writeUInt32LE(42, 72); installed.writeUInt32LE(99, 404); installed.fill(17, 444, 460);
  expect(obsPluginFingerprint(source)).toBe(obsPluginFingerprint(installed));
  files.readFile.mockResolvedValueOnce(source).mockResolvedValueOnce(installed);
  await installObsLiveBridge('source.dll');
  expect(files.writeFile).not.toHaveBeenCalled(); expect(files.rename).not.toHaveBeenCalled();
});
it('实际代码变化不能被当成同版本；文件占用时保留原 DLL 并清理临时文件', async () => {
  const source = dll(), installed = dll(); installed[500] = 124;
  expect(obsPluginFingerprint(source)).not.toBe(obsPluginFingerprint(installed));
  files.readFile.mockResolvedValueOnce(source).mockResolvedValueOnce(installed);
  files.rename.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
  await expect(installObsLiveBridge('source.dll')).rejects.toThrow('原插件已保留');
  expect(files.writeFile.mock.calls[0]?.[0]).toMatch(/\.tmp$/);
  expect(files.writeFile.mock.calls[0]?.[2]).toEqual({ flag: 'wx' });
  expect(files.unlink.mock.calls[0]?.[0]).toBe(files.writeFile.mock.calls[0]?.[0]);
});
it('首次安装完成暂存后才替换目标，权限错误明确报告', async () => {
  files.readFile.mockResolvedValueOnce(dll()).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
  await installObsLiveBridge('source.dll');
  expect(files.rename).toHaveBeenCalledTimes(1);
  files.readFile.mockResolvedValueOnce(dll()).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(installObsLiveBridge('source.dll')).rejects.toThrow('denied');
});
it('无效 PE 文件与越界调试目录不能通过指纹比较', () => {
  expect(() => obsPluginFingerprint(Buffer.alloc(12))).toThrow();
  const data = dll(); data.writeUInt32LE(10000, 424);
  expect(() => obsPluginFingerprint(data)).toThrow('范围无效');
});

it('首次创建目录无权限时调用授权安装，并重新核验已安装文件', async () => {
  const binary = dll();
  files.readFile.mockResolvedValueOnce(binary).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })).mockResolvedValueOnce(binary);
  files.mkdir.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  const elevate = vi.fn().mockResolvedValue(undefined);
  await installObsLiveBridge('source.dll', elevate);
  expect(elevate).toHaveBeenCalledWith('source.dll', expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(files.unlink).not.toHaveBeenCalled();
});

it('授权后文件不匹配不能报告安装成功', async () => {
  const changed = dll(); changed[500] = 99;
  files.readFile.mockResolvedValueOnce(dll()).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' })).mockResolvedValueOnce(changed);
  files.mkdir.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(installObsLiveBridge('source.dll', vi.fn().mockResolvedValue(undefined))).rejects.toThrow('校验失败');
});
