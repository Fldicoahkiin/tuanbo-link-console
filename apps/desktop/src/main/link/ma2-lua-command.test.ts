import { expect, it, vi } from 'vitest';
import { runMa2GuardedLua } from './ma2-lua-command';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';

it.each([`return ('x'):match('^x$') ~= nil`, `return 'red|blue'`, `return ('x'):find('[^a-f]')`])('包含命令行特殊字符的短 Lua 在一条受限长度的指令内按字节传输：%s', async script => {
  const sent: string[] = [];
  const command = vi.fn((line: string) => {
    sent.push(line);
    return Promise.resolve(line.includes("READY") ? 'READY' : 'OK:true');
  });
  await expect(runMa2GuardedLua({ command }, script, () => undefined)).resolves.toBe('true');
  expect(sent).toHaveLength(1);
  expect(sent.every(line => !/[$|^]/.test(line) && Buffer.byteLength(line) < 700)).toBe(true);
  expect(Buffer.from(/unhex\('([a-f0-9]+)'\)/.exec(sent[0]!)![1]!, 'hex').toString()).toContain(script);
});

it('大段选曲数据按原字节接收，只在全部确认后执行一次', async () => {
  const desk = new Ma2LuaConsole(null);
  const text = '选曲_01 $| ' + '13acf082ab90edd0'.repeat(650);
  const body = `COUNTER=(COUNTER or 0)+1;return '${text}'`;
  expect(await runMa2GuardedLua(desk, body, () => undefined)).toBe(text);
  expect(desk.lua('return tostring(COUNTER)')[0]?.toString()).toBe('1');
  expect(desk.lines.every(line => Buffer.byteLength(line) < 700)).toBe(true);
  expect(desk.lines.length).toBeLessThan(Math.ceil(Buffer.byteLength(body) / 310));
});

it('跨多次接收后拼回完整中文脚本，缺少回执时不会执行', async () => {
  const body = `return '${'灯具$|'.repeat(330)}'`;
  const lines: string[] = [];
  await expect(runMa2GuardedLua({ command: line => {
    lines.push(line);
    return Promise.resolve(line.includes('READY') ? 'READY' : 'OK:done');
  } }, body, () => undefined)).resolves.toBe('done');
  expect(lines.every(line => Buffer.byteLength(line) < 700)).toBe(true);
  const payload = lines.slice(0, -1).map(line => /'([0-9a-f]+)'/.exec(line)![1]).join('');
  expect(Buffer.from(payload, 'hex').toString()).toContain(body);
  expect(lines.at(-1)).toContain('table.concat(');
  const command = vi.fn().mockResolvedValueOnce('READY').mockResolvedValueOnce('unknown');
  await expect(runMa2GuardedLua({ command }, body, () => undefined)).rejects.toThrow('控台没有确认收到操作');
  expect(command).toHaveBeenCalledTimes(2);
});
