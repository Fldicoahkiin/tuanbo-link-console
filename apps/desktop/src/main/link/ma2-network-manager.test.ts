import { beforeEach, expect, it, vi } from 'vitest';
import { Ma2NetworkManager } from './ma2-network-manager';
import { meiNanXml, meiNanCues } from './fixtures/ma2-mei-nan-reconstruction';

const memory = vi.hoisted(() => ({ file: null as string | null, localAddress: undefined as string | undefined, connects: 0, closes: 0, version: '3.3.4.3', capabilities: 'Lua 5.3:true:true:true', pause: null as Promise<void> | null, drop: () => undefined }));
vi.mock('node:fs/promises', () => ({ readFile: () => memory.file === null ? Promise.reject(Object.assign(new Error('Missing'), { code: 'ENOENT' })) : Promise.resolve(memory.file) }));
vi.mock('./atomic-file', () => ({ writeFileAtomically: (_path: string, value: string) => { memory.file = value; return Promise.resolve(); } }));
vi.mock('./ma2-telnet', async (importOriginal) => ({ ...await importOriginal<typeof import('./ma2-telnet')>(), Ma2Telnet: class {
  state = 'disconnected';
  readTraffic() { return { wireCommands: 0, sentBytes: 0, receivedBytes: 0, queueMs: 0 }; }
  constructor(address: { localAddress?: string }, onState: (state: 'disconnected') => void) {
    memory.localAddress = address.localAddress;
    memory.drop = () => { this.state = 'disconnected'; onState('disconnected'); };
  }
  async connect(): Promise<string> { memory.connects += 1; await memory.pause; this.state = 'connected'; return memory.version; }
  async command(line: string, match: (text: string) => string | null, beforeSend?: () => void): Promise<string> {
    await memory.pause; beforeSend?.();
    const cuePrefix = /TBLINK_CUES_[a-f0-9]{32}:/.exec(line)?.[0];
    if (cuePrefix) {
      const row = `12;${Buffer.from('截图重建序列').toString('hex')};${meiNanCues.map((cue, index) => `${index + 1},${cue},${Buffer.from(`Cue ${cue}`).toString('hex')}`).join(';')}`;
      const chunks: string[] = [];
      for (let index = 0; index < row.length; index += 700) chunks.push(`${cuePrefix}${index + 1}:${row.slice(index, index + 700)}`);
      const response = match(`${chunks.join('\r\n')}\r\n${cuePrefix}END:${row.length}\r\n`);
      if (!response) throw new Error('No cue response'); return response;
    }
    const token = /TBLINK_(?:CAP|PLAY)_[a-f0-9]{32}/.exec(line)?.[0];
    const result = match(`${token}:${token?.includes('_PLAY_') ? 'SENT' : memory.capabilities}\r\n`);
    if (!result) throw new Error('No response'); return result;
  }
  disconnect(): void { memory.closes += 1; this.state = 'disconnected'; }
} }));
beforeEach(() => { memory.file = null; memory.connects = 0; memory.closes = 0; memory.pause = null; memory.version = '3.3.4.3'; memory.capabilities = 'Lua 5.3:true:true:true'; });
const settings = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'lighting', autoConnect: true };
it('意外断线会恢复原控台连接，主动断开则停止恢复且不重放操作', async () => {
  vi.useFakeTimers();
  const manager = new Ma2NetworkManager(process.cwd(), secretStore());
  try {
    await manager.save({ settings }); await manager.connect();
    memory.drop();
    expect(manager.status().state).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.status().state).toBe('connected'); expect(memory.connects).toBe(2);
    memory.drop();
    await manager.disconnectByOperator();
    await vi.advanceTimersByTimeAsync(60000);
    expect(manager.status().state).toBe('disconnected'); expect(memory.connects).toBe(2);
  } finally { manager.disconnect(); vi.useRealTimers(); }
});
it('100 条混合时间线共享序列只取一次元数据；最终只复核目录，不再读全部 XML', async () => {
  memory.version = '3.7.0.5';
  const manager = new Ma2NetworkManager(process.cwd(), secretStore());
  await manager.save({ settings }); await manager.connect();
  const directory = { show: '构造规模测试，非现场性能', generation: 'scale', version: memory.version, entries: Array.from({ length: 100 }, (_, index) => ({ target: index + 1, name: `TC ${index + 1}` })) };
  const sequenceDirectory = { ...directory, entries: [{ target: 36, name: '截图重建序列' }] };
  const request = vi.spyOn(manager.get(settings).bridge, 'request').mockImplementation((operation, target) => Promise.resolve(operation === 'LIST' ? JSON.stringify(directory) : operation === 'LISTSEQ' ? JSON.stringify(sequenceDirectory) : meiNanXml.replace('<Timecode index="1"', `<Timecode index="${target - 1}"`)));
  const catalog = await manager.readCatalog(settings);
  expect(catalog.entries).toHaveLength(100);
  expect(catalog.entries[0]?.error).toBeNull();
  expect(catalog.entries[0]?.preview?.unconverted).toHaveLength(13);
  expect(catalog.entries.every(entry => !entry.error && entry.preview?.unconverted.length === 13)).toBe(true);
  // Each XML is compared immediately around metadata resolution; no third full pass.
  expect(request.mock.calls.filter(call => call[0] === 'READ')).toHaveLength(200);
  for (let target = 1; target <= 100; target++) expect(request.mock.calls.filter(call => call[0] === 'READ' && call[1] === target)).toHaveLength(2);
  expect(request.mock.calls.filter(call => call[0] === 'LIST')).toHaveLength(2);
  expect(request.mock.calls.filter(call => call[0] === 'LISTSEQ')).toHaveLength(2);
  expect(catalog.metrics?.requests).toBe(206);
  expect(catalog.metrics?.bytes).toBeGreaterThan(100000);
  request.mockClear();
  await manager.readCatalog(settings, undefined, undefined, [55]);
  expect(request.mock.calls.filter(call => call[0] === 'READ').map(call => call[1])).toEqual([55, 55]);
  manager.disconnect();
});
it('连接传入已校验的电脑地址，地址解析失败不建立 TCP 连接', async () => {
  const resolve = vi.fn().mockResolvedValue('2.0.0.97');
  const manager = new Ma2NetworkManager(process.cwd(), secretStore(), () => false, undefined, resolve);
  await manager.save({ settings: { ...settings, host: '2.0.0.98' } });
  await manager.connect();
  expect(resolve).toHaveBeenCalledWith('2.0.0.98'); expect(memory.localAddress).toBe('2.0.0.97');
  manager.disconnect();
  resolve.mockRejectedValue(new Error('专用地址已不可用'));
  expect((await manager.connect()).error).toBe('专用地址已不可用'); expect(memory.connects).toBe(1);
});
it('网络播放拒绝过期、换目标和停止后排队的指令', async () => {
  const manager = new Ma2NetworkManager(process.cwd(), secretStore());
  await manager.save({ settings }); await manager.connect();
  const { host, port, monitorPort, username } = settings;
  const request = { network: { host, port, monitorPort, username }, sessionId: crypto.randomUUID(), deadlineAt: Date.now() + 1000, action: { target: 'sequence' as const, sequence: 168, cue: '1.250', action: 'goto' as const } };
  await expect(manager.playCue(request)).resolves.toBeUndefined();
  await expect(manager.playCue({ ...request, deadlineAt: Date.now() - 1 })).rejects.toThrow('过期');
  await expect(manager.playCue({ ...request, network: { ...request.network, host: '127.0.0.2' } })).rejects.toThrow('目标已改变');
  let release: (() => void) | undefined;
  memory.pause = new Promise<void>(resolve => { release = resolve; });
  const queued = manager.playCue(request); manager.cancelPlayback(request.sessionId); release?.();
  await expect(queued).rejects.toThrow('会话已结束');
  manager.disconnect();
});
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
it('重复连接和保存相同目标复用会话，不制造旧连接试听记录',async()=>{
  const manager=new Ma2NetworkManager(process.cwd(),secretStore());
  await manager.save({settings});await manager.connect();
  const generation=manager.connectionGeneration;
  const guard=vi.fn(()=>Promise.reject(new Error('不应停止试听')));
  manager.setBeforeConnectionChange(guard);
  await manager.save({settings:{...settings,autoConnect:false}});await manager.connect();
  expect(memory.connects).toBe(1);expect(manager.connectionGeneration).toBe(generation);
  expect(manager.status().state).toBe('connected');expect(guard).not.toHaveBeenCalled();
});
it('更换目标或主动断开须先成功停止；失败不保存新设置，不断开原连接',async()=>{
  const manager=new Ma2NetworkManager(process.cwd(),secretStore());
  await manager.save({settings});await manager.connect();
  const originalFile=memory.file;const generation=manager.connectionGeneration;
  const release=vi.fn();const guard=vi.fn<()=>Promise<()=>void>>(()=>Promise.reject(new Error('停止失败')));
  manager.setBeforeConnectionChange(guard);
  await expect(manager.save({settings:{...settings,host:'127.0.0.2'}})).rejects.toThrow('停止失败');
  await expect(manager.disconnectByOperator()).rejects.toThrow('停止失败');
  expect(memory.file).toBe(originalFile);expect(manager.connectionGeneration).toBe(generation);
  expect(manager.status().state).toBe('connected');
  guard.mockImplementation(()=>Promise.resolve(release));
  await manager.disconnectByOperator();expect(manager.status().state).toBe('disconnected');
  expect(release).toHaveBeenCalledOnce();
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
