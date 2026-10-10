import { expect, it } from 'vitest';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';

const id = '1234567890abcdef1234567890abcdef';
function peer(options: { value?: string; wrongId?: boolean; truncate?: boolean; failRun?: boolean } = {}) {
  const actions: string[] = [];
  const received: Buffer[] = [];
  const value = options.value ?? '中文 Cue'.repeat(220);
  const response = Buffer.from(`${options.wrongId ? 'a'.repeat(32) : id}\nOK\n${Buffer.byteLength(value)}\n${value}`);
  return {
    actions, received,
    command: (line: string, match: (text: string) => string | null): Promise<string> => {
      if (line.startsWith('Lua "for i=')) {
        const batch = /for i=0,(\d+) do TBLINK_NET\('([a-f0-9]{28})'.*,'read','[a-f0-9]{32}',(\d+)\+i\*256/.exec(line);
        if (!batch) throw new Error('Malformed batch');
        actions.push('read-batch');
        const replies = Array.from({ length: Number(batch[1]) + 1 }, (_, i) => {
          const offset = Number(batch[3]) + i * 256;
          return `TBLINK_RPC_${batch[2]}${i.toString(16).padStart(4, '0')}:DATA:${response.subarray(offset, offset + (options.truncate ? 255 : 256)).toString('hex')}\r\n`;
        }).join('');
        const parsed = match(replies); if (parsed === null) throw new Error('Incomplete batch');
        return Promise.resolve(parsed);
      }
      const call = /TBLINK_NET\('([a-f0-9]{32})','([a-z]+)','([a-f0-9]{32})'(.*?)\)/.exec(line);
      if (!call) throw new Error('Malformed command');
      const action = call[2]!; const args = call[4]!; actions.push(action);
      let result = 'ACK';
      if (action === 'chunk') {
        const chunk = /^,(\d+),'([a-f0-9]+)'$/.exec(args);
        if (!chunk || Number(chunk[1]) !== received.length + 1) throw new Error('Invalid chunk order');
        received.push(Buffer.from(chunk[2]!, 'hex'));
      }
      if (action === 'run') { if (options.failRun) throw new Error('Disconnected after write'); result = `DONE:${response.length}`; }
      if (action === 'read') {
        const offset = Number(args.slice(1));
        result = `DATA:${response.subarray(offset, offset + (options.truncate ? 255 : 256)).toString('hex')}`;
      }
      const parsed = match(`${line}\r\nTBLINK_RPC_${call[1]}:${result}\r\n [Channel]>`);
      if (parsed === null) throw new Error('Reply matcher failed');
      return Promise.resolve(parsed);
    }
  };
}
it('网络分段交换保持 UTF-8 字节、顺序与请求身份', async () => {
  const server = peer(); const body = '中文\n\";Go Executor 1.1\n'.repeat(200);
  let writes = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, body, () => { writes += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(Buffer.concat(server.received).toString('utf8')).toBe(body);
  expect(server.actions.filter((action) => action === 'run')).toHaveLength(1);
  expect(server.actions.at(-1)).toBe('release'); expect(writes).toBe(1);
});
it('目标错位、片段截断以及写入后断线均失败且不重发', async () => {
  for (const options of [{ wrongId: true }, { truncate: true }, { failRun: true }]) {
    const server = peer(options);
    await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true });
    expect(server.actions.filter((action) => action === 'run')).toHaveLength(1);
  }
});
it('上传期间开始播放时不能提交控台写入', async () => {
  const server = peer();
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => { throw new Error('播放已开始'); })).rejects.toMatchObject({ sent: false });
  expect(server.actions).not.toContain('run');
});
it('网络传输沿用本机桥的对象验证与播放保护', async () => {
  let calls = 0;
  const bridge = new Ma2OnpcBridge({ exchange: () => { calls += 1; return Promise.resolve('<MA><Timecode index="4" /></MA>'); } }, () => false);
  await expect(bridge.request('READ', 6)).rejects.toThrow();
  await expect(bridge.request('APPLY', 6, 'invalid', 'invalid')).rejects.toThrow();
  expect(calls).toBe(1);
});

it('完整快照仅回读一次，写入复用同一目标和完全相同的原始快照', async () => {
  const server = peer({ value: '<MA>原始全量序列</MA>'.repeat(1000) });
  const wire = new Ma2NetworkWire(server);
  const expected = await wire.exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  expect(server.actions.filter(action => action === 'read-batch').length).toBeLessThan(10);
  const desired = '<MA>修改后的时间线</MA>';
  await wire.exchange(id, 'SYNC', 9901, `${Buffer.byteLength(expected)}\n${expected}${desired}`, () => undefined);
  expect(server.actions).toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(desired);
});

it.each(['target', 'content'] as const)('快照 %s 不一致时不使用控台缓存引用', async change => {
  const server = peer({ value: '<MA>完整原文</MA>' });
  const wire = new Ma2NetworkWire(server);
  const original = await wire.exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  const expected = change === 'content' ? original.replace('原文', '变动') : original;
  const body = `${Buffer.byteLength(expected)}\n${expected}<MA/>`;
  await wire.exchange(id, 'SYNC', change === 'target' ? 9902 : 9901, body, () => undefined);
  expect(server.actions).not.toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(body);
});

it('精简 Cue 快照仍使用控台原始快照引用，不能上传精简数据替代写前核对', async () => {
  const compact = '<MA><Timecode index="9906"/><Sequ index="8998"><Cue index="1"><Number number="1" sub_number="100"/><CuePart index="0" name="测试 Cue"/></Cue></Sequ></MA>';
  const server = peer({ value: compact });
  const wire = new Ma2NetworkWire(server);
  const received = await wire.exchange(id, 'SCOPE', 9907, '8999', () => undefined);
  server.received.length = 0;
  const desired = '<MA><Timecode index="9906"/></MA>';
  await wire.exchange(id, 'SYNC', 9907, `${Buffer.byteLength(received)}\n${received}${desired}`, () => undefined);
  expect(server.actions).toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(desired);
});
