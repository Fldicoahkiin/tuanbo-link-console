import { expect, it } from 'vitest';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2CommandQueue } from './ma2-command-queue';
import { showStopped } from './fixtures/show-gates';

const id = '1234567890abcdef1234567890abcdef';
function peer(options: { value?: string; wrongId?: boolean; truncate?: boolean; failRun?: boolean; steps?: number; stepNumbers?: number[] } = {}) {
  const actions: string[] = [];
  let step = 0;
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
      // A stepping plugin: 'run' with 'steps' does the first step, each 'step' one more.
      if ((action === 'run' && args === ",'steps'" || action === 'step') && options.steps) {
        step += 1;
        result = step < options.steps ? `STEP:${options.stepNumbers?.[step - 1] ?? step}` : `DONE:${response.length}`;
      }
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
  expect(server.actions.at(-1)).toBe('release');
});
it('取消在途分段读取后释放本次传输，不继续收取后续数据或重发', async () => {
  const controller = new AbortController();
  const server = peer({ value: 'x'.repeat(30000) });
  const command = async (...args: Parameters<typeof server.command>): Promise<string> => {
    const result = await server.command(...args);
    if (server.actions.at(-1) === 'read-batch') controller.abort(new Error('用户停止同步'));
    return result;
  };
  await expect(new Ma2NetworkWire({ command }).exchange(id, 'SEQUENCE', 9000, '', () => undefined, controller.signal)).rejects.toThrow('用户停止同步');
  expect(server.actions.filter(action => action === 'read-batch')).toHaveLength(1);
  expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
  expect(server.actions.at(-1)).toBe('release');
});
it('没有取得请求时不释放其他客户端正在进行的传输', async () => {
  const commands: string[] = [];
  const connection = { command: (line: string): Promise<string> => {
    commands.push(line);
    return Promise.reject(new Error('Another network request is pending'));
  } };
  await expect(new Ma2NetworkWire(connection).exchange(id, 'SEQUENCE', 1, '', () => undefined)).rejects.toMatchObject({ sent: false });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("'begin'");
});
it('清理失败保留原始错误和发送状态，不重试清理或写入', async () => {
  const server = peer({ failRun: true });
  let releases = 0;
  const connection = { command: (line: string, match: (text: string) => string | null): Promise<string> => {
    if (line.includes("'release'")) { releases++; return Promise.reject(new Error('连接已断开')); }
    return server.command(line, match);
  } };
  await expect(new Ma2NetworkWire(connection).exchange(id, 'SYNC', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true, message: 'Disconnected after write；传输清理未确认：连接已断开' });
  expect(releases).toBe(1);
  expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
});
it('网络传输沿用本机桥的对象验证与播放保护', async () => {
  let calls = 0;
  const bridge = new Ma2OnpcBridge({ exchange: () => { calls += 1; return Promise.resolve('<MA><Timecode index="4" /></MA>'); } }, showStopped);
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

it('插件分步：run 之后一条一条发 step 到 DONE，每步之前问一次 beforeStep，每步算一次进度', async () => {
  const server = peer({ steps: 4 });
  let asked = 0; let progressed = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined, undefined, () => { progressed += 1; }, () => { asked += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(server.actions).toEqual(['begin', 'run', 'step', 'step', 'step', 'read-batch', 'release']);
  expect(asked).toBe(4);
  expect(progressed).toBeGreaterThanOrEqual(3);
});
it('分步以前的插件：run 直接回 DONE，照常走完，beforeStep 只问一次', async () => {
  const server = peer();
  let asked = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined, undefined, undefined, () => { asked += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(server.actions).toEqual(['begin', 'run', 'read-batch', 'release']);
  expect(asked).toBe(1);
});
it('beforeStep 叫停：下一步不发，释放这次事务，算已发出，不重发', async () => {
  const server = peer({ steps: 3 });
  let asked = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => undefined, undefined, undefined, () => { asked += 1; if (asked === 2) throw new Error('时间码开始走了'); })).rejects.toMatchObject({ sent: true, message: '时间码开始走了' });
  expect(server.actions).toEqual(['begin', 'chunk', 'run', 'release']);
});
it('第一步之前叫停：什么都没执行，算没发出', async () => {
  const server = peer({ steps: 3 });
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => undefined, undefined, undefined, () => { throw new Error('时间码开始走了'); })).rejects.toMatchObject({ sent: false });
  expect(server.actions).toEqual(['begin', 'chunk', 'release']);
});
it('插件报的步数对不上就停下释放，不接着发', async () => {
  const server = peer({ steps: 4, stepNumbers: [1, 3] });
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true, message: '控台分步执行的回答对不上' });
  expect(server.actions).toEqual(['begin', 'run', 'step', 'release']);
});
it('步与步之间排着的关灯先发，再发下一步', async () => {
  const queue = new Ma2CommandQueue();
  const order: string[] = [];
  const server = peer({ steps: 3 });
  const connection = { command: (line: string, match: (text: string) => string | null): Promise<string> => queue.schedule(async () => {
    const result = await server.command(line, match);
    const action = server.actions.at(-1)!;
    order.push(action);
    // Lights-off arrives while the first step is on the console.
    if (action === 'run') void queue.schedule(() => { order.push('off'); return Promise.resolve(''); }, 'stop');
    return result;
  }, 'normal') };
  await new Ma2NetworkWire(connection).exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  expect(order).toEqual(['begin', 'run', 'off', 'step', 'step', 'read-batch', 'release']);
});
