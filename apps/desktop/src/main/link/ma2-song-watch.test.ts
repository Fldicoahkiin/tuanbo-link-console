import { expect, it, vi } from 'vitest';
import { Ma2SongWatch } from './ma2-song-watch';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';

const request = { network: { host: '192.0.2.1', port: 30000, monitorPort: 30001, username: 'test' }, expectedSource: { show: 'Show', generation: 'session', version: '3.7.0.5' }, sequence: 9000, revision: '0'.repeat(64) };
function console(): { connection: Pick<Ma2Telnet, 'command'>; lines: string[] } {
  const lines: string[] = [];
  return { lines, connection: { command: vi.fn<Ma2Telnet['command']>((line, match) => {
    lines.push(line);
    const prefix = `${/TBLINK_CUE_[a-f0-9]{24}/.exec(line)?.[0]}:`;
    const response = match(`${prefix}${line.includes("READY')") ? 'READY' : 'OK:true'}\r\n`);
    return response === null ? Promise.reject(new Error('无响应')) : Promise.resolve(response);
  }) } };
}
it('已缓存歌曲的每次复查只发两条控台命令，不走分块传输', async () => {
  const { connection, lines } = console();
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(() => Promise.resolve('<MA><Sequ index="8999"/></MA>')) };
  const watch = new Ma2SongWatch(() => false);
  await watch.changed(connection, bridge, request);
  const before = lines.length;
  await watch.changed(connection, bridge, request);
  expect(lines.length - before).toBe(2);
  expect(lines.every(line => Buffer.byteLength(line) <= 900 && !/[$|^]/.test(line))).toBe(true);
});
it('带执行器的歌曲每次复查同样只发两条命令；两份复查导出比较后都删除', async () => {
  const { connection, lines } = console();
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(operation => Promise.resolve(operation === 'EXECUTOR'
    ? '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Exec offset_from_first="0"><Assignment name="歌曲"><No>25</No><No>1</No><No>9000</No></Assignment></Exec></MA>' : '<MA><Sequ index="8999"/></MA>')) };
  const watch = new Ma2SongWatch(() => false);
  const song = { ...request, expectedSource: { show: 'tblink_ui100_20261007', generation: '17611234567.123', version: '3.7.0.5' }, executor: '9890.101' };
  await watch.changed(connection, bridge, song);
  const before = lines.length;
  await watch.changed(connection, bridge, song);
  expect(lines.length - before).toBe(2);
  expect(lines.every(line => Buffer.byteLength(line) <= 900 && !/[$|^]/.test(line))).toBe(true);
  const compare = lines.at(-1)!;
  expect(compare.match(/_check(?:_exec)?',1\)/g)).toHaveLength(2);
});
it('同一首歌的复查基线用固定文件名，重新启动后覆盖而不是在控台上越积越多', async () => {
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(() => Promise.resolve('<MA><Sequ index="8999"/></MA>')) };
  const baseline = async (generation = 'session'): Promise<string[]> => {
    const { connection, lines } = console();
    await new Ma2SongWatch(() => false).changed(connection, bridge, { ...request, expectedSource: { ...request.expectedSource, generation } });
    return [...new Set(lines.flatMap(line => [...line.matchAll(/tblink_watch_[a-f0-9]+/g)].map(match => match[0])))];
  };
  const first = await baseline();
  expect(first).toHaveLength(1);
  expect(await baseline()).toEqual(first);
  expect(await baseline('plugin-restarted')).toEqual(first);
});
it('同步前查询复查缓存：控台未变且指纹等于本地基线时给出控台上的基线文件；没缓存、指纹不同或控台已变都返回 null', async () => {
  const xml = '<MA><Sequ index="8999"/></MA>';
  const { createHash } = await import('node:crypto');
  const { connection, lines } = console();
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(() => Promise.resolve(xml)) };
  const watch = new Ma2SongWatch(() => false);
  const position = { network: request.network, expectedSource: request.expectedSource, sequence: request.sequence };
  expect(await watch.unchangedBaseline(connection, position, xml)).toBeNull();
  expect(lines).toHaveLength(0);
  await watch.changed(connection, bridge, { ...request, revision: createHash('sha256').update(xml).digest('hex') });
  const before = lines.length;
  expect(await watch.unchangedBaseline(connection, position, xml)).toMatch(/^tblink_watch_[a-f0-9]{16}$/);
  expect(lines.length - before).toBe(2);
  expect(await watch.unchangedBaseline(connection, position, '<MA><Sequ index="8999" name="冲突后保留"/></MA>')).toBeNull();
  vi.mocked(connection.command).mockImplementation((line, match) => Promise.resolve(match(`${/TBLINK_CUE_[a-f0-9]{24}/.exec(line)?.[0]}:${line.includes("READY')") ? 'READY' : line.includes('==r(') ? 'OK:false' : 'OK:captured'}\r\n`)!));
  expect(await watch.unchangedBaseline(connection, position, xml)).toBeNull();
  expect(await watch.unchangedBaseline(connection, position, xml)).toBeNull();
});
it('同步后接管写后回读作复查基线：下一次复查只比对两条命令；文件名不合法拒绝，播放中不接管', async () => {
  const { connection, lines } = console();
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(() => Promise.reject(new Error('不应整读'))) };
  const song = { ...request, executor: '9890.101' };
  const exportFile = `tblink_library_${'e'.repeat(32)}`;
  const watch = new Ma2SongWatch(() => false);
  expect(await watch.adopt(connection, song, exportFile)).toBe(true);
  expect(lines.join('\n')).toMatch(/os\.rename\(p\.\.'tblink_library_e{32}\.xml',p\.\.'tblink_watch_[a-f0-9]{16}\.xml'\)/);
  expect(lines.join('\n')).toContain("Export Executor 9890.101 tblink_watch_");
  const before = lines.length;
  expect(await watch.changed(connection, bridge, song)).toBe(false);
  expect(lines.length - before).toBe(2);
  await expect(watch.adopt(connection, song, "x');os.remove('y")).rejects.toThrow('文件名无效');
  const playing = console();
  expect(await new Ma2SongWatch(() => true).adopt(playing.connection, song, exportFile)).toBe(false);
  expect(playing.lines).toHaveLength(0);
});
it('控台删掉本曲序列或执行器改放别的序列时报告“有变化”，交给完整同步重建，不再报错卡住', async () => {
  const lines: string[] = [];
  const missing: Pick<Ma2Telnet, 'command'> = { command: vi.fn<Ma2Telnet['command']>((line, match) => {
    lines.push(line);
    const prefix = `${/TBLINK_CUE_[a-f0-9]{24}/.exec(line)?.[0]}:`;
    return Promise.resolve(match(`${prefix}${line.includes("READY')") ? 'READY' : 'OK:missing'}\r\n`)!);
  }) };
  const bridge: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(() => Promise.reject(new Error('不应读取'))) };
  expect(await new Ma2SongWatch(() => false).changed(missing, bridge, request)).toBe(true);
  expect(bridge.request).not.toHaveBeenCalled();
  const { connection } = console();
  const moved: Pick<Ma2OnpcBridge, 'request'> = { request: vi.fn<Ma2OnpcBridge['request']>(operation => Promise.resolve(operation === 'EXECUTOR'
    ? '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Exec offset_from_first="0"><Assignment name="别的"><No>25</No><No>1</No><No>9001</No></Assignment></Exec></MA>' : '<MA><Sequ index="8999"/></MA>')) };
  expect(await new Ma2SongWatch(() => false).changed(connection, moved, { ...request, executor: '9890.101' })).toBe(true);
});
