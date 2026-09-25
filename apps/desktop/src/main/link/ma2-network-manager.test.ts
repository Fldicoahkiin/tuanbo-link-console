import { beforeEach, expect, it, vi } from 'vitest';
import { Ma2NetworkManager } from './ma2-network-manager';

const memory = vi.hoisted(() => ({ file: null as string | null, connects: 0, closes: 0, version: '3.3.4.3', capabilities: 'Lua 5.3:true:true:true', pause: null as Promise<void> | null }));
vi.mock('node:fs/promises', () => ({ readFile: () => memory.file === null ? Promise.reject(Object.assign(new Error('Missing'), { code: 'ENOENT' })) : Promise.resolve(memory.file) }));
vi.mock('./atomic-file', () => ({ writeFileAtomically: (_path: string, value: string) => { memory.file = value; return Promise.resolve(); } }));
vi.mock('./ma2-telnet', async (importOriginal) => ({ ...await importOriginal<typeof import('./ma2-telnet')>(), Ma2Telnet: class {
  state = 'disconnected';
  async connect(): Promise<string> { memory.connects += 1; await memory.pause; this.state = 'connected'; return memory.version; }
  command(line: string, match: (text: string) => string | null): Promise<string> { const token = /TBLINK_CAP_[a-f0-9]{32}/.exec(line)?.[0]; const result = match(`${token}:${memory.capabilities}\r\n`); return result ? Promise.resolve(result) : Promise.reject(new Error('No response')); }
  disconnect(): void { memory.closes += 1; this.state = 'disconnected'; }
} }));
beforeEach(() => { memory.file = null; memory.connects = 0; memory.closes = 0; memory.pause = null; memory.version = '3.3.4.3'; memory.capabilities = 'Lua 5.3:true:true:true'; });
const settings = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'lighting', autoConnect: true };
function secretStore() {
  const values = new Map<string, string>();
  return { values, hasCredential: (id: string) => Promise.resolve(values.has(id)), saveCredential: (id: string, value: string) => { values.set(id, value); return Promise.resolve(); }, loadCredential: (id: string) => { const value = values.get(id); return value === undefined ? Promise.reject(new Error('Credential missing')) : Promise.resolve(value); } };
}
it('密码仅进入安全存储，机器设置与状态不包含密码，重启只连接一次', async () => {
  const secrets = secretStore(); const manager = new Ma2NetworkManager(process.cwd(), secrets);
  await manager.initialize();
  await manager.save({ settings, password: 'private-test-value' });
  expect(memory.file).not.toContain('private-test-value'); expect(JSON.stringify(manager.status())).not.toContain('private-test-value');
  const restored = new Ma2NetworkManager(process.cwd(), secrets); await restored.initialize();
  expect(memory.connects).toBe(1); expect(restored.status().state).toBe('connected');
  expect(restored.get(settings).bridge).toBeDefined();
  expect(() => restored.get({ ...settings, host: '127.0.0.2' })).toThrow('目标已改变');
  restored.disconnect(); expect(() => restored.get(settings)).toThrow('请先连接');
});
it('连接未完成时断开不会在迟到的登录返回后恢复连接', async () => {
  const manager = new Ma2NetworkManager(process.cwd(), secretStore());
  await manager.save({ settings });
  let release: () => void = () => { throw new Error('No pending connection'); };
  memory.pause = new Promise<void>((resolve) => { release = resolve; });
  const pending = manager.connect();
  await expect(manager.save({ settings })).rejects.toThrow('正在连接');
  manager.disconnect(); release(); await pending;
  expect(manager.status()).toMatchObject({ state: 'disconnected', version: null });
  expect(() => manager.get(settings)).toThrow('请先连接');
});
it('修改控台或用户不会沿用另一目标的密码', async () => {
  const secrets = secretStore(); const manager = new Ma2NetworkManager(process.cwd(), secrets);
  await manager.save({ settings, password: 'private-test-value' });
  expect(manager.status().passwordSaved).toBe(true);
  await manager.save({ settings: { ...settings, host: '127.0.0.2' } });
  expect(manager.status().passwordSaved).toBe(false); expect(secrets.values.size).toBe(1);
});
it('损坏的机器设置不猜测目标、不自动连接', async () => {
  memory.file = '{broken'; const manager = new Ma2NetworkManager(process.cwd(), secretStore()); await manager.initialize();
  expect(manager.status().error).toContain('读取失败'); expect(memory.connects).toBe(0);
});

it('单台旧配置迁移后保存多台，切换再启动仅连接当前控台，密码不串台', async () => {
  memory.file = JSON.stringify(settings);
  const secrets = secretStore(); const manager = new Ma2NetworkManager(process.cwd(), secrets);
  await manager.initialize();
  await manager.save({ settings, password: 'first-secret' });
  const second = { ...settings, host: '127.0.0.2', username: 'second' };
  await manager.save({ settings: second, password: 'second-secret' });
  expect(manager.status().profiles).toHaveLength(2);
  await manager.save({ settings });
  expect(manager.status().profiles).toHaveLength(2);
  const restored = new Ma2NetworkManager(process.cwd(), secrets); await restored.initialize();
  expect(restored.status().settings?.host).toBe('127.0.0.1');
  expect(restored.status().profiles).toHaveLength(2);
  expect(restored.status().passwordSaved).toBe(true);
  expect(memory.connects).toBe(2);
  expect(memory.file).not.toContain('first-secret'); expect(memory.file).not.toContain('second-secret');
});
it('播放中拒绝更换或连接控台，保留原配置', async () => {
  let playing = false;
  const manager = new Ma2NetworkManager(process.cwd(), secretStore(), () => playing);
  await manager.save({ settings }); playing = true;
  await expect(manager.save({ settings: { ...settings, host: '127.0.0.2' } })).rejects.toThrow('播放期间');
  await expect(manager.connect()).rejects.toThrow('播放期间');
  expect(manager.status().settings?.host).toBe(settings.host);
});

it.each(['2.9.1', '3.0.0.5', '3.1.2.5', '3.3.4.3', '3.9.60.74'])('版本 %s 不使用白名单冒充兼容，按返回接口检测（模拟）', async (version) => {
  memory.version = version;
  const manager = new Ma2NetworkManager(process.cwd(), secretStore());
  await manager.save({ settings }); await manager.connect();
  expect((await manager.checkCapabilities()).capabilities).toMatchObject({ version, objects: true, files: true, plugin: true });
  memory.capabilities = 'Lua 5.1:false:false:true';
  expect((await manager.checkCapabilities()).capabilities?.objects).toBe(false);
  expect(() => manager.get(settings)).toThrow();
  manager.disconnect(); expect(manager.status().capabilities).toBeNull();
});
