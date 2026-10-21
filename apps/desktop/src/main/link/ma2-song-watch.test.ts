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
