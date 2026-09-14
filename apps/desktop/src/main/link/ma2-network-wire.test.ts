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
