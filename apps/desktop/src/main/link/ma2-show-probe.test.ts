import { expect, it, vi } from 'vitest';
import { parseMa2ShowSource, readMa2ShowSource, verifyMa2ShowSource } from './ma2-show-probe';

const hex = (value: string): string => `H${Buffer.from(value).toString('hex')}`;
const consoleLine = (show: string, generation: string, version: string) => ({ command: vi.fn<(line: string, match: (text: string) => string | null, beforeSend?: unknown, priority?: string) => Promise<string>>((line, match) => {
  const marker = /TBLINK_SHOWCHECK_[a-f0-9]{32}/.exec(line)?.[0];
  const reply = match(`${marker}:${hex(show)},${hex(generation)},${hex(version)}\r\n`);
  return reply === null ? Promise.reject(new Error('No response')) : Promise.resolve(reply);
}) });

it('一条短命令读回 Show、插件会话和版本，中文 Show 名不走样', async () => {
  const line = consoleLine('12号直播间', '1234.5', '3.3.4.3');
  await expect(readMa2ShowSource(line)).resolves.toEqual({ show: '12号直播间', generation: '1234.5', version: '3.3.4.3' });
  const [command, , , priority] = line.command.mock.calls[0]!;
  // The native command line consumes $, | and ^; a second double quote would end the Lua string.
  expect(command.slice(5, -1)).not.toMatch(/["$|^]/);
  expect(priority).toBe('playback');
});

it('回答看不懂就报错，不当成 Show 没变', () => {
  expect(() => parseMa2ShowSource('H41,H42')).toThrow('无法识别');
  expect(() => parseMa2ShowSource('test|one|3.3')).toThrow('无法识别');
  expect(parseMa2ShowSource('H,H,H')).toEqual({ show: '', generation: '', version: '' });
});

it('Show、插件会话或版本变了就停，插件没在运行时说明', async () => {
  const expected = { show: 'test', generation: 'one', version: '3.3.4.3' };
  await expect(verifyMa2ShowSource(consoleLine('test', 'one', '3.3.4.3'), expected)).resolves.toBeUndefined();
  await expect(verifyMa2ShowSource(consoleLine('other', 'one', '3.3.4.3'), expected)).rejects.toThrow('Show 或连接变了');
  await expect(verifyMa2ShowSource(consoleLine('test', 'two', '3.3.4.3'), expected)).rejects.toThrow('Show 或连接变了');
  await expect(verifyMa2ShowSource(consoleLine('test', '', '3.3.4.3'), expected)).rejects.toThrow('插件没在运行');
});
