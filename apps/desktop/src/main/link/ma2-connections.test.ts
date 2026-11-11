import { mkdtemp, symlink, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { expect, it } from 'vitest';
import { Ma2Connections } from './ma2-connections';
import { showStopped } from './fixtures/show-gates';

it('真实目录、路径分隔符和目录别名并发请求复用同步服务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-ma2-connection-'));
  const alias = `${directory}-alias`;
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const registry = new Ma2Connections(showStopped, () => Promise.resolve());
    const paths = [directory, `${directory}${sep}`, join(directory, '.'), alias];
    if (process.platform === 'win32') paths.push(directory.replaceAll('\\', '/'), directory.toUpperCase());
    const connections = await Promise.all(paths.map((path) => registry.get(path)));
    for (const connection of connections) {
      expect(connection).toBe(connections[0]);
      expect(connection.service).toBe(connections[0]!.service);
      expect(connection.bridge).toBe(connections[0]!.bridge);
    }
    await expect(registry.get('relative')).rejects.toThrow('绝对路径');
    await expect(registry.get(join(directory, 'missing'))).rejects.toThrow();
  } finally {
    await unlink(alias);
    await rmdir(directory);
  }
});

it('只为主进程记录的本机 onPC 数据目录建立连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-ma2-unchosen-'));
  try {
    const registry = new Ma2Connections(showStopped, () => Promise.reject(new Error('本机 onPC 数据目录必须通过“选择”或“一键识别”设置')));
    await expect(registry.get(directory)).rejects.toThrow('一键识别');
  } finally { await rmdir(directory); }
});
