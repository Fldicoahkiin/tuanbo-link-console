import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { expect, it } from 'vitest';
import { createDefaultIntegrationProfile } from '../../renderer/src/link/view-models/local-integration-profile';
import { prepareLocalObsConnection } from './obs-local-connection';

async function fixture(portable = false) {
  const root = await mkdtemp(join(tmpdir(), 'tblink-obs-config-'));
  const obs = { ...createDefaultIntegrationProfile().obs, executablePath: join(root, 'bin/64bit/obs64.exe'), arguments: portable ? ['--portable'] : [] };
  const roamingDirectory = join(root, 'roaming');
  const configurationPath = join(portable ? join(root, 'config/obs-studio') : join(roamingDirectory, 'obs-studio'), 'plugin_config/obs-websocket/config.json');
  await mkdir(dirname(configurationPath), { recursive: true });
  return { obs, roamingDirectory, configurationPath, running: false, commandLine: portable ? 'obs64.exe --portable' : '' };
}

it.each([false, true])('读取选定 OBS 的真实端口和密码，便携模式 %s，不改写配置', async portable => {
  const options = await fixture(portable);
  const original = JSON.stringify({ server_enabled: true, server_port: 4567, auth_required: true, server_password: 'fixture-password', extra: { keep: true } });
  await writeFile(options.configurationPath, original);
  expect(await prepareLocalObsConnection({ ...options, running: true })).toEqual({ address: 'ws://127.0.0.1:4567', password: 'fixture-password', configurationPath: options.configurationPath, changed: false });
  expect(await readFile(options.configurationPath, 'utf8')).toBe(original);
});

it('首次配置未运行 OBS，启用服务并生成密码', async () => {
  const options = await fixture();
  const result = await prepareLocalObsConnection(options);
  expect(result.changed).toBe(true);
  expect(result.password).toMatch(/^[a-f0-9]{48}$/);
  expect(JSON.parse(await readFile(options.configurationPath, 'utf8'))).toMatchObject({ server_enabled: true, server_port: 4455, auth_required: true, server_password: result.password });
});

it('启用停用服务前保留完整备份与其他字段', async () => {
  const options = await fixture();
  const original = JSON.stringify({ server_enabled: false, server_port: 4568, auth_required: false, server_password: 'unused', extra: 'retained' });
  await writeFile(options.configurationPath, original);
  expect(await prepareLocalObsConnection(options)).toMatchObject({ password: '', changed: true });
  const backup = (await readdir(dirname(options.configurationPath))).find(name => name.endsWith('.bak'));
  expect(backup).toBeTruthy();
  expect(await readFile(join(dirname(options.configurationPath), backup!), 'utf8')).toBe(original);
  expect(JSON.parse(await readFile(options.configurationPath, 'utf8'))).toMatchObject({ extra: 'retained', server_password: 'unused', server_enabled: true });
});

it('正在运行但未启用服务时不改写文件，不猜测连接', async () => {
  const options = await fixture();
  const original = '{"server_enabled":false}';
  await writeFile(options.configurationPath, original);
  await expect(prepareLocalObsConnection({ ...options, running: true })).rejects.toThrow('正常退出 OBS');
  expect(await readFile(options.configurationPath, 'utf8')).toBe(original);
});

it('损坏配置和命令行覆盖明确报错并保留原文', async () => {
  const options = await fixture();
  await writeFile(options.configurationPath, 'broken');
  await expect(prepareLocalObsConnection(options)).rejects.toThrow('原文件没有改动');
  await expect(prepareLocalObsConnection({ ...options, commandLine: 'obs64.exe --websocket_port 4567' })).rejects.toThrow('命令行');
  expect(await readFile(options.configurationPath, 'utf8')).toBe('broken');
});
