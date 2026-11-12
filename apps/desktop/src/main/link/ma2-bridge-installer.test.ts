import { beforeEach, expect, it, vi } from 'vitest';
import { ensureMa2NetworkBridge, readMa2NetworkBridge } from './ma2-bridge-installer';
import { runMa2GuardedLua } from './ma2-lua-command';

vi.mock('./ma2-lua-command', () => ({ runMa2GuardedLua: vi.fn() }));
beforeEach(() => {
  vi.mocked(runMa2GuardedLua).mockReset().mockImplementation((_connection, body) => Promise.resolve(body.includes("return 'paused'") ? 'paused' : body.includes("return 'ready'") ? 'ready' : 'released'));
});

function connection(respond: (line: string) => string) {
  const commands: string[] = [];
  return { commands, command(line: string, match: (text: string) => string | null): Promise<string> {
    commands.push(line);
    const prefix = /TBLINK_BOOT_[a-f0-9]{32}:/.exec(line)?.[0] ?? `TBLINK_RPC_${/TBLINK_NET\('([a-f0-9]{32})'/.exec(line)?.[1]}:`;
    const result = match(`11h34m19.001s    LUA : ${prefix}${respond(line)}\n\r`);
    if (result === null) throw new Error('测试响应未匹配');
    return Promise.resolve(result);
  } };
}
it('已就绪的同版本桥只检查一次，不重载或新增计时器', async () => {
  const client = connection(() => 'ready');
  await ensureMa2NetworkBridge(client, 'return function() end');
  expect(client.commands).toHaveLength(1);
  expect(client.commands[0]).not.toMatch(/[$|^]/);
});
it('不覆盖没有应用所有权标记的其他插件', async () => {
  const client = connection(() => 'foreign');
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('联动台没有覆盖它');
  expect(client.commands).toHaveLength(1);
});
it('M5：只看不装：一条短命令说出控台上是什么，不装、不换、不停任何东西', async () => {
  for (const [reply, state] of [['ready', 'ready'], ['missing', 'missing'], [`replace:${'a'.repeat(64)}`, 'old'], ['foreign', 'foreign']] as const) {
    const client = connection(() => reply);
    await expect(readMa2NetworkBridge(client, 'return function() end')).resolves.toBe(state);
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]).not.toMatch(/TBLINK_BOOTSTRAP|TBLINK_NET\(|load\(/);
  }
  expect(runMa2GuardedLua).not.toHaveBeenCalled();
  await expect(readMa2NetworkBridge(connection(() => 'what'), 'return function() end')).rejects.toThrow('无法识别');
});
function upgradeClient(options: { busy?: boolean; corrupt?: boolean } = {}) {
  return connection(line => {
    if (line.includes("local r='missing'")) return `replace:${'a'.repeat(64)}`;
    if (line.includes("'begin'")) return options.busy ? `ERR:${Buffer.from('Another network request is pending').toString('hex')}` : 'ACK';
    if (line.includes("'run'")) return 'DONE:100';
    if (line.includes("'read'")) return 'DATA:00';
    if (line.includes("'release'")) return 'ACK';
    const hex = /local h='([a-f0-9]+)'/.exec(line)?.[1];
    if (hex) return options.corrupt ? '00' : hex;
    return 'ready';
  });
}
it('升级已拥有的旧桥前占用只读事务，校验源码后暂停旧会话再载入', async () => {
  const client = upgradeClient();
  await ensureMa2NetworkBridge(client, 'return function() end');
  expect(client.commands.some(line => line.includes("'begin'") && line.includes("'PING',1,0"))).toBe(true);
  const scripts = vi.mocked(runMa2GuardedLua).mock.calls.map(call => call[1]);
  expect(scripts).toHaveLength(2);
  expect(scripts[0]).toContain('TBLINK_EXEC_RELEASE_ALL()');
  expect(scripts[0]).toContain("TBLINK_BRIDGE_GENERATION='upgrade_");
  expect(scripts[0]!.indexOf('assert(load')).toBeLessThan(scripts[0]!.indexOf("TBLINK_BRIDGE_GENERATION='upgrade_"));
  expect(scripts[1]).toContain("pcall(start,'network')");
  expect([...client.commands, ...scripts].every(line => !/gma\.cmd|Import |Store |Delete |Go Executor/.test(line))).toBe(true);
});
it('已有事务未结束时不停止旧桥，不重放旧请求', async () => {
  const client = upgradeClient({ busy: true });
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('本地可以继续编辑');
  expect(vi.mocked(runMa2GuardedLua)).not.toHaveBeenCalled();
  expect(client.commands.filter(line => line.includes("'begin'"))).toHaveLength(1);
  expect(client.commands.some(line => line.includes('parts={}'))).toBe(false);
});
it('旧桥升级传输损坏时保留旧会话并释放自身的只读事务', async () => {
  const client = upgradeClient({ corrupt: true });
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('没有传完');
  const scripts = vi.mocked(runMa2GuardedLua).mock.calls.map(call => call[1]);
  expect(scripts.every(script => !script.includes('b.factory=assert'))).toBe(true);
  expect(client.commands.filter(line => line.includes("'release'"))).toHaveLength(1);
});
it('新组件启动失败时要求恢复旧桥所有应用入口再释放事务', async () => {
  const client = upgradeClient();
  vi.mocked(runMa2GuardedLua).mockResolvedValueOnce('paused').mockRejectedValueOnce(new Error('start failed')).mockResolvedValueOnce('released');
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('start failed');
  const cleanup = vi.mocked(runMa2GuardedLua).mock.calls[2]![1];
  expect(cleanup).toContain('TBLINK_NET=b.previous.net');
  expect(cleanup).toContain('TBLINK_BRIDGE_GENERATION=b.previous.generation');
  expect(client.commands.filter(line => line.includes("'release'"))).toHaveLength(1);
});
it('逐片回读校验完整字节后才执行内置代码', async () => {
  const source = '--中文测试\n' + ' '.repeat(300) + 'return function() end';
  const received: Buffer[] = [];
  const client = connection((line) => {
    if (line.includes("local r='missing'")) return 'missing';
    const hex = /local h='([a-f0-9]+)'/.exec(line)?.[1];
    if (hex) { received.push(Buffer.from(hex, 'hex')); return hex; }
    return 'ready';
  });
  await ensureMa2NetworkBridge(client, source);
  expect(Buffer.concat(received).toString('utf8')).toBe(source);
  expect(client.commands.at(-1)).toContain("pcall(start,'network')");
  expect(client.commands.every((line) => !line.includes('Import ') && !line.includes('Store '))).toBe(true);
});
it('传输损坏立即停止，不执行也不自动重传', async () => {
  const client = connection((line) => line.includes("local r='missing'") ? 'missing' : line.includes('local h=') ? '00' : 'ready');
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('没有传完');
  expect(client.commands.filter((line) => line.includes('local h='))).toHaveLength(1);
  expect(client.commands.some((line) => line.includes('local f=load'))).toBe(false);
});
