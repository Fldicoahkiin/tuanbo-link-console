import { mkdtemp, symlink, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { expect, it } from 'vitest';
import { Ma2Connections } from './ma2-connections';

it('真实目录、路径分隔符和目录别名并发请求复用同步服务', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-ma2-connection-'));
  const alias = `${directory}-alias`;
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const registry = new Ma2Connections(() => false);
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
