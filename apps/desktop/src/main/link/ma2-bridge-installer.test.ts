import { expect, it } from 'vitest';
import { ensureMa2NetworkBridge } from './ma2-bridge-installer';

function connection(respond: (line: string) => string) {
  const commands: string[] = [];
  return { commands, command(line: string, match: (text: string) => string | null): Promise<string> {
    commands.push(line);
    const prefix = /TBLINK_BOOT_[a-f0-9]{32}:/.exec(line)?.[0];
    const result = match(`11h34m19.001s    LUA : ${prefix}${respond(line)}\n\r`);
    if (result === null) throw new Error('测试响应未匹配');
    return Promise.resolve(result);
  } };
}
it('已就绪的同版本桥只检查一次，不重载或新增计时器', async () => {
  const client = connection(() => 'ready');
  await ensureMa2NetworkBridge(client, 'return function() end');
  expect(client.commands).toHaveLength(1);
});
it('其他版本正在使用时拒绝替换', async () => {
  const client = connection(() => 'existing');
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('另一版');
  expect(client.commands).toHaveLength(1);
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
  await expect(ensureMa2NetworkBridge(client, 'return function() end')).rejects.toThrow('传输不完整');
  expect(client.commands.filter((line) => line.includes('local h='))).toHaveLength(1);
  expect(client.commands.some((line) => line.includes('local f=load'))).toBe(false);
});
