import { expect, it, vi } from 'vitest';
import { runMa2GuardedLua } from './ma2-lua-command';

it.each([`return ('x'):match('^x$') ~= nil`, `return 'red|blue'`, `return ('x'):find('[^a-f]')`])('包含命令行特殊字符的短 Lua 也按字节传输：%s', async script => {
  const sent: string[] = [];
  const command = vi.fn((line: string) => {
    sent.push(line);
    return Promise.resolve(line.includes("READY") ? 'READY' : 'OK:true');
  });
  await expect(runMa2GuardedLua({ command }, script, () => undefined)).resolves.toBe('true');
  expect(sent.length).toBeGreaterThan(3);
  expect(sent.every(line => !/[$|^]/.test(line) && Buffer.byteLength(line) < 700)).toBe(true);
  const chunks = sent.flatMap(line => [...line.matchAll(/=unhex\('([a-f0-9]+)'\)/g)].map(match => Buffer.from(match[1]!, 'hex')));
  expect(Buffer.concat(chunks).toString()).toContain(script);
});
